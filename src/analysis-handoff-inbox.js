import {
  ANALYSIS_HANDOFF_SOURCE,
  MAX_ANALYSIS_HANDOFF_BYTES,
  createAnalysisHandoff,
  validateAnalysisHandoff
} from "./analysis-handoff.js";

export const ANALYSIS_HANDOFF_INBOX_KEY = "analysisHandoffInboxV1";
export const ANALYSIS_HANDOFF_INBOX_KIND = "qianchuan-analysis-handoff-session-envelope";
export const ANALYSIS_HANDOFF_INBOX_SCHEMA_VERSION = 1;
export const ANALYSIS_HANDOFF_INBOX_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_ANALYSIS_HANDOFF_ENVELOPE_BYTES = MAX_ANALYSIS_HANDOFF_BYTES + 4096;

export function analysisHandoffForAnalysis(cache, analysis, options = {}) {
  if (cache?.analysis === analysis) return { analysis, handoff: validateAnalysisHandoff(cache.handoff) };
  return { analysis, handoff: createAnalysisHandoff(analysis, options) };
}

function inboxError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw inboxError("invalid", "会话交接数据无法序列化");
  }
}

function exactIso(value, label) {
  if (typeof value !== "string" || value.length > 40) throw inboxError("invalid", `${label}格式无效`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw inboxError("invalid", `${label}格式无效`);
  return time;
}

function assertKnownKeys(value, keys) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw inboxError("invalid", `会话交接包含不受支持字段：${unknown.join("、")}`);
}

export function createAnalysisHandoffEnvelope(handoff, options = {}) {
  const validated = validateAnalysisHandoff(handoff);
  const queuedAt = options.queuedAt || new Date().toISOString();
  const queuedAtMs = exactIso(queuedAt, "入队时间");
  const envelope = {
    schemaVersion: ANALYSIS_HANDOFF_INBOX_SCHEMA_VERSION,
    kind: ANALYSIS_HANDOFF_INBOX_KIND,
    source: ANALYSIS_HANDOFF_SOURCE,
    queuedAt,
    expiresAt: new Date(queuedAtMs + ANALYSIS_HANDOFF_INBOX_TTL_MS).toISOString(),
    handoff: validated
  };
  return validateAnalysisHandoffEnvelope(envelope, { now: queuedAtMs });
}

export function validateAnalysisHandoffEnvelope(raw, options = {}) {
  if (serializedBytes(raw) > MAX_ANALYSIS_HANDOFF_ENVELOPE_BYTES) throw inboxError("invalid", "会话交接超过大小上限");
  if (!isPlainObject(raw)) throw inboxError("invalid", "会话交接格式无效");
  assertKnownKeys(raw, ["schemaVersion", "kind", "source", "queuedAt", "expiresAt", "handoff"]);
  if (raw.schemaVersion !== ANALYSIS_HANDOFF_INBOX_SCHEMA_VERSION) throw inboxError("invalid", "会话交接版本不受支持");
  if (raw.kind !== ANALYSIS_HANDOFF_INBOX_KIND || raw.source !== ANALYSIS_HANDOFF_SOURCE) throw inboxError("invalid", "会话交接来源不受支持");
  const queuedAtMs = exactIso(raw.queuedAt, "入队时间");
  const expiresAtMs = exactIso(raw.expiresAt, "过期时间");
  if (expiresAtMs - queuedAtMs !== ANALYSIS_HANDOFF_INBOX_TTL_MS) throw inboxError("invalid", "会话交接有效期无效");
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (queuedAtMs > now + 5 * 60 * 1000) throw inboxError("invalid", "会话交接时间晚于当前时间");
  if (now >= expiresAtMs) throw inboxError("expired", "工作台交接结果已过期，请重新发送");
  let handoff;
  try {
    handoff = validateAnalysisHandoff(raw.handoff);
  } catch (error) {
    throw inboxError("invalid", error.message || "分析交接包校验失败");
  }
  if (Date.parse(handoff.createdAt) > queuedAtMs + 5 * 60 * 1000) throw inboxError("invalid", "分析交接时间与会话入队时间不一致");
  return {
    schemaVersion: ANALYSIS_HANDOFF_INBOX_SCHEMA_VERSION,
    kind: ANALYSIS_HANDOFF_INBOX_KIND,
    source: ANALYSIS_HANDOFF_SOURCE,
    queuedAt: raw.queuedAt,
    expiresAt: raw.expiresAt,
    handoff
  };
}

export function inspectAnalysisHandoffInbox(raw, options = {}) {
  if (raw === undefined || raw === null) return { status: "empty", envelope: null };
  try {
    return { status: "ready", envelope: validateAnalysisHandoffEnvelope(raw, options) };
  } catch (error) {
    return { status: error.code === "expired" ? "expired" : "invalid", envelope: null, error };
  }
}

export function resolveAnalysisHandoffInbox(existingRaw, incomingEnvelope, options = {}) {
  const incoming = validateAnalysisHandoffEnvelope(incomingEnvelope, options);
  const existing = inspectAnalysisHandoffInbox(existingRaw, options);
  if (existing.status === "empty") return { status: "queued", envelope: incoming };
  if (existing.status === "invalid") return { status: "replaced-invalid", envelope: incoming };
  if (existing.status === "expired") return { status: "replaced-expired", envelope: incoming };
  if (existing.envelope.handoff.handoffId === incoming.handoff.handoffId) {
    return { status: "duplicate", envelope: existing.envelope };
  }
  return { status: "conflict", envelope: existing.envelope };
}

export function decideAnalysisHandoffPreview(currentPreview, incomingEnvelope, options = {}) {
  const incoming = validateAnalysisHandoffEnvelope(incomingEnvelope, options);
  if (!currentPreview?.handoffId) return "show";
  if (currentPreview.handoffId === incoming.handoff.handoffId) return "same";
  return "pending";
}

export async function enqueueAnalysisHandoff(storageArea, handoff, options = {}) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw inboxError("unavailable", "浏览器会话存储不可用，请改用 JSON 交接包");
  }
  const envelope = createAnalysisHandoffEnvelope(handoff, { queuedAt: options.queuedAt });
  let stored;
  try {
    stored = await storageArea.get(ANALYSIS_HANDOFF_INBOX_KEY);
  } catch {
    throw inboxError("unavailable", "无法读取浏览器会话收件箱，请改用 JSON 交接包");
  }
  const decision = resolveAnalysisHandoffInbox(stored?.[ANALYSIS_HANDOFF_INBOX_KEY], envelope, { now: options.now });
  if (["duplicate", "conflict"].includes(decision.status)) return decision;
  try {
    await storageArea.set({ [ANALYSIS_HANDOFF_INBOX_KEY]: decision.envelope });
    const verified = await storageArea.get(ANALYSIS_HANDOFF_INBOX_KEY);
    const result = validateAnalysisHandoffEnvelope(verified?.[ANALYSIS_HANDOFF_INBOX_KEY], { now: options.now });
    if (result.handoff.handoffId !== decision.envelope.handoff.handoffId) throw inboxError("conflict", "会话收件箱同时收到另一份结果，未确认覆盖");
    return { ...decision, envelope: result };
  } catch (error) {
    if (error?.code) throw error;
    throw inboxError("unavailable", "无法写入浏览器会话收件箱，请改用 JSON 交接包");
  }
}

export async function openAnalysisHandoffSidePanel(sidePanelApi, windowsApi) {
  if (!sidePanelApi || typeof sidePanelApi.open !== "function") {
    return { opened: false, reason: "当前 Chrome 版本不支持由页面直接打开侧边栏，请点击扩展图标查看待确认结果" };
  }
  const windowId = Number.isInteger(windowsApi?.WINDOW_ID_CURRENT) ? windowsApi.WINDOW_ID_CURRENT : -2;
  try {
    await sidePanelApi.open({ windowId });
    return { opened: true, reason: "" };
  } catch {
    return { opened: false, reason: "结果已排队，但浏览器未允许自动打开侧边栏；请点击扩展图标继续" };
  }
}
