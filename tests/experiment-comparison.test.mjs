import test from "node:test";
import assert from "node:assert/strict";
import { buildExperimentParentComparison } from "../src/experiment-comparison.js";

function entry(testId, {
  projectId = "prj_12345678",
  parentVersionId = null,
  minSpend = 300,
  metrics = null
} = {}) {
  return {
    version: { projectId, testId, parentVersionId, minSpend },
    result: metrics ? { metrics } : null
  };
}

test("returns no comparison for a root version", () => {
  const root = entry("ROOT", { metrics: { spend: 400, roi: 1.4 } });
  assert.equal(buildExperimentParentComparison(root, [root]), null);
});

test("reports missing current or parent results without inventing a delta", () => {
  const parent = entry("PARENT", { metrics: { spend: 400, roi: 1.4 } });
  const child = entry("CHILD", { parentVersionId: "PARENT" });
  const currentMissing = buildExperimentParentComparison(child, [child, parent]);
  assert.equal(currentMissing.code, "current_result_missing");
  assert.deepEqual(currentMissing.metrics, []);

  const parentMissing = entry("PARENT");
  const childReady = entry("CHILD", { parentVersionId: "PARENT", metrics: { spend: 400, roi: 1.6 } });
  assert.equal(buildExperimentParentComparison(childReady, [childReady, parentMissing]).code, "parent_result_missing");
});

test("waits until both versions reach their own minimum spend", () => {
  const parentLow = entry("PARENT", { minSpend: 500, metrics: { spend: 400, roi: 1.4 } });
  const childLow = entry("CHILD", { parentVersionId: "PARENT", minSpend: 500, metrics: { spend: 400, roi: 1.6 } });
  assert.equal(buildExperimentParentComparison(childLow, [childLow, parentLow]).code, "current_insufficient");
  const childReady = entry("CHILD", { parentVersionId: "PARENT", metrics: { spend: 500, roi: 1.6 } });
  assert.equal(buildExperimentParentComparison(childReady, [childReady, parentLow]).code, "parent_insufficient");
});

test("does not calculate deltas while either result has a metric-definition warning", () => {
  const parent = entry("PARENT", { metrics: { spend: 400, roi: 1.4 } });
  const child = entry("CHILD", { parentVersionId: "PARENT", metrics: { spend: 400, roi: 1.6 } });
  child.result.qualityWarnings = ["roi_mismatch"];
  assert.equal(buildExperimentParentComparison(child, [child, parent]).code, "current_quality_warning");
  child.result.qualityWarnings = [];
  parent.result.qualityWarnings = ["roi_mismatch"];
  assert.equal(buildExperimentParentComparison(child, [child, parent]).code, "parent_quality_warning");
});

test("builds descriptive ROI and percentage-point deltas", () => {
  const parent = entry("PARENT", { metrics: { spend: 400, roi: 1.4, ctr: 0.04, cvr: 0.1 } });
  const child = entry("CHILD", { parentVersionId: "PARENT", metrics: { spend: 450, roi: 1.6, ctr: 0.035, cvr: 0.12 } });
  const comparison = buildExperimentParentComparison(child, [child, parent]);
  assert.equal(comparison.ready, true);
  assert.equal(comparison.summary, "ROI +0.20 · CTR -0.50pp");
  assert.deepEqual(comparison.metrics.map(({ key, currentDisplay, parentDisplay, deltaDisplay }) => ({ key, currentDisplay, parentDisplay, deltaDisplay })), [
    { key: "roi", currentDisplay: "1.60", parentDisplay: "1.40", deltaDisplay: "+0.20" },
    { key: "ctr", currentDisplay: "3.50%", parentDisplay: "4.00%", deltaDisplay: "-0.50pp" },
    { key: "cvr", currentDisplay: "12.00%", parentDisplay: "10.00%", deltaDisplay: "+2.00pp" }
  ]);
  assert.match(comparison.notice, /不证明因果、统计显著性或胜负/u);
  const almostEqual = entry("ALMOST", { parentVersionId: "PARENT", metrics: { spend: 450, roi: 1.40001 } });
  assert.equal(buildExperimentParentComparison(almostEqual, [almostEqual, parent]).metrics[0].deltaDisplay, "0.00");
});

test("isolates parent lookup by project and fails closed for invalid inputs", () => {
  const foreignParent = entry("PARENT", { projectId: "prj_87654321", metrics: { spend: 400, roi: 9 } });
  const child = entry("CHILD", { parentVersionId: "PARENT", metrics: { spend: 400, roi: 1.6 } });
  assert.equal(buildExperimentParentComparison(child, [child, foreignParent]).code, "parent_missing");
  assert.throws(() => buildExperimentParentComparison({}, []), /当前测试编号/u);
  assert.throws(() => buildExperimentParentComparison(child, {}), /时间线格式/u);
});
