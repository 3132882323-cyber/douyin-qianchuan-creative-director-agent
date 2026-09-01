import {
  assessOperatorHandoffReadiness,
  buildOperatorSingleVariableDiff,
  experimentVersionToOperatorCard
} from "./operator-handoff.js";

export const MAX_OPERATOR_BATCH_VERSIONS = 40;

function requiredTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("批次投放交接时间线格式无效");
  for (const entry of timeline) {
    if (!entry?.version?.testId || !entry.version.planItem) throw new Error("批次投放交接包含无效测试版本");
  }
  return timeline;
}

function batchIdOf(entry) {
  return String(entry?.version?.batchId || "").trim();
}

function batchTimestamp(entry) {
  const value = Date.parse(entry?.version?.sourceGeneratedAt || entry?.version?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function latestBatchId(timeline) {
  const batches = new Map();
  for (const entry of timeline) {
    const batchId = batchIdOf(entry);
    if (!batchId) continue;
    const current = batches.get(batchId) || Number.NEGATIVE_INFINITY;
    batches.set(batchId, Math.max(current, batchTimestamp(entry)));
  }
  return [...batches]
    .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0], "zh-CN"))[0]?.[0] || "";
}

function versionOrder(entry) {
  const testId = String(entry.version.testId || "");
  if (/-B00$/u.test(testId)) return [0, 0, testId];
  if (String(entry.version.planItem?.type || "").trim() === "基线") return [1, 0, testId];
  const variant = testId.match(/-A(\d+)$/u);
  if (variant) return [2, Number(variant[1]), testId];
  return [3, Number.MAX_SAFE_INTEGER, testId];
}

function compareVersions(left, right) {
  const a = versionOrder(left);
  const b = versionOrder(right);
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], "zh-CN");
}

function emptyBatch() {
  return {
    code: "empty",
    ready: false,
    copyable: false,
    batchId: "",
    entries: [],
    readyCount: 0,
    total: 0,
    readyChecks: 0,
    totalChecks: 0,
    missingCount: 0,
    launchedCount: 0,
    issues: []
  };
}

export function buildLatestOperatorBatchHandoff(timeline = [], { targetRoi } = {}) {
  const entries = requiredTimeline(timeline);
  const batchId = latestBatchId(entries);
  if (!batchId) return emptyBatch();
  const batchEntries = entries.filter((entry) => batchIdOf(entry) === batchId).sort(compareVersions);
  if (batchEntries.length > MAX_OPERATOR_BATCH_VERSIONS) {
    return {
      ...emptyBatch(),
      code: "too_large",
      batchId,
      total: batchEntries.length,
      issues: [{ testId: batchId, missing: [`单批次最多复制 ${MAX_OPERATOR_BATCH_VERSIONS} 个版本`] }]
    };
  }
  const assessed = batchEntries.map((entry) => {
    const contentDiff = buildOperatorSingleVariableDiff(entry, entries);
    const readiness = assessOperatorHandoffReadiness(entry, { targetRoi, contentDiff });
    return {
      entry,
      testId: entry.version.testId,
      type: String(entry.version.planItem.type || "任务"),
      contentDiff,
      readiness
    };
  });
  const issues = assessed
    .filter((item) => !item.readiness.ready)
    .map((item) => ({ testId: item.testId, missing: item.readiness.missing.map((gap) => gap.label) }));
  const readyCount = assessed.filter((item) => item.readiness.ready).length;
  const readyChecks = assessed.reduce((sum, item) => sum + item.readiness.readyCount, 0);
  const totalChecks = assessed.reduce((sum, item) => sum + item.readiness.total, 0);
  const missingCount = assessed.reduce((sum, item) => sum + item.readiness.missing.length, 0);
  return {
    code: issues.length ? "needs_review" : "ready",
    ready: issues.length === 0,
    copyable: true,
    batchId,
    entries: assessed,
    readyCount,
    total: assessed.length,
    readyChecks,
    totalChecks,
    missingCount,
    launchedCount: assessed.filter((item) => item.readiness.productionStage === "launched").length,
    issues
  };
}

export function latestOperatorBatchToText(timeline = [], {
  targetRoi,
  projectName = "当前本地项目"
} = {}) {
  const batch = buildLatestOperatorBatchHandoff(timeline, { targetRoi });
  if (batch.code === "empty") throw new Error("当前没有可交接的测试批次");
  if (!batch.copyable) throw new Error(`最新批次超过 ${MAX_OPERATOR_BATCH_VERSIONS} 个版本，请拆分后再交接`);
  const issueText = batch.issues.length
    ? batch.issues.map((issue) => `${issue.testId}：${issue.missing.join("、")}`).join("；")
    : "无";
  const lines = [
    "# 千川批次投放交接包",
    "",
    `- 项目：${String(projectName || "当前本地项目").trim()}`,
    `- 测试批次：${batch.batchId}`,
    `- 执行顺序：${batch.entries.map((item) => item.testId).join(" → ")}`,
    `- 版本就绪：${batch.readyCount} / ${batch.total}`,
    `- 检查项：${batch.readyChecks} / ${batch.totalChecks}`,
    `- 已上线版本：${batch.launchedCount} / ${batch.total}`,
    `- 待处理：${issueText}`,
    "",
    "> 建议先核对 B00 基线，再按编号建立变体；每个版本仍需操盘手在平台内人工建计划、设预算和启停。扩展不会读取账户、执行投放或验证平台状态。",
    ""
  ];
  batch.entries.forEach((item, index) => {
    const card = experimentVersionToOperatorCard(item.entry, {
      targetRoi,
      projectName,
      contentDiff: item.contentDiff
    }).replace(/^# 千川投放交接卡/u, `## ${String(index + 1).padStart(2, "0")} · ${item.testId}`);
    lines.push(card, "");
  });
  return lines.join("\n").trim();
}
