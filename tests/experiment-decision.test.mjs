import test from "node:test";
import assert from "node:assert/strict";
import {
  assessExperimentDecision,
  createExperimentDecision,
  experimentDataHealth,
  sanitizeExperimentDecision
} from "../src/experiment-decision.js";

const version = {
  testId: "TEST-001",
  sourceGeneratedAt: "2026-08-24T01:00:00.000Z",
  primaryVariable: "前三秒钩子",
  baselineCreative: "历史素材 A",
  minSpend: 300,
  planItem: { variant: "直接提出问题", observationMetrics: "CTR、ROI" }
};
const result = {
  importedAt: "2026-08-24T03:00:00.000Z",
  metrics: { spend: 400, roi: 1.8, ctr: 0.04 },
  qualityWarnings: []
};
const evaluation = { code: "target_met", label: "达到目标", detail: "ROI 达标" };

test("creates an explicit manual decision with an auditable evidence snapshot", () => {
  const decision = createExperimentDecision({
    outcome: "keep",
    primaryMetric: "roi",
    guardrailMetrics: ["ctr", "completionRate"],
    reason: "达到最低消耗且 ROI 达标，CTR 没有明显恶化。"
  }, { version, result, evaluation, targetRoi: 1.5 }, { decidedAt: "2026-08-24T04:00:00.000Z" });

  assert.equal(decision.method, "manual");
  assert.equal(decision.outcome, "keep");
  assert.deepEqual(decision.guardrailMetrics, ["ctr", "completionRate"]);
  assert.equal(decision.evidence.resultImportedAt, result.importedAt);
  assert.match(decision.evidence.fingerprint, /^evidence:[0-9a-f]{8}$/u);
  assert.deepEqual(assessExperimentDecision(decision, { version, result, evaluation, targetRoi: 1.5 }).code, "current");
});

test("marks a saved decision stale when its evidence or threshold changes", () => {
  const decision = createExperimentDecision({
    outcome: "continue",
    primaryMetric: "roi",
    guardrailMetrics: ["ctr"],
    reason: "样本仍需继续积累，暂不做保留或停止结论。"
  }, { version, result, evaluation, targetRoi: 1.5 }, { decidedAt: "2026-08-24T04:00:00.000Z" });

  assert.equal(assessExperimentDecision(decision, { version, result, evaluation, targetRoi: 1.6 }).code, "stale");
  assert.equal(assessExperimentDecision(decision, { version, result: { ...result, importedAt: "2026-08-25T03:00:00.000Z" }, evaluation, targetRoi: 1.5 }).stale, true);
  assert.equal(assessExperimentDecision(decision, {
    version: { ...version, planItem: { ...version.planItem, hypothesis: "改成新的验证假设" } },
    result,
    evaluation,
    targetRoi: 1.5
  }).stale, true);
  assert.equal(assessExperimentDecision(null, { version, result, evaluation, targetRoi: 1.5 }).code, "missing");
});

test("fails closed for unsafe, ambiguous or tampered decisions", () => {
  const context = { version, result, evaluation, targetRoi: 1.5 };
  assert.throws(() => createExperimentDecision({ outcome: "keep", primaryMetric: "roi", guardrailMetrics: ["roi"], reason: "理由足够清楚" }, context), /主指标/u);
  assert.throws(() => createExperimentDecision({ outcome: "keep", primaryMetric: "roi", guardrailMetrics: ["ctr", "ctr"], reason: "理由足够清楚" }, context), /重复/u);
  assert.throws(() => createExperimentDecision({ outcome: "auto", primaryMetric: "roi", reason: "理由足够清楚" }, context), /结论/u);
  assert.throws(() => createExperimentDecision({ outcome: "stop", primaryMetric: "roi", reason: "短" }, context), /至少/u);
  assert.throws(() => createExperimentDecision({ outcome: "stop", primaryMetric: "roi", reason: "<script>alert(1)</script>" }, context), /不安全/u);

  const valid = createExperimentDecision({ outcome: "stop", primaryMetric: "roi", reason: "口径风险尚未解决，因此停止当前测试。" }, context, { decidedAt: "2026-08-24T04:00:00.000Z" });
  assert.throws(() => sanitizeExperimentDecision({ ...valid, evidence: { ...valid.evidence, fingerprint: "evidence:0000000x" } }), /指纹/u);
  assert.throws(() => sanitizeExperimentDecision({ ...valid, unexpected: true }), /未知字段/u);
});

test("reports data health separately from the human decision", () => {
  assert.deepEqual(experimentDataHealth({ result: null, evaluation: { code: "pending" } }), { code: "pending", label: "等待结果", ready: false });
  assert.equal(experimentDataHealth({ result, evaluation: { code: "insufficient" } }).code, "insufficient");
  assert.equal(experimentDataHealth({ result: { ...result, qualityWarnings: ["roi_mismatch"] }, evaluation }).code, "warning");
  assert.equal(experimentDataHealth({ result, evaluation }).ready, true);
});
