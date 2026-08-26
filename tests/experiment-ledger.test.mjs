import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExperimentLedgerSnapshot,
  experimentLedgerToCsv,
  filterExperimentTimeline,
  summarizeExperimentTimeline
} from "../src/experiment-ledger.js";
import { createExperimentDecision } from "../src/experiment-decision.js";
import { createProjectRecord, createResultRecord, versionRecordsFromPlan } from "../src/project-model.js";

function planItem(id) {
  return {
    id,
    type: "基线",
    baselineCreative: "=旧素材",
    singleVariable: "前三秒钩子",
    variant: "=HYPERLINK(\"https://example.com\")",
    audience: "通勤人群",
    hook: "直接提出问题",
    coreClaim: "真实体验",
    scene: "地铁",
    hypothesis: "只修改钩子并观察结果",
    fixedElements: "受众、主张、场景",
    observationMetrics: "CTR、ROI",
    minSpend: 300,
    stopCondition: "达到最低消耗后判断",
    successAction: "保留有效变量",
    production: { spokenScript: "口播", storyboard: "分镜", shootingTask: "任务", editingNotes: "剪辑", subtitleHighlights: "字幕", complianceChecklist: "核验事实" }
  };
}

function plan(batchId) {
  return {
    generatedAt: "2026-08-23T01:00:00.000Z",
    version: "1.3.0",
    batchId,
    creativeTask: {},
    sourceSummary: { targetRoi: 1.5 },
    testVariable: "hook",
    items: [planItem(`${batchId}-B00`)],
    notice: "本地规则"
  };
}

test("summarizes and filters experiment states without changing source order", () => {
  const timeline = [
    { result: null, evaluation: { code: "pending" }, decisionState: { code: "missing" }, version: { decision: null } },
    { result: { metrics: { spend: 20 } }, evaluation: { code: "insufficient" }, decisionState: { code: "current" }, version: { decision: { outcome: "continue" } } },
    { result: { metrics: { spend: 300 } }, evaluation: { code: "target_met" }, decisionState: { code: "stale" }, version: { decision: { outcome: "keep" } } },
    { result: { metrics: { spend: 400 }, qualityWarnings: ["roi_mismatch"] }, evaluation: { code: "below_parent" }, decisionState: { code: "missing" }, version: { decision: null } }
  ];
  assert.deepEqual(summarizeExperimentTimeline(timeline), { total: 4, withResult: 3, pending: 1, insufficient: 1, targetMet: 1, needsReview: 1, qualityWarnings: 1, withDecision: 2, currentDecisions: 1, staleDecisions: 1, totalSpend: 720 });
  assert.equal(filterExperimentTimeline(timeline, "pending").length, 1);
  assert.equal(filterExperimentTimeline(timeline, "needs_review")[0].evaluation.code, "below_parent");
  assert.equal(filterExperimentTimeline(timeline, "quality_warning").length, 1);
  assert.equal(filterExperimentTimeline(timeline, "decision_missing").length, 2);
  assert.equal(filterExperimentTimeline(timeline, "decision_stale").length, 1);
  assert.equal(filterExperimentTimeline(timeline, "decision_keep").length, 1);
  assert.deepEqual(filterExperimentTimeline(timeline, "unknown"), timeline);
});

test("exports a compact project ledger and neutralizes spreadsheet formulas", () => {
  const project = createProjectRecord({ id: "prj_12345678", name: "=项目", now: "2026-08-23T01:00:00.000Z" });
  const [version] = versionRecordsFromPlan({ projectId: project.id, plan: plan("MAT1234567-HOOK-20260823T010000000"), existingVersions: [], parentVersionId: null, now: "2026-08-23T01:00:01.000Z" });
  const result = createResultRecord({ projectId: project.id, testId: version.testId, importedAt: "2026-08-24T01:00:00.000Z", metrics: { spend: 400, gmv: 720, impressions: 1000, clicks: 40, conversions: 4 }, qualityWarnings: ["roi_mismatch"] });
  const evaluation = { code: "target_met", label: "达到目标", detail: "ROI 达标" };
  const decision = createExperimentDecision({ outcome: "keep", primaryMetric: "roi", guardrailMetrics: ["ctr"], reason: "ROI 达标，CTR 作为护栏继续观察。" }, { version, result, evaluation, targetRoi: 1.5 }, { decidedAt: "2026-08-24T02:00:00.000Z" });
  const snapshot = buildExperimentLedgerSnapshot({ project, versions: [{ ...version, decision }], results: [result], targetRoi: 1.5, exportedAt: "2026-08-25T01:00:00.000Z" });
  assert.equal(snapshot.summary.targetMet, 1);
  assert.equal(snapshot.entries[0].metrics.roi, 1.8);
  assert.deepEqual(snapshot.entries[0].qualityWarnings, ["roi_mismatch"]);
  assert.equal(snapshot.entries[0].decision.outcome, "keep");
  assert.equal(snapshot.entries[0].decisionState.code, "current");
  assert.equal("planItem" in snapshot.entries[0], false);
  assert.doesNotMatch(JSON.stringify(snapshot), /口播|分镜/u);
  const csv = experimentLedgerToCsv(snapshot);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /'=项目/u);
  assert.match(csv, /'=HYPERLINK/u);
  assert.match(csv, /ROI 与成交金额 ÷ 消耗差异较大/u);
  assert.match(csv, /保留方案/u);
  assert.match(csv, /ROI 达标，CTR 作为护栏继续观察/u);
  assert.match(csv, /,400,720,1\.8,/u);
});

test("fails closed for an invalid ledger snapshot", () => {
  assert.throws(() => experimentLedgerToCsv({ schemaVersion: 99, entries: [] }), /格式无效/u);
});
