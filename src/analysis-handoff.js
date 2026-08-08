import { validateCreativeRevisionDraft } from "./creative-revision.js";
import { analysisReferenceId } from "./revision-id.js";

export const ANALYSIS_HANDOFF_SCHEMA_VERSION = 1;
export const ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION = 2;
export const ANALYSIS_HANDOFF_KIND = "qianchuan-analysis-handoff";
export const ANALYSIS_HANDOFF_SOURCE = "local-material-analysis-workbench";
export const ANALYSIS_HANDOFF_METHOD = "local_deterministic_rules";
export const MAX_ANALYSIS_HANDOFF_BYTES = 128 * 1024;
export const ANALYSIS_HANDOFF_SUGGESTION_FIELDS = Object.freeze([
  "targetAudience",
  "audienceProblems",
  "coreClaim",
  "evidence"
]);

const ANALYSIS_KIND = "qianchuan-rule-based-copy-structure-v1";
const MAX_SUGGESTION_CHARACTERS = 800;
const MAX_ADVICE_CHARACTERS = 400;
const STRUCTURES = Object.freeze([
  { id: "hook", label: "开场钩子" },
  { id: "audience", label: "目标受众" },
  { id: "pain", label: "痛点问题" },
  { id: "selling_point", label: "核心主张" },
  { id: "evidence", label: "信任证据" },
  { id: "scene", label: "使用场景" },
  { id: "cta", label: "行动引导" }
]);
const STRUCTURE_IDS = new Set(STRUCTURES.map((item) => item.id));
const FIELD_TAGS = Object.freeze({
  targetAudience: "audience",
  audienceProblems: "pain",
  coreClaim: "selling_point",
  evidence: "evidence"
});
const NOTICE = "仅供编导人工复核；内容来自本地确定性规则，不是投放效果预测。导入后只会在用户确认时填入空白字段。";
const MACHINE_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|file:\/\/|\/(?:Users|home|var\/folders)\/)/iu;
const ACTIVE_CONTENT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|img)\b|javascript\s*:|\bon[a-z]+\s*=)/iu;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label}格式无效`);
  return value;
}

function assertKnownKeys(value, allowedKeys, label) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) throw new Error(`${label}包含不受支持字段：${unknown.join("、")}`);
}

function safeText(value, label, { maxLength, allowEmpty = true } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (!allowEmpty && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}超过 ${maxLength} 字符上限`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error(`${label}包含不允许的控制字符`);
  if (MACHINE_PATH_PATTERN.test(text)) throw new Error(`${label}不能包含本机路径`);
  if (ACTIVE_CONTENT_PATTERN.test(text)) throw new Error(`${label}包含不安全的活动内容`);
  return text;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}数值无效`);
  return value;
}

function safeCreatedAt(value) {
  if (typeof value !== "string" || value.length > 40) throw new Error("交接时间格式无效");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error("交接时间格式无效");
  return value;
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stableHash(value) {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function handoffIdFor(payload) {
  return `handoff-${stableHash(payload)}`;
}

function normalizeSummary(rawSummary) {
  const summary = assertPlainObject(rawSummary, "分析摘要");
  assertKnownKeys(summary, ["characters", "segments", "coveredStructures", "totalStructures", "structureCoveragePercent"], "分析摘要");
  const normalized = {
    characters: safeInteger(summary.characters, "字符数", { max: 200_000 }),
    segments: safeInteger(summary.segments, "分段数", { max: 600 }),
    coveredStructures: safeInteger(summary.coveredStructures, "已覆盖结构数", { max: STRUCTURES.length }),
    totalStructures: safeInteger(summary.totalStructures, "结构总数", { min: STRUCTURES.length, max: STRUCTURES.length }),
    structureCoveragePercent: safeInteger(summary.structureCoveragePercent, "结构覆盖率", { max: 100 })
  };
  return normalized;
}

function normalizeCoverage(rawCoverage) {
  if (!Array.isArray(rawCoverage) || rawCoverage.length !== STRUCTURES.length) throw new Error("结构覆盖必须包含固定的七类结构");
  const byId = new Map();
  for (const rawItem of rawCoverage) {
    const item = assertPlainObject(rawItem, "结构覆盖项");
    assertKnownKeys(item, ["id", "label", "present", "count"], "结构覆盖项");
    if (!STRUCTURE_IDS.has(item.id) || byId.has(item.id)) throw new Error("结构覆盖项标识无效或重复");
    if (typeof item.present !== "boolean") throw new Error("结构覆盖状态无效");
    const expectedLabel = STRUCTURES.find((definition) => definition.id === item.id).label;
    if (item.label !== expectedLabel) throw new Error("结构覆盖标签与固定结构不一致");
    const count = safeInteger(item.count, "结构命中数", { max: 600 });
    if (item.present !== (count > 0)) throw new Error("结构覆盖状态与命中数不一致");
    byId.set(item.id, { id: item.id, label: expectedLabel, present: item.present, count });
  }
  return STRUCTURES.map((definition) => byId.get(definition.id));
}

function normalizeSuggestions(rawSuggestions) {
  const suggestions = assertPlainObject(rawSuggestions, "创作任务建议");
  assertKnownKeys(suggestions, ANALYSIS_HANDOFF_SUGGESTION_FIELDS, "创作任务建议");
  return Object.fromEntries(ANALYSIS_HANDOFF_SUGGESTION_FIELDS.map((field) => [
    field,
    safeText(suggestions[field], `建议字段 ${field}`, { maxLength: MAX_SUGGESTION_CHARACTERS })
  ]));
}

function normalizeRecommendations(rawRecommendations) {
  if (!Array.isArray(rawRecommendations) || rawRecommendations.length > STRUCTURES.length) throw new Error("补充建议格式无效");
  const seen = new Set();
  return rawRecommendations.map((rawItem) => {
    const item = assertPlainObject(rawItem, "补充建议");
    assertKnownKeys(item, ["id", "label", "advice"], "补充建议");
    if (!STRUCTURE_IDS.has(item.id) || seen.has(item.id)) throw new Error("补充建议标识无效或重复");
    seen.add(item.id);
    const expectedLabel = STRUCTURES.find((definition) => definition.id === item.id).label;
    if (item.label !== expectedLabel) throw new Error("补充建议标签与固定结构不一致");
    return {
      id: item.id,
      label: expectedLabel,
      advice: safeText(item.advice, `补充建议 ${item.id}`, { maxLength: MAX_ADVICE_CHARACTERS, allowEmpty: false })
    };
  });
}

function normalizePayload(raw) {
  const document = assertPlainObject(raw, "分析交接包");
  if (![ANALYSIS_HANDOFF_SCHEMA_VERSION, ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION].includes(document.schemaVersion)) {
    throw new Error("分析交接包版本不受支持");
  }
  const isRevisionHandoff = document.schemaVersion === ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION;
  const allowedKeys = ["schemaVersion", "kind", "source", "createdAt", "summary", "coverage", "suggestions", "recommendations", "notice", "handoffId"];
  if (isRevisionHandoff) allowedKeys.push("revisionDraft");
  assertKnownKeys(document, allowedKeys, "分析交接包");
  if (document.kind !== ANALYSIS_HANDOFF_KIND) throw new Error("这不是受支持的分析交接包");
  const source = assertPlainObject(document.source, "分析来源");
  assertKnownKeys(source, ["tool", "method"], "分析来源");
  if (source.tool !== ANALYSIS_HANDOFF_SOURCE || source.method !== ANALYSIS_HANDOFF_METHOD) throw new Error("分析交接包来源不受支持");
  if (document.notice !== NOTICE) throw new Error("分析交接包边界声明不完整");
  const summary = normalizeSummary(document.summary);
  const coverage = normalizeCoverage(document.coverage);
  const coveredStructures = coverage.filter((item) => item.present).length;
  const expectedPercent = Math.round((coveredStructures / STRUCTURES.length) * 100);
  if (summary.coveredStructures !== coveredStructures || summary.structureCoveragePercent !== expectedPercent) {
    throw new Error("分析摘要与结构覆盖不一致");
  }
  const payload = {
    schemaVersion: document.schemaVersion,
    kind: ANALYSIS_HANDOFF_KIND,
    source: { tool: ANALYSIS_HANDOFF_SOURCE, method: ANALYSIS_HANDOFF_METHOD },
    createdAt: safeCreatedAt(document.createdAt),
    summary,
    coverage,
    suggestions: normalizeSuggestions(document.suggestions),
    recommendations: normalizeRecommendations(document.recommendations),
    notice: NOTICE
  };
  if (isRevisionHandoff) payload.revisionDraft = validateCreativeRevisionDraft(document.revisionDraft);
  return payload;
}

function textForTag(analysis, tagId) {
  const unique = [];
  for (const segment of analysis.segments) {
    if (!Array.isArray(segment?.tags) || !segment.tags.includes(tagId)) continue;
    const text = safeText(segment.content, `结构片段 ${tagId}`, { maxLength: MAX_SUGGESTION_CHARACTERS, allowEmpty: false });
    if (!unique.includes(text)) unique.push(text);
    if (unique.length === 2) break;
  }
  return unique.join("\n").slice(0, MAX_SUGGESTION_CHARACTERS).trim();
}

export function createAnalysisHandoff(analysis, options = {}) {
  const source = assertPlainObject(analysis, "结构分析结果");
  if (source.schemaVersion !== 1 || source.kind !== ANALYSIS_KIND || source.method !== ANALYSIS_HANDOFF_METHOD) {
    throw new Error("请先生成受支持的本地确定性结构分析");
  }
  if (!Array.isArray(source.segments) || source.segments.length > 600) throw new Error("结构分析分段格式无效");
  const summary = normalizeSummary(source.summary);
  const coverage = STRUCTURES.map((definition) => {
    const rawItem = source.coverage?.[definition.id];
    const count = safeInteger(rawItem?.count, `${definition.label}命中数`, { max: 600 });
    return { id: definition.id, label: definition.label, present: count > 0, count };
  });
  const coveredStructures = coverage.filter((item) => item.present).length;
  summary.coveredStructures = coveredStructures;
  summary.totalStructures = STRUCTURES.length;
  summary.structureCoveragePercent = Math.round((coveredStructures / STRUCTURES.length) * 100);
  const suggestions = Object.fromEntries(ANALYSIS_HANDOFF_SUGGESTION_FIELDS.map((field) => [field, textForTag(source, FIELD_TAGS[field])]));
  const recommendations = (Array.isArray(source.recommendations) ? source.recommendations : [])
    .filter((item) => STRUCTURE_IDS.has(item?.id))
    .map((item) => {
      const definition = STRUCTURES.find((candidate) => candidate.id === item.id);
      return {
        id: definition.id,
        label: definition.label,
        advice: safeText(item.advice, `补充建议 ${item.id}`, { maxLength: MAX_ADVICE_CHARACTERS, allowEmpty: false })
      };
    });
  const revisionDraft = options.revisionDraft === undefined || options.revisionDraft === null
    ? null
    : validateCreativeRevisionDraft(options.revisionDraft);
  if (revisionDraft && revisionDraft.sourceAnalysisId !== analysisReferenceId(source)) {
    throw new Error("可拍任务草稿与当前结构分析不一致，请重新生成草稿");
  }
  const payload = {
    schemaVersion: revisionDraft ? ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION : ANALYSIS_HANDOFF_SCHEMA_VERSION,
    kind: ANALYSIS_HANDOFF_KIND,
    source: { tool: ANALYSIS_HANDOFF_SOURCE, method: ANALYSIS_HANDOFF_METHOD },
    createdAt: safeCreatedAt(options.createdAt || new Date().toISOString()),
    summary,
    coverage,
    suggestions,
    recommendations,
    notice: NOTICE
  };
  if (revisionDraft) payload.revisionDraft = revisionDraft;
  const handoff = { ...payload, handoffId: handoffIdFor(payload) };
  if (serializedBytes(handoff) > MAX_ANALYSIS_HANDOFF_BYTES) throw new Error("分析交接包超过 128 KB 上限");
  return handoff;
}

export function validateAnalysisHandoff(raw) {
  if (serializedBytes(raw) > MAX_ANALYSIS_HANDOFF_BYTES) throw new Error("分析交接包超过 128 KB 上限");
  const payload = normalizePayload(raw);
  if (typeof raw.handoffId !== "string" || raw.handoffId !== handoffIdFor(payload)) throw new Error("分析交接包校验标识无效");
  return { ...payload, handoffId: raw.handoffId };
}

export function validateAnalysisHandoffFile(file) {
  const metadata = assertPlainObject(file, "分析交接文件");
  const name = safeText(metadata.name, "文件名", { maxLength: 260, allowEmpty: false });
  const size = safeInteger(metadata.size, "文件大小", { min: 1, max: MAX_ANALYSIS_HANDOFF_BYTES });
  const type = typeof metadata.type === "string" ? metadata.type.toLowerCase().split(";", 1)[0].trim() : "";
  if (!name.toLowerCase().endsWith(".json")) throw new Error("分析交接包只支持 .json 文件");
  if (type && !["application/json", "text/json", "text/plain"].includes(type)) throw new Error("分析交接包文件类型不受支持");
  return { name, size, type };
}

export function isDuplicateAnalysisHandoff(handoff, previousHandoffId = "") {
  if (!handoff?.handoffId) return false;
  if (previousHandoffId instanceof Set) return previousHandoffId.has(handoff.handoffId);
  if (Array.isArray(previousHandoffId)) return previousHandoffId.includes(handoff.handoffId);
  return Boolean(previousHandoffId && handoff.handoffId === previousHandoffId);
}

export function analysisHandoffFillCandidates(handoff, currentTask = {}) {
  const validated = validateAnalysisHandoff(handoff);
  return ANALYSIS_HANDOFF_SUGGESTION_FIELDS.map((field) => ({
    field,
    value: validated.suggestions[field],
    canFill: Boolean(validated.suggestions[field]) && !String(currentTask?.[field] ?? "").trim()
  }));
}
