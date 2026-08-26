import { spreadsheetSafeText } from "./release-safety.js";
import { EXPERIMENT_DECISION_METRIC_LABELS, EXPERIMENT_DECISION_OUTCOME_LABELS, experimentDataHealth } from "./experiment-decision.js";
import { experimentQualityWarningLabel } from "./experiment-results.js";
import { buildVersionTimeline, sanitizeProjectRecord } from "./project-model.js";
import { sanitizedTargetRoi } from "./update.js";

export const EXPERIMENT_LEDGER_SCHEMA_VERSION = 2;
export const EXPERIMENT_LEDGER_FILTERS = Object.freeze([
  "all", "pending", "insufficient", "target_met", "needs_review", "quality_warning",
  "decision_missing", "decision_current", "decision_stale", "decision_continue", "decision_keep", "decision_stop"
]);

const REVIEW_CODES = new Set(["metric_missing", "below_target", "above_parent", "below_parent"]);

function exactIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间格式无效`);
  return candidate;
}

function safeTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("实验时间线格式无效");
  return timeline;
}

export function summarizeExperimentTimeline(timeline = []) {
  const entries = safeTimeline(timeline);
  const summary = {
    total: entries.length,
    withResult: 0,
    pending: 0,
    insufficient: 0,
    targetMet: 0,
    needsReview: 0,
    qualityWarnings: 0,
    withDecision: 0,
    currentDecisions: 0,
    staleDecisions: 0,
    totalSpend: 0
  };
  for (const entry of entries) {
    const code = String(entry?.evaluation?.code || "");
    if (entry?.result) {
      summary.withResult += 1;
      summary.totalSpend += Number(entry.result.metrics?.spend || 0);
      summary.qualityWarnings += entry.result.qualityWarnings?.length || 0;
    }
    if (code === "pending") summary.pending += 1;
    else if (code === "insufficient") summary.insufficient += 1;
    else if (code === "target_met") summary.targetMet += 1;
    else summary.needsReview += 1;
    const decisionCode = entry?.decisionState?.code || (entry?.version?.decision ? "current" : "missing");
    if (decisionCode !== "missing") summary.withDecision += 1;
    if (decisionCode === "current") summary.currentDecisions += 1;
    if (decisionCode === "stale") summary.staleDecisions += 1;
  }
  return summary;
}

export function filterExperimentTimeline(timeline = [], filter = "all") {
  const entries = safeTimeline(timeline);
  const safeFilter = EXPERIMENT_LEDGER_FILTERS.includes(filter) ? filter : "all";
  if (safeFilter === "all") return [...entries];
  if (safeFilter === "needs_review") return entries.filter((entry) => REVIEW_CODES.has(entry?.evaluation?.code));
  if (safeFilter === "quality_warning") return entries.filter((entry) => entry?.result?.qualityWarnings?.length);
  if (safeFilter === "decision_missing") return entries.filter((entry) => entry?.decisionState?.code === "missing");
  if (safeFilter === "decision_current") return entries.filter((entry) => entry?.decisionState?.code === "current");
  if (safeFilter === "decision_stale") return entries.filter((entry) => entry?.decisionState?.code === "stale");
  if (safeFilter.startsWith("decision_")) return entries.filter((entry) => entry?.version?.decision?.outcome === safeFilter.slice("decision_".length));
  return entries.filter((entry) => entry?.evaluation?.code === safeFilter);
}

export function buildExperimentLedgerSnapshot({ project, versions = [], results = [], targetRoi = 1.5, exportedAt = new Date().toISOString() } = {}) {
  const safeProject = sanitizeProjectRecord(project);
  const safeTargetRoi = sanitizedTargetRoi(targetRoi);
  const timeline = buildVersionTimeline(versions, results, safeTargetRoi);
  return {
    schemaVersion: EXPERIMENT_LEDGER_SCHEMA_VERSION,
    exportedAt: exactIso(exportedAt, "台账导出"),
    project: { id: safeProject.id, name: safeProject.name },
    targetRoi: safeTargetRoi,
    summary: summarizeExperimentTimeline(timeline),
    entries: timeline.map(({ version, result, evaluation, decisionState }) => ({
      testId: version.testId,
      parentVersionId: version.parentVersionId,
      batchId: version.batchId,
      createdAt: version.createdAt,
      sourceGeneratedAt: version.sourceGeneratedAt,
      primaryVariable: version.primaryVariable,
      variableValue: version.planItem.variant,
      baselineCreative: version.baselineCreative,
      minSpend: version.minSpend,
      resultImportedAt: result?.importedAt || null,
      metrics: result ? structuredClone(result.metrics) : null,
      qualityWarnings: result ? [...result.qualityWarnings] : [],
      dataHealth: experimentDataHealth({ result, evaluation }),
      evaluation: structuredClone(evaluation),
      decision: version.decision ? structuredClone(version.decision) : null,
      decisionState: {
        code: decisionState.code,
        label: decisionState.label,
        stale: decisionState.stale,
        detail: decisionState.detail || ""
      }
    })),
    notice: "仅导出当前项目的测试版本、描述性状态与已回填指标；不包含原始报表、素材、账号数据、本机路径或因果结论。"
  };
}

function csvCell(value) {
  const text = spreadsheetSafeText(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function experimentLedgerToCsv(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== EXPERIMENT_LEDGER_SCHEMA_VERSION || !Array.isArray(snapshot.entries)) throw new Error("实验台账格式无效");
  const headers = ["项目", "测试编号", "父版本", "批次", "方案生成时间", "主要变量", "变量值", "基线素材", "最低消耗", "状态", "状态说明", "数据健康", "口径提醒", "人工决策状态", "人工决策", "主指标", "护栏指标", "决策理由", "决策时间", "结果导入时间", "消耗", "成交金额", "ROI", "展示", "点击", "转化", "CTR（小数）", "CVR（小数）", "3 秒播放率（小数）", "完播率（小数）"];
  const rows = snapshot.entries.map((entry) => {
    const metrics = entry.metrics || {};
    return [
      snapshot.project?.name,
      entry.testId,
      entry.parentVersionId,
      entry.batchId,
      entry.sourceGeneratedAt,
      entry.primaryVariable,
      entry.variableValue,
      entry.baselineCreative,
      entry.minSpend,
      entry.evaluation?.label,
      entry.evaluation?.detail,
      entry.dataHealth?.label,
      entry.qualityWarnings?.map(experimentQualityWarningLabel).join("；"),
      entry.decisionState?.label,
      EXPERIMENT_DECISION_OUTCOME_LABELS[entry.decision?.outcome] || "",
      EXPERIMENT_DECISION_METRIC_LABELS[entry.decision?.primaryMetric] || "",
      entry.decision?.guardrailMetrics?.map((metric) => EXPERIMENT_DECISION_METRIC_LABELS[metric]).join("；") || "",
      entry.decision?.reason,
      entry.decision?.decidedAt,
      entry.resultImportedAt,
      metrics.spend,
      metrics.gmv,
      metrics.roi,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.ctr,
      metrics.cvr,
      metrics.threeSecondRate,
      metrics.completionRate
    ];
  });
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
