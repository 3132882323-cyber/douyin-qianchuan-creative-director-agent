import { creativePlanDependencyFingerprint } from "./core.js";

export const TAKE_REVIEW_LIMITS = Object.freeze({
  maxPerVersion: 20,
  maxPerProject: 1000,
  capacityWarningAt: 800,
  maxRecordBytes: 4096,
  maxMaterialCodeLength: 256,
  maxTakeNumberLength: 80,
  maxTimecodeLength: 80,
  maxCorrectionLength: 500
});

export const TAKE_REVIEW_CHECKS = Object.freeze([
  Object.freeze({ code: "silent_first_frame", label: "静音首帧" }),
  Object.freeze({ code: "audible_hook", label: "有声钩子" }),
  Object.freeze({ code: "proof_continuity", label: "证据连续" }),
  Object.freeze({ code: "fixed_continuity", label: "固定项连续" }),
  Object.freeze({ code: "audio_handles", label: "声音与剪辑余量" })
]);

export const TAKE_REVIEW_OUTCOMES = Object.freeze([
  Object.freeze({ code: "keep", label: "保留本 Take" }),
  Object.freeze({ code: "reshoot", label: "立即重拍" }),
  Object.freeze({ code: "hold", label: "停机核实" })
]);

export const TAKE_REVIEW_HANDOFF_ROLES = Object.freeze([
  Object.freeze({ code: "none", label: "暂不指定" }),
  Object.freeze({ code: "primary", label: "首选 Take" }),
  Object.freeze({ code: "backup", label: "备选 Take" })
]);

export const TAKE_REVIEW_OWNER_ROLES = Object.freeze([
  Object.freeze({ code: "none", label: "暂不指定" }),
  Object.freeze({ code: "director", label: "编导" }),
  Object.freeze({ code: "camera", label: "摄影" }),
  Object.freeze({ code: "talent", label: "出镜 / 口播" }),
  Object.freeze({ code: "sound", label: "收音" }),
  Object.freeze({ code: "producer", label: "制片 / 场务" }),
  Object.freeze({ code: "compliance", label: "事实与授权核实" }),
  Object.freeze({ code: "editor", label: "剪辑" })
]);

const RECORD_SCHEMA_VERSION = 1;
const ID_PATTERN = /^take_[a-z0-9-]{8,80}$/iu;
const PROJECT_ID_PATTERN = /^prj_[a-z0-9-]{8,64}$/iu;
const TEST_ID_PATTERN = /^[a-z0-9._:-]{1,128}$/iu;
const FINGERPRINT_PATTERN = /^take-(?:plan|version|review):[0-9a-f]{8}$/u;
const CHECK_CODES = new Set(TAKE_REVIEW_CHECKS.map((entry) => entry.code));
const OUTCOME_CODES = new Set(TAKE_REVIEW_OUTCOMES.map((entry) => entry.code));
const HANDOFF_CODES = new Set(TAKE_REVIEW_HANDOFF_ROLES.map((entry) => entry.code));
const OWNER_CODES = new Set(TAKE_REVIEW_OWNER_ROLES.map((entry) => entry.code));

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function cleanText(value, label, maximum, { required = false } = {}) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (required && !result) throw new Error(`${label}不能为空`);
  if (result.length > maximum) throw new Error(`${label}最多 ${maximum} 个字符`);
  return result;
}

function materialLabel(value) {
  const result = cleanText(value, "素材编号", TAKE_REVIEW_LIMITS.maxMaterialCodeLength, { required: true });
  if (/^(?:[a-z]:[\\/]|\\\\|\/)|\bfile:\/\//iu.test(result)) throw new Error("请只填写素材编号或文件标签，不要粘贴本机路径");
  return result;
}

function identifier(value, pattern, label) {
  const result = String(value || "").trim();
  if (!pattern.test(result)) throw new Error(`${label}格式无效`);
  return result;
}

function exactIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间格式无效`);
  return candidate;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(prefix, value) {
  const source = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}:${hash.toString(16).padStart(8, "0")}`;
}

function safeFingerprint(value, label) {
  const result = String(value || "");
  if (!FINGERPRINT_PATTERN.test(result)) throw new Error(`${label}指纹无效`);
  return result;
}

function safeChoice(value, choices, label) {
  const result = String(value || "");
  if (!choices.has(result)) throw new Error(`${label}无效`);
  return result;
}

function safeChecks(value) {
  if (!Array.isArray(value) || value.length !== TAKE_REVIEW_CHECKS.length) throw new Error("必须逐项完成人工五项快检");
  const seen = new Set();
  const checks = value.map((candidate) => {
    const source = record(candidate, "人工快检项");
    const code = String(source.code || "");
    if (!CHECK_CODES.has(code) || seen.has(code)) throw new Error("人工快检项缺失、重复或无效");
    seen.add(code);
    const status = String(source.status || "");
    if (status !== "pass" && status !== "issue") throw new Error("每项快检都必须人工选择通过或有问题");
    return { code, status };
  });
  if (TAKE_REVIEW_CHECKS.some((definition, index) => checks[index]?.code !== definition.code)) throw new Error("人工快检项顺序无效");
  return checks;
}

function safeSource(value) {
  const source = record(value, "过条来源");
  return {
    batchId: identifier(source.batchId, TEST_ID_PATTERN, "测试批次"),
    testId: identifier(source.testId, TEST_ID_PATTERN, "测试编号"),
    type: cleanText(source.type, "版本类型", 80, { required: true }),
    orderLabel: cleanText(source.orderLabel, "拍摄顺序", 80, { required: true }),
    singleVariable: cleanText(source.singleVariable, "唯一变量", 160, { required: true }),
    variant: cleanText(source.variant, "变量值", 1000, { required: true }),
    fixedElements: cleanText(source.fixedElements, "固定项", 1600, { required: true }),
    planFingerprint: safeFingerprint(source.planFingerprint, "方案"),
    versionFingerprint: safeFingerprint(source.versionFingerprint, "版本"),
    reviewFingerprint: safeFingerprint(source.reviewFingerprint, "快检")
  };
}

function sourceFrom({ plan, version, review }) {
  const sourceReview = record(review, "单条拍后快检卡");
  const sourceVersion = record(version, "测试版本");
  if (sourceReview.id !== sourceVersion.testId) throw new Error("快检卡与测试版本不一致");
  return safeSource({
    batchId: sourceReview.batchId || sourceVersion.batchId,
    testId: sourceReview.id,
    type: sourceReview.type,
    orderLabel: sourceReview.orderLabel,
    singleVariable: sourceReview.singleVariable,
    variant: sourceReview.variant,
    fixedElements: sourceReview.fixedElements,
    planFingerprint: takeReviewPlanFingerprint(plan),
    versionFingerprint: takeReviewVersionFingerprint(sourceVersion),
    reviewFingerprint: takeReviewSourceFingerprint(sourceReview)
  });
}

function recordBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createTakeReviewId(randomUUID = () => crypto.randomUUID()) {
  return identifier(`take_${String(randomUUID()).toLowerCase()}`, ID_PATTERN, "过条记录编号");
}

export function takeReviewPlanFingerprint(plan) {
  return fingerprint("take-plan", record(plan, "拍摄方案"));
}

export function takeReviewVersionFingerprint(version) {
  const source = record(version, "测试版本");
  return fingerprint("take-version", {
    testId: source.testId,
    batchId: source.batchId,
    sourceGeneratedAt: source.sourceGeneratedAt,
    primaryVariable: source.primaryVariable,
    baselineCreative: source.baselineCreative,
    minSpend: source.minSpend,
    planItem: source.planItem
  });
}

export function takeReviewPlanMatchesWorkspace(plan, workspace) {
  try {
    const sourcePlan = record(plan, "拍摄方案");
    const sourceWorkspace = record(workspace, "项目工作区");
    if (!sourcePlan.dependencyFingerprint || !Array.isArray(sourcePlan.items) || !sourcePlan.items.length) return false;
    const expected = creativePlanDependencyFingerprint(sourceWorkspace.creativeTask, sourceWorkspace.lastAnalysis, {
      testVariable: sourcePlan.testVariable,
      minSpend: sourcePlan.items[0]?.minSpend
    });
    return sourcePlan.dependencyFingerprint === expected;
  } catch {
    return false;
  }
}

export function takeReviewVersionMatchesPlan(version, plan) {
  try {
    const sourceVersion = record(version, "测试版本");
    const sourcePlan = record(plan, "拍摄方案");
    const item = sourcePlan.items?.find((candidate) => candidate?.id === sourceVersion.testId);
    if (!item) return false;
    const expected = takeReviewVersionFingerprint({
      testId: item.id,
      batchId: sourcePlan.batchId,
      sourceGeneratedAt: sourcePlan.generatedAt,
      primaryVariable: item.singleVariable,
      baselineCreative: item.baselineCreative,
      minSpend: item.minSpend,
      planItem: item
    });
    return takeReviewVersionFingerprint(sourceVersion) === expected;
  } catch {
    return false;
  }
}

export function takeReviewSourceFingerprint(review) {
  return fingerprint("take-review", record(review, "单条拍后快检卡"));
}

export function sanitizeTakeReviewRecord(value) {
  const source = record(value, "人工过条记录");
  if (source.schemaVersion !== RECORD_SCHEMA_VERSION) throw new Error("人工过条记录版本不受支持");
  const checks = safeChecks(source.checks);
  const outcome = safeChoice(source.outcome, OUTCOME_CODES, "人工结论");
  const handoffRole = safeChoice(source.handoffRole, HANDOFF_CODES, "接片角色");
  const ownerRole = safeChoice(source.ownerRole, OWNER_CODES, "处理负责人");
  const issueTimecode = cleanText(source.issueTimecode, "问题时间码", TAKE_REVIEW_LIMITS.maxTimecodeLength);
  const nextCorrection = cleanText(source.nextCorrection, "下一条修正", TAKE_REVIEW_LIMITS.maxCorrectionLength);
  const hasIssue = checks.some((entry) => entry.status === "issue");
  if ((outcome === "keep" || handoffRole !== "none") && hasIssue) throw new Error("存在未通过检查时不能保留或指定接片角色");
  if (handoffRole !== "none" && outcome !== "keep") throw new Error("只有人工保留的 Take 才能指定接片角色");
  if ((outcome === "reshoot" || hasIssue) && (!issueTimecode || !nextCorrection || ownerRole === "none")) throw new Error("重拍或检查问题必须填写时间码、下一条修正和负责人");
  if (outcome === "hold" && (!nextCorrection || ownerRole === "none")) throw new Error("停机核实必须填写核实动作和负责人");
  const revision = Number(source.revision);
  if (!Number.isInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER) throw new Error("过条记录修订号无效");
  const createdOrder = source.createdOrder === undefined ? 0 : Number(source.createdOrder);
  if (source.createdOrder !== undefined && (!Number.isSafeInteger(createdOrder) || createdOrder < 1)) throw new Error("过条记录创建顺序无效");
  const result = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    id: identifier(source.id, ID_PATTERN, "过条记录编号"),
    projectId: identifier(source.projectId, PROJECT_ID_PATTERN, "项目编号"),
    source: safeSource(source.source),
    materialCode: materialLabel(source.materialCode),
    takeNumber: cleanText(source.takeNumber, "Take 编号", TAKE_REVIEW_LIMITS.maxTakeNumberLength, { required: true }),
    checks,
    outcome,
    handoffRole,
    issueTimecode,
    nextCorrection,
    ownerRole,
    createdAt: exactIso(source.createdAt, "创建"),
    updatedAt: exactIso(source.updatedAt, "更新"),
    revision
  };
  if (createdOrder) result.createdOrder = createdOrder;
  if (result.updatedAt < result.createdAt) throw new Error("过条记录更新时间早于创建时间");
  if (recordBytes(result) > TAKE_REVIEW_LIMITS.maxRecordBytes) throw new Error("单条人工过条记录超过 4 KB 上限");
  return result;
}

export function takeReviewRecordSnapshot(value) {
  return JSON.stringify(canonicalize(sanitizeTakeReviewRecord(value)));
}

export function summarizeTakeReviewHistory({ projectId, currentBatchId, currentPlanFingerprint, records = [] } = {}) {
  const safeProjectId = identifier(projectId, PROJECT_ID_PATTERN, "项目编号");
  const safeCurrentBatchId = identifier(currentBatchId, TEST_ID_PATTERN, "当前测试批次");
  const currentFingerprint = safeFingerprint(currentPlanFingerprint, "当前方案");
  if (!Array.isArray(records)) throw new Error("过条历史记录必须是数组");
  if (records.length > TAKE_REVIEW_LIMITS.maxPerProject) throw new Error(`单项目人工过条记录最多 ${TAKE_REVIEW_LIMITS.maxPerProject} 条`);
  const cleanRecords = records.map(sanitizeTakeReviewRecord);
  if (cleanRecords.some((entry) => entry.projectId !== safeProjectId)) throw new Error("过条历史记录混入了其他项目");
  const isCurrentSource = (entry) => entry.source.batchId === safeCurrentBatchId
    && entry.source.planFingerprint === currentFingerprint;
  const currentRecords = cleanRecords.filter(isCurrentSource);
  const historicalRecords = cleanRecords.filter((entry) => !isCurrentSource(entry));
  const groups = new Map();
  for (const entry of historicalRecords) {
    const key = `${entry.source.batchId}\u0000${entry.source.planFingerprint}`;
    const group = groups.get(key) || {
      batchId: entry.source.batchId,
      planFingerprint: entry.source.planFingerprint,
      recordCount: 0,
      testIds: new Set(),
      latestUpdatedAt: entry.updatedAt
    };
    group.recordCount += 1;
    group.testIds.add(entry.source.testId);
    if (entry.updatedAt > group.latestUpdatedAt) group.latestUpdatedAt = entry.updatedAt;
    groups.set(key, group);
  }
  const historyGroups = [...groups.values()]
    .map((group) => ({
      batchId: group.batchId,
      planFingerprint: group.planFingerprint,
      recordCount: group.recordCount,
      versionCount: group.testIds.size,
      latestUpdatedAt: group.latestUpdatedAt
    }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
      || left.batchId.localeCompare(right.batchId)
      || left.planFingerprint.localeCompare(right.planFingerprint));
  return {
    totalCount: cleanRecords.length,
    currentSourceCount: currentRecords.length,
    historicalCount: historicalRecords.length,
    capacityLimit: TAKE_REVIEW_LIMITS.maxPerProject,
    capacityWarningAt: TAKE_REVIEW_LIMITS.capacityWarningAt,
    capacityWarning: cleanRecords.length >= TAKE_REVIEW_LIMITS.capacityWarningAt,
    groups: historyGroups
  };
}

export function createTakeReviewRecord({ id, projectId, version, plan, review, draft = {}, existing = [], now = new Date().toISOString(), randomUUID } = {}) {
  const timestamp = exactIso(now, "保存");
  const safeProjectId = identifier(projectId, PROJECT_ID_PATTERN, "项目编号");
  const source = sourceFrom({ plan, version, review });
  const records = existing.map(sanitizeTakeReviewRecord);
  const requestedId = id ? identifier(id, ID_PATTERN, "过条记录编号") : "";
  const previous = requestedId ? records.find((entry) => entry.id === requestedId) : null;
  const expectedRevision = Number(draft.expectedRevision ?? 0);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("预期修订号无效");
  if (previous && (previous.projectId !== safeProjectId || previous.source.testId !== source.testId)) throw new Error("过条记录不属于当前项目或版本");
  if ((previous?.revision || 0) !== expectedRevision) throw new Error("过条记录已在其他页面更新，请重新载入后再保存");
  if (!previous && requestedId) throw new Error("要编辑的过条记录已不存在，请重新载入");
  if (previous && (
    previous.source.planFingerprint !== source.planFingerprint
    || previous.source.versionFingerprint !== source.versionFingerprint
    || previous.source.reviewFingerprint !== source.reviewFingerprint
  )) throw new Error("来源方案已变化，旧过条记录只读；请新建当前方案的 Take 记录");
  const recordId = previous?.id || createTakeReviewId(randomUUID);
  if (!previous && records.some((entry) => entry.id === recordId)) throw new Error("过条记录编号冲突，请重试");
  const existingVersionRecords = records.filter((entry) => entry.projectId === safeProjectId && entry.source.testId === source.testId);
  const greatestCreatedOrder = existingVersionRecords.reduce((maximum, entry) => Math.max(maximum, entry.createdOrder || 0), 0);
  if (!previous && greatestCreatedOrder >= Number.MAX_SAFE_INTEGER) throw new Error("过条记录创建顺序已达到上限");
  const createdOrder = previous ? (previous.createdOrder || 0) : greatestCreatedOrder + 1;
  const updatedAt = previous && timestamp < previous.updatedAt ? previous.updatedAt : timestamp;
  const result = sanitizeTakeReviewRecord({
    schemaVersion: RECORD_SCHEMA_VERSION,
    id: recordId,
    projectId: safeProjectId,
    source,
    materialCode: draft.materialCode,
    takeNumber: draft.takeNumber,
    checks: draft.checks,
    outcome: draft.outcome,
    handoffRole: draft.handoffRole || "none",
    issueTimecode: draft.issueTimecode,
    nextCorrection: draft.nextCorrection,
    ownerRole: draft.ownerRole || "none",
    createdAt: previous?.createdAt || timestamp,
    updatedAt,
    revision: (previous?.revision || 0) + 1,
    ...(createdOrder ? { createdOrder } : {})
  });
  const projectRecords = records.filter((entry) => entry.projectId === safeProjectId && (!previous || entry.id !== result.id));
  if (!previous && projectRecords.length >= TAKE_REVIEW_LIMITS.maxPerProject) throw new Error(`单项目人工过条记录最多 ${TAKE_REVIEW_LIMITS.maxPerProject} 条`);
  const versionRecords = projectRecords.filter((entry) => entry.source.testId === source.testId);
  if (!previous && versionRecords.length >= TAKE_REVIEW_LIMITS.maxPerVersion) throw new Error(`每个版本最多记录 ${TAKE_REVIEW_LIMITS.maxPerVersion} 个 Take`);
  const duplicate = versionRecords.find((entry) => entry.source.planFingerprint === source.planFingerprint
    && entry.materialCode.toLocaleLowerCase("zh-CN") === result.materialCode.toLocaleLowerCase("zh-CN")
    && entry.takeNumber.toLocaleLowerCase("zh-CN") === result.takeNumber.toLocaleLowerCase("zh-CN"));
  if (duplicate) throw new Error("同一版本中该素材编号与 Take 编号已存在");
  return result;
}

export function assessTakeReviewRecord(value, { version, plan, review } = {}) {
  const entry = sanitizeTakeReviewRecord(value);
  const expected = sourceFrom({ version, plan, review });
  const reasons = [];
  if (entry.source.batchId !== expected.batchId) reasons.push("测试批次已变化");
  if (entry.source.planFingerprint !== expected.planFingerprint) reasons.push("批次方案已变化");
  if (entry.source.versionFingerprint !== expected.versionFingerprint) reasons.push("版本内容已变化");
  if (entry.source.reviewFingerprint !== expected.reviewFingerprint) reasons.push("快检参考已变化");
  return { code: reasons.length ? "stale" : "current", current: reasons.length === 0, reasons, record: entry };
}

function latestFirst(left, right) {
  return (right.createdOrder || 0) - (left.createdOrder || 0)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

export function summarizeTakeReviewBatch({ plan, versions = [], records = [], reviews = [] } = {}) {
  const sourcePlan = record(plan, "拍摄方案");
  if (!Array.isArray(sourcePlan.items)) throw new Error("拍摄方案缺少版本列表");
  const versionMap = new Map(versions.map((version) => [String(version.testId || ""), version]));
  const reviewMap = new Map(reviews.map((review) => [String(review.id || ""), review]));
  const entries = sourcePlan.items.map((item) => {
    const testId = String(item?.id || "");
    const version = versionMap.get(testId);
    const review = reviewMap.get(testId);
    if (!version || !review) throw new Error(`测试版本 ${testId || "（空）"} 尚未完成本地同步`);
    const current = [];
    const stale = [];
    for (const candidate of records.filter((entry) => entry?.projectId === version.projectId && entry?.source?.testId === testId)) {
      const assessment = assessTakeReviewRecord(candidate, { version, plan: sourcePlan, review });
      (assessment.current ? current : stale).push(assessment.record);
    }
    current.sort(latestFirst);
    stale.sort(latestFirst);
    const orderingAmbiguous = current.length > 1 && current.every((entry) => !entry.createdOrder);
    const primary = current.filter((entry) => entry.handoffRole === "primary");
    const backups = current.filter((entry) => entry.handoffRole === "backup");
    const latest = current[0] || null;
    const actionUnresolved = Boolean(latest && (latest.outcome === "reshoot" || latest.outcome === "hold" || latest.checks.some((check) => check.status === "issue")));
    const unresolved = orderingAmbiguous || actionUnresolved;
    return { testId, version, review, currentRecords: current, staleRecords: stale, primaryRecords: primary, backupRecords: backups, latestRecord: latest, reviewed: current.length > 0, orderingAmbiguous, actionUnresolved, unresolved };
  });
  const reviewedCount = entries.filter((entry) => entry.reviewed).length;
  const primaryCount = entries.filter((entry) => entry.primaryRecords.length === 1).length;
  const unresolvedCount = entries.filter((entry) => entry.unresolved).length;
  const orderingAmbiguousCount = entries.filter((entry) => entry.orderingAmbiguous).length;
  const actionUnresolvedCount = entries.filter((entry) => entry.actionUnresolved && !entry.orderingAmbiguous).length;
  const staleCount = entries.reduce((total, entry) => total + entry.staleRecords.length, 0);
  const validBatchSize = entries.length >= 2 && entries.length <= 20;
  const ready = validBatchSize && primaryCount === entries.length && unresolvedCount === 0;
  let code = "not_started";
  let label = "待过条";
  if (!validBatchSize) { code = "invalid"; label = "批次待修正"; }
  else if (orderingAmbiguousCount) { code = "order_ambiguous"; label = "旧记录待核对"; }
  else if (entries.some((entry) => entry.latestRecord?.outcome === "hold")) { code = "hold"; label = "停机核实"; }
  else if (unresolvedCount) { code = "needs_reshoot"; label = "需补拍"; }
  else if (ready) { code = "ready"; label = "可接片"; }
  else if (reviewedCount) { code = "in_progress"; label = "过条中"; }
  const blockers = [];
  if (!validBatchSize) blockers.push("当前批次必须包含 2–20 个版本");
  if (reviewedCount < entries.length) blockers.push(`还有 ${entries.length - reviewedCount} 个版本未登记人工结论`);
  if (primaryCount < entries.length) blockers.push(`还有 ${entries.length - primaryCount} 个版本未人工指定唯一首选 Take`);
  if (orderingAmbiguousCount) blockers.push(`还有 ${orderingAmbiguousCount} 个版本的旧记录缺少可靠创建顺序，需人工核对并登记最新结论`);
  if (actionUnresolvedCount) blockers.push(`还有 ${actionUnresolvedCount} 个版本的最新记录需要重拍或核实`);
  return {
    batchId: String(sourcePlan.batchId || entries[0]?.version?.batchId || ""),
    code,
    label,
    ready,
    totalVersions: entries.length,
    reviewedCount,
    primaryCount,
    unresolvedCount,
    orderingAmbiguousCount,
    staleCount,
    blockers,
    entries
  };
}

export function takeReviewBatchHandoffToText({ projectName, summary } = {}) {
  const source = record(summary, "过条批次摘要");
  if (source.ready !== true || !Array.isArray(source.entries) || !source.entries.length) throw new Error("当前批次尚未达到可接片状态");
  const lines = [
    `# 收工接片单 · ${cleanText(source.batchId, "测试批次", 160, { required: true })}`,
    "",
    `- 项目：${cleanText(projectName, "项目名称", 160, { required: true })}`,
    "- 来源：片场过条台中的人工结论",
    "- 使用规则：首选与备选均由编导明确指定；下列内容不代表系统自动选片。",
    "",
    "## 逐版本接片"
  ];
  source.entries.forEach((entry, index) => {
    const primary = entry.primaryRecords?.[0];
    if (!primary) throw new Error(`${entry.testId} 缺少人工首选 Take`);
    lines.push(
      "",
      `### ${index + 1} · ${entry.testId}`,
      `- 首选：${primary.materialCode} · ${primary.takeNumber}`,
      `- 备选：${entry.backupRecords?.length ? entry.backupRecords.map((record) => `${record.materialCode} · ${record.takeNumber}`).join("；") : "未指定"}`,
      `- 本条只改：${entry.review.singleVariable} → ${entry.review.variant}`,
      `- 其余锁定：${entry.review.fixedElements}`
    );
  });
  lines.push("", "> 本单只整理人工登记结果；不读取媒体、不自动评分或选择 Take，也不自动修改制作状态。");
  return lines.join("\n");
}

const TAKE_REVIEW_FOLLOW_UP_STATUSES = Object.freeze({
  order_ambiguous: Object.freeze({ priority: 0, label: "旧记录顺序待核对" }),
  hold: Object.freeze({ priority: 1, label: "停机核实" }),
  reshoot: Object.freeze({ priority: 2, label: "立即补拍" }),
  unreviewed: Object.freeze({ priority: 3, label: "未过条" }),
  needs_primary: Object.freeze({ priority: 4, label: "待指定唯一首选" })
});

function takeReviewFollowUpStatus(latestRecord, primaryCount, orderingAmbiguous = false) {
  if (orderingAmbiguous) return "order_ambiguous";
  if (latestRecord?.outcome === "hold") return "hold";
  if (latestRecord && (
    latestRecord.outcome === "reshoot"
    || latestRecord.checks.some((check) => check.status === "issue")
  )) return "reshoot";
  if (!latestRecord) return "unreviewed";
  if (primaryCount !== 1) return "needs_primary";
  return "";
}

function takeReviewFollowUpPrompt(status, latestRecord) {
  if (status === "order_ambiguous") return "旧记录缺少可靠创建顺序；请人工核对，并登记一条新的当前结论后再接片。";
  if (status === "hold") return latestRecord.nextCorrection || "请按人工记录完成核实，再登记新的人工结论。";
  if (status === "reshoot") return latestRecord.nextCorrection || "请按人工检查记录完成补拍，再登记新的人工结论。";
  if (status === "unreviewed") return "尚无当前来源的人工过条记录，请由编导完成五项检查并登记结论。";
  return "已有当前来源的人工保留记录，但尚未人工指定唯一首选 Take。";
}

/**
 * Derives the on-set follow-up list from the current plan structure and its saved
 * current-source records without inspecting media. An older failed Take cannot
 * reopen an issue after a newer current-source Take has closed it.
 */
export function deriveTakeReviewFollowUps(summary) {
  const source = record(summary, "过条批次摘要");
  if (!Array.isArray(source.entries)) throw new Error("过条批次摘要缺少版本列表");
  const followUps = [];
  source.entries.forEach((candidate, planOrder) => {
    const entry = record(candidate, "过条版本摘要");
    const currentRecords = Array.isArray(entry.currentRecords)
      ? entry.currentRecords.map(sanitizeTakeReviewRecord).sort(latestFirst)
      : [];
    const latestRecord = currentRecords[0] || null;
    const primaryCount = currentRecords.filter((reviewRecord) => reviewRecord.handoffRole === "primary").length;
    const orderingAmbiguous = entry.orderingAmbiguous === true
      || (currentRecords.length > 1 && currentRecords.every((reviewRecord) => !reviewRecord.createdOrder));
    const status = takeReviewFollowUpStatus(latestRecord, primaryCount, orderingAmbiguous);
    if (!status) return;
    const definition = TAKE_REVIEW_FOLLOW_UP_STATUSES[status];
    const testId = identifier(entry.testId, TEST_ID_PATTERN, "测试编号");
    const type = cleanText(entry.review?.type ?? entry.version?.planItem?.type, "版本类型", 80, { required: true });
    followUps.push({
      testId,
      type,
      status,
      statusLabel: definition.label,
      priority: definition.priority,
      planOrder,
      hasManualRecord: Boolean(latestRecord),
      ambiguousRecordCount: orderingAmbiguous ? currentRecords.length : 0,
      materialCode: latestRecord?.materialCode || "",
      takeNumber: latestRecord?.takeNumber || "",
      issueTimecode: latestRecord?.issueTimecode || "",
      ownerRole: latestRecord?.ownerRole || "none",
      nextCorrection: latestRecord?.nextCorrection || "",
      prompt: takeReviewFollowUpPrompt(status, latestRecord)
    });
  });
  return followUps.sort((left, right) => left.priority - right.priority || left.planOrder - right.planOrder);
}

export function takeReviewFollowUpsToText({ projectName, summary } = {}) {
  const source = record(summary, "过条批次摘要");
  if (source.ready === true) throw new Error("当前批次已经达到可接片状态，不生成空的现场待办 / 追拍单");
  const followUps = deriveTakeReviewFollowUps(source);
  if (!followUps.length) throw new Error("当前批次没有可整理的现场待办 / 追拍项");
  const lines = [
    `# 现场待办 / 追拍单 · ${cleanText(source.batchId, "测试批次", 160, { required: true })}`,
    "",
    `- 项目：${cleanText(projectName, "项目名称", 160, { required: true })}`,
    "- 来源：片场过条台的当前方案结构与已保存人工登记记录",
    "- 说明：本单只整理当前版本结构和人工结论，不读取媒体、不自动判断问题，也不自动选择 Take。",
    "",
    "## 按现场处理优先级"
  ];
  followUps.forEach((item, index) => {
    lines.push("", `### ${index + 1} · ${item.statusLabel} · ${item.testId}`, `- 版本类型：${item.type}`);
    if (item.status === "order_ambiguous") {
      lines.push(`- 人工登记素材：存在 ${item.ambiguousRecordCount} 条旧记录，创建顺序需人工核对`);
    } else if (item.hasManualRecord) {
      lines.push(
        `- 人工登记素材：${item.materialCode} · ${item.takeNumber}`,
        `- 问题时间码：${item.issueTimecode || "人工未填写"}`,
        `- 人工指定负责人：${TAKE_REVIEW_OWNER_ROLES.find((role) => role.code === item.ownerRole)?.label || "未指定"}`,
        `- 人工记录的下一步：${item.nextCorrection || "未填写"}`
      );
    } else {
      lines.push("- 人工登记素材：尚无当前来源的人工过条记录");
    }
    lines.push(`- 现场提示：${item.prompt}`);
  });
  lines.push("", "> 本单只整理当前方案结构与已保存的人工记录，不代表系统已经检查素材或给出自动结论。");
  return lines.join("\n");
}
