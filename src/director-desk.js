import { buildCreativeVersionDiff } from "./creative-version-diff.js";
import { buildExperimentNextAction } from "./experiment-actions.js";

export const DIRECTOR_DESK_MAX_ACTIONS = 3;

const WORKFLOW_PRIORITIES = Object.freeze({
  "review-pending": 100,
  "review-missing": 96,
  "plan-stale": 92,
  "plan-ready": 70,
  "review-ready": 65,
  "task-ready": 55,
  "round-complete": 45,
  empty: 20
});

const EXPERIMENT_PRIORITIES = Object.freeze({
  decision_stale: 99,
  quality_warning: 97,
  decision_ready: 88,
  metric_missing: 87,
  result_pending: 80,
  insufficient: 60,
  next_round_ready: 58,
  complete_stopped: 35
});

const CONTENT_RISK_CODES = new Set(["parent_missing", "unchanged", "unknown_variable", "needs_review", "primary_unchanged"]);

function validateRecentWork(recentWork) {
  if (!recentWork || typeof recentWork !== "object" || !String(recentWork.kind || "").trim()) {
    throw new Error("编导行动台缺少可靠的当前流程状态");
  }
  for (const key of ["title", "description", "action", "targetView", "focusId"]) {
    if (!String(recentWork[key] || "").trim()) throw new Error(`编导行动台流程状态缺少 ${key}`);
  }
  return recentWork;
}

function validateTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("编导行动台实验时间线格式无效");
  for (const entry of timeline) {
    if (!entry?.version?.testId || !entry.version.planItem) throw new Error("编导行动台实验版本缺少测试编号或拍摄方案");
  }
  return timeline;
}

function workflowAction(recentWork) {
  return {
    id: `workflow:${recentWork.kind}`,
    kind: "workflow",
    priority: WORKFLOW_PRIORITIES[recentWork.kind] ?? 50,
    title: recentWork.title,
    description: recentWork.description,
    action: recentWork.action,
    route: {
      type: "workflow",
      targetView: recentWork.targetView,
      focusId: recentWork.focusId
    }
  };
}

function experimentAction(timeline) {
  const next = buildExperimentNextAction(timeline);
  if (!next.testId || !next.actionLabel) return null;
  return {
    id: `experiment:${next.code}:${next.testId}`,
    kind: "experiment",
    priority: EXPERIMENT_PRIORITIES[next.code] ?? 50,
    title: next.title,
    description: next.description,
    action: next.actionLabel,
    route: { type: "experiment", next }
  };
}

function latestBatchEntries(timeline) {
  if (!timeline.length) return [];
  const latestBatchId = String(timeline[0].version.batchId || "").trim();
  if (!latestBatchId) return [timeline[0]];
  return timeline.filter((entry) => String(entry.version.batchId || "").trim() === latestBatchId);
}

function latestBatchContentAction(timeline) {
  const risks = latestBatchEntries(timeline)
    .map((entry) => ({ entry, diff: buildCreativeVersionDiff(entry, timeline) }))
    .filter(({ diff }) => diff && CONTENT_RISK_CODES.has(diff.code));
  if (!risks.length) return { action: null, riskCount: 0 };
  const first = risks[0];
  const countLabel = `${risks.length} 个版本`;
  return {
    riskCount: risks.length,
    action: {
      id: `content-risk:${first.entry.version.testId}`,
      kind: "content-risk",
      priority: 94,
      title: `核对最新批次的单变量风险`,
      description: `${countLabel}需要人工核对。${first.entry.version.testId}：${first.diff.label}。`,
      action: risks.length > 1 ? `核对 ${countLabel}` : "核对版本差异",
      route: {
        type: "content-diff",
        testId: first.entry.version.testId
      }
    }
  };
}

export function buildDirectorDesk({ recentWork, timeline = [], limit = DIRECTOR_DESK_MAX_ACTIONS } = {}) {
  const reliableWork = validateRecentWork(recentWork);
  const reliableTimeline = validateTimeline(timeline);
  const requestedLimit = Number(limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error("编导行动台显示数量必须是正整数");
  const visibleLimit = Math.min(requestedLimit, DIRECTOR_DESK_MAX_ACTIONS);
  const experiment = experimentAction(reliableTimeline);
  const content = latestBatchContentAction(reliableTimeline);
  const candidates = [workflowAction(reliableWork), experiment, content.action]
    .filter(Boolean)
    .map((item, index) => ({ ...item, order: index }))
    .sort((left, right) => right.priority - left.priority || left.order - right.order)
    .map(({ order, ...item }) => item);
  const unique = [...new Map(candidates.map((item) => [item.id, item])).values()];
  const items = unique.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, unique.length - items.length);
  const riskLabel = content.riskCount ? ` · 最新批次 ${content.riskCount} 个版本需核对单变量` : "";
  return {
    items,
    totalActionCount: unique.length,
    hiddenCount,
    contentRiskCount: content.riskCount,
    summary: `当前显示 ${items.length}/${unique.length} 项优先动作${riskLabel}${hiddenCount ? ` · 另有 ${hiddenCount} 项` : ""}；只做本地排序，不会自动执行。`
  };
}
