import test from "node:test";
import assert from "node:assert/strict";
import { buildExperimentNextAction, buildExperimentVersionActions, recommendExperimentParent } from "../src/experiment-actions.js";

function entry(testId, evaluationCode, options = {}) {
  return {
    version: { testId, decision: options.decision || null },
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
  assert.equal(buildExperimentNextAction([entry("PENDING", "pending")]).target, "manual_result");
  assert.equal(buildExperimentNextAction([entry("LOW", "insufficient")]).code, "insufficient");
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
    result: { label: "回填结果", focusMetric: "spend" },
    decision: { label: "记录决策", state: "missing" },
    parent: null
  });

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
