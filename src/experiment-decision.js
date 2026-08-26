export const EXPERIMENT_DECISION_METHOD = "manual";
export const EXPERIMENT_DECISION_OUTCOME_LABELS = Object.freeze({
  continue: "继续测试",
  keep: "保留方案",
  stop: "停止测试"
});
export const EXPERIMENT_DECISION_METRIC_LABELS = Object.freeze({
  roi: "ROI",
  ctr: "CTR",
  cvr: "CVR",
  threeSecondRate: "3 秒播放率",
  completionRate: "完播率",
  spend: "消耗"
});

const EVALUATION_CODES = new Set(["pending", "insufficient", "metric_missing", "target_met", "above_parent", "below_parent", "below_target"]);
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ACTIVE_CONTENT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|img)\b|javascript\s*:|\bon[a-z]+\s*=)/iu;
const METRIC_KEYS = Object.keys(EXPERIMENT_DECISION_METRIC_LABELS);
const OUTCOME_KEYS = Object.keys(EXPERIMENT_DECISION_OUTCOME_LABELS);
const RESULT_METRICS = Object.freeze(["spend", "gmv", "roi", "impressions", "clicks", "conversions", "ctr", "cvr", "threeSecondRate", "completionRate"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}包含未知字段：${key}`);
  }
}

function exactIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间格式无效`);
  return candidate;
}

function boundedNumber(value, label, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw new Error(`${label}数值无效`);
  return number;
}

function safeReason(value) {
  const reason = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (reason.length < 4) throw new Error("人工决策理由至少填写 4 个字符");
  if (reason.length > 600) throw new Error("人工决策理由不能超过 600 个字符");
  if (CONTROL_PATTERN.test(reason) || ACTIVE_CONTENT_PATTERN.test(reason)) throw new Error("人工决策理由包含不安全内容");
  return reason;
}

function stableFingerprint(value) {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `evidence:${hash.toString(16).padStart(8, "0")}`;
}

function safeMetric(value, label = "指标") {
  const metric = String(value || "");
  if (!METRIC_KEYS.includes(metric)) throw new Error(`${label}不受支持`);
  return metric;
}

function safeGuardrails(value, primaryMetric) {
  if (!Array.isArray(value) || value.length > 4) throw new Error("护栏指标格式无效");
  const guardrails = [...new Set(value.map((item) => safeMetric(item, "护栏指标")))];
  if (guardrails.length !== value.length) throw new Error("护栏指标不能重复");
  if (guardrails.includes(primaryMetric)) throw new Error("主指标不能同时作为护栏指标");
  return guardrails;
}

function normalizedMetrics(result) {
  return Object.fromEntries(RESULT_METRICS.map((key) => {
    const value = result?.metrics?.[key];
    return [key, Number.isFinite(value) ? value : null];
  }));
}

export function buildExperimentDecisionEvidence({ version, result = null, evaluation, targetRoi }) {
  if (!isRecord(version) || !version.testId) throw new Error("人工决策缺少测试版本");
  const evaluationCode = String(evaluation?.code || "");
  if (!EVALUATION_CODES.has(evaluationCode)) throw new Error("人工决策的数据状态不受支持");
  const resultImportedAt = result?.importedAt ? exactIso(result.importedAt, "结果导入") : null;
  const safeTargetRoi = boundedNumber(targetRoi, "目标 ROI", 1e6);
  const minSpend = boundedNumber(version.minSpend, "最低测试消耗", 1e9);
  const fingerprint = stableFingerprint({
    version: {
      testId: String(version.testId),
      parentVersionId: version.parentVersionId ? String(version.parentVersionId) : null,
      batchId: String(version.batchId || ""),
      sourceGeneratedAt: String(version.sourceGeneratedAt || ""),
      primaryVariable: String(version.primaryVariable || ""),
      baselineCreative: String(version.baselineCreative || ""),
      minSpend,
      planItem: version.planItem || null
    },
    resultImportedAt,
    metrics: normalizedMetrics(result),
    qualityWarnings: [...(result?.qualityWarnings || [])].map(String).sort(),
    evaluationCode,
    targetRoi: safeTargetRoi
  });
  return { resultImportedAt, evaluationCode, targetRoi: safeTargetRoi, minSpend, fingerprint };
}

function sanitizeEvidence(value) {
  if (!isRecord(value)) throw new Error("人工决策证据快照格式无效");
  exactKeys(value, ["resultImportedAt", "evaluationCode", "targetRoi", "minSpend", "fingerprint"], "人工决策证据快照");
  const resultImportedAt = value.resultImportedAt === null ? null : exactIso(value.resultImportedAt, "结果导入");
  const evaluationCode = String(value.evaluationCode || "");
  if (!EVALUATION_CODES.has(evaluationCode)) throw new Error("人工决策的数据状态不受支持");
  const fingerprint = String(value.fingerprint || "");
  if (!/^evidence:[0-9a-f]{8}$/u.test(fingerprint)) throw new Error("人工决策证据指纹无效");
  return {
    resultImportedAt,
    evaluationCode,
    targetRoi: boundedNumber(value.targetRoi, "目标 ROI", 1e6),
    minSpend: boundedNumber(value.minSpend, "最低测试消耗", 1e9),
    fingerprint
  };
}

export function sanitizeExperimentDecision(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("人工决策记录格式无效");
  exactKeys(value, ["method", "outcome", "primaryMetric", "guardrailMetrics", "reason", "decidedAt", "evidence"], "人工决策记录");
  if (value.method !== EXPERIMENT_DECISION_METHOD) throw new Error("人工决策方法不受支持");
  const outcome = String(value.outcome || "");
  if (!OUTCOME_KEYS.includes(outcome)) throw new Error("人工决策结论不受支持");
  const primaryMetric = safeMetric(value.primaryMetric, "主指标");
  return {
    method: EXPERIMENT_DECISION_METHOD,
    outcome,
    primaryMetric,
    guardrailMetrics: safeGuardrails(value.guardrailMetrics, primaryMetric),
    reason: safeReason(value.reason),
    decidedAt: exactIso(value.decidedAt, "人工决策"),
    evidence: sanitizeEvidence(value.evidence)
  };
}

export function createExperimentDecision(rawDecision, context, options = {}) {
  if (!isRecord(rawDecision)) throw new Error("请填写人工决策");
  const primaryMetric = safeMetric(rawDecision.primaryMetric || "roi", "主指标");
  return sanitizeExperimentDecision({
    method: EXPERIMENT_DECISION_METHOD,
    outcome: rawDecision.outcome,
    primaryMetric,
    guardrailMetrics: rawDecision.guardrailMetrics || [],
    reason: rawDecision.reason,
    decidedAt: options.decidedAt || new Date().toISOString(),
    evidence: buildExperimentDecisionEvidence(context)
  });
}

export function assessExperimentDecision(decision, context) {
  const safeDecision = sanitizeExperimentDecision(decision);
  if (!safeDecision) return { code: "missing", label: "尚未决策", stale: false, decision: null };
  const currentEvidence = buildExperimentDecisionEvidence(context);
  const stale = currentEvidence.fingerprint !== safeDecision.evidence.fingerprint;
  const outcomeLabel = EXPERIMENT_DECISION_OUTCOME_LABELS[safeDecision.outcome];
  return {
    code: stale ? "stale" : "current",
    label: stale ? `${outcomeLabel} · 需重新确认` : outcomeLabel,
    stale,
    decision: safeDecision,
    currentEvidence,
    detail: stale
      ? "结果、目标 ROI、最低消耗或版本内容已变化，旧结论仅供审计，不能作为当前结论。"
      : `由编导于 ${safeDecision.decidedAt} 手动记录。`
  };
}

export function experimentDataHealth({ result = null, evaluation }) {
  if (!result) return { code: "pending", label: "等待结果", ready: false };
  if (evaluation?.code === "insufficient") return { code: "insufficient", label: "样本不足", ready: false };
  if (evaluation?.code === "metric_missing") return { code: "metric_missing", label: "缺少主指标", ready: false };
  if (result.qualityWarnings?.length) return { code: "warning", label: `口径提醒 ${result.qualityWarnings.length} 条`, ready: false };
  return { code: "ready", label: "数据可复核", ready: true };
}
