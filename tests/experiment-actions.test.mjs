import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExperimentNextAction,
  buildExperimentVersionActions,
  experimentCardActiveLayer,
  recommendExperimentParent
} from "../src/experiment-actions.js";

function entry(testId, evaluationCode, options = {}) {
  return {
    version: { testId, decision: options.decision || null, productionStatus: options.productionStatus || null },
    result: options.result === undefined ? (evaluationCode === "pending" ? null : { metrics: { spend: 400 }, qualityWarnings: [] }) : options.result,
    evaluation: { code: evaluationCode },
    decisionState: options.decisionState || { code: options.decision ? "current" : "missing" }
  };
}

test("prioritizes stale decisions and quality warnings over routine work", () => {
  const stale = entry("STALE", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "stale" } });
  const warning = entry("WARNING", "target_met", { result: { metrics: { spend: 400 }, qualityWarnings: ["roi_mismatch"] } });
  assert.equal(buildExperimentNextAction([warning, stale, entry("PENDING", "pending")]).code, "decision_stale");
  assert.equal(buildExperimentNextAction([warning, entry("PENDING", "pending")]).focusMetric, "roi");
});

test("routes a reviewable result to an explicit human decision", () => {
  const next = buildExperimentNextAction([entry("READY", "target_met")]);
  assert.equal(next.code, "decision_ready");
  assert.equal(next.target, "decision");
  assert.equal(next.testId, "READY");
});

test("routes missing, pending and insufficient data to local quick backfill", () => {
  assert.equal(buildExperimentNextAction([entry("MISSING", "metric_missing")]).code, "metric_missing");
  assert.equal(buildExperimentNextAction([entry("PENDING", "pending", { productionStatus: { stage: "launched", updatedAt: "2026-08-31T01:00:00.000Z" } })]).target, "manual_result");
  assert.equal(buildExperimentNextAction([entry("LOW", "insufficient")]).code, "insufficient");
});

test("asks for manual production progress before prompting result backfill", () => {
  const untracked = buildExperimentNextAction([entry("UNTRACKED", "pending")]);
  assert.equal(untracked.code, "production_unmarked");
  assert.equal(untracked.target, "production");
  assert.match(untracked.description, /只有编导手动标记/u);
  const ready = buildExperimentNextAction([entry("READY", "pending", { productionStatus: { stage: "ready", updatedAt: "2026-08-31T01:00:00.000Z" } })]);
  assert.equal(ready.code, "production_progress");
  assert.equal(ready.filter, "production_ready");
  const paused = buildExperimentNextAction([entry("PAUSED", "pending", { productionStatus: { stage: "paused", updatedAt: "2026-08-31T01:00:00.000Z" } })]);
  assert.equal(paused.code, "production_paused");
  assert.equal(paused.target, "timeline");
});

test("recommends only a current human-approved parent and prefers keep over continue", () => {
  const continued = entry("CONTINUE", "target_met", { decision: { outcome: "continue" }, decisionState: { code: "current" } });
  const kept = entry("KEEP", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "current" } });
  const stale = entry("STALE", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "stale" } });
  const stopped = entry("STOP", "target_met", { decision: { outcome: "stop" }, decisionState: { code: "current" } });
  assert.deepEqual(recommendExperimentParent([continued, stale, stopped, kept]), {
    testId: "KEEP",
    outcome: "keep",
    outcomeLabel: "保留方案",
    decidedAt: null,
    source: "current_manual_decision"
  });
  assert.equal(recommendExperimentParent([stale, stopped]), null);
});

test("reports an honest empty, next-round and stopped state", () => {
  assert.equal(buildExperimentNextAction([]).code, "empty");
  const complete = entry("DONE", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "current" } });
  assert.equal(buildExperimentNextAction([complete]).code, "next_round_ready");
  assert.equal(buildExperimentNextAction([complete]).target, "parent");
  const acknowledgedLowSample = entry("LOW", "insufficient", { decision: { outcome: "continue" }, decisionState: { code: "current" } });
  assert.equal(buildExperimentNextAction([acknowledgedLowSample]).code, "next_round_ready");
  const stopped = entry("STOP", "target_met", { decision: { outcome: "stop" }, decisionState: { code: "current" } });
  assert.equal(buildExperimentNextAction([stopped]).code, "complete_stopped");
  assert.throws(() => buildExperimentNextAction({}), /行动队列/u);
  assert.throws(() => recommendExperimentParent({}), /父版本建议/u);
});

test("builds contextual card actions without writing or inferring a decision", () => {
  const pending = entry("PENDING", "pending");
  assert.deepEqual(buildExperimentVersionActions(pending), {
    testId: "PENDING",
    result: { label: "补录结果", focusMetric: "spend" },
    decision: { label: "记录决策", state: "missing" },
    parent: null
  });

  const launched = entry("LAUNCHED", "pending", { productionStatus: { stage: "launched", updatedAt: "2026-08-31T01:00:00.000Z" } });
  assert.equal(buildExperimentVersionActions(launched).result.label, "回填结果");

  const warning = entry("WARNING", "target_met", {
    result: { metrics: { spend: 400 }, qualityWarnings: ["ctr_mismatch"] }
  });
  assert.equal(buildExperimentVersionActions(warning).result.label, "核对结果");
  assert.equal(buildExperimentVersionActions(warning).result.focusMetric, "ctr");

  const stale = entry("STALE", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "stale" } });
  assert.equal(buildExperimentVersionActions(stale).decision.label, "重新确认决策");
  assert.equal(buildExperimentVersionActions(stale).parent, null);
});

test("only exposes the parent shortcut for a current keep or continue decision", () => {
  const kept = entry("KEEP", "target_met", { decision: { outcome: "keep" }, decisionState: { code: "current" } });
  assert.deepEqual(buildExperimentVersionActions(kept).parent, {
    label: "设为下一轮父版本",
    outcome: "keep",
    outcomeLabel: "保留方案"
  });
  const stopped = entry("STOP", "target_met", { decision: { outcome: "stop" }, decisionState: { code: "current" } });
  assert.equal(buildExperimentVersionActions(stopped).parent, null);
  assert.throws(() => buildExperimentVersionActions({}), /测试编号/u);
});

test("opens only the version-card layer that matches the next human task", () => {
  assert.equal(experimentCardActiveLayer(entry("UNTRACKED", "pending")), "production");
  assert.equal(experimentCardActiveLayer(entry("LAUNCHED", "pending", {
    productionStatus: { stage: "launched", updatedAt: "2026-08-31T01:00:00.000Z" }
  })), "result");
  assert.equal(experimentCardActiveLayer(entry("READY", "target_met")), "decision");
  assert.equal(experimentCardActiveLayer(entry("STALE", "target_met", {
    decision: { outcome: "keep" },
    decisionState: { code: "stale" }
  })), "decision");
  assert.equal(experimentCardActiveLayer(entry("WARNING", "target_met", {
    result: { metrics: { spend: 400 }, qualityWarnings: ["roi_mismatch"] }
  })), "result");
  assert.equal(experimentCardActiveLayer(entry("LOW", "insufficient")), "result");
  assert.equal(experimentCardActiveLayer(entry("PAUSED", "pending", {
    productionStatus: { stage: "paused", updatedAt: "2026-08-31T01:00:00.000Z" }
  })), "summary");
  assert.equal(experimentCardActiveLayer(entry("DONE", "target_met", {
    decision: { outcome: "stop" },
    decisionState: { code: "current" }
  })), "summary");
  assert.equal(experimentCardActiveLayer(entry("ACKNOWLEDGED", "pending", {
    decision: { outcome: "continue" },
    decisionState: { code: "current" }
  })), "summary");
  assert.throws(() => experimentCardActiveLayer({}), /测试编号/u);
});
