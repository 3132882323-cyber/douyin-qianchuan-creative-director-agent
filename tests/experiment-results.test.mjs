import test from "node:test";
import assert from "node:assert/strict";
import { parseExperimentResults, parseManualExperimentResult } from "../src/experiment-results.js";

test("matches result rows only by known test id and normalizes optional metrics", () => {
  const parsed = parseExperimentResults(`测试编号,消耗,成交金额,CTR,完播率\nTEST-1,"1,000",1800,3.5%,25%\nUNKNOWN,200,100,2%,10%`, ["TEST-1"]);
  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.matched.length, 1);
  assert.equal(parsed.unmatched[0].testId, "UNKNOWN");
  assert.equal(parsed.matched[0].metrics.spend, 1000);
  assert.equal(parsed.matched[0].metrics.ctr, 0.035);
  assert.equal(parsed.matched[0].metrics.completionRate, 0.25);
  assert.match(parsed.notice, /不代表.*因果/u);
});

test("fails closed without required columns, spend, valid rates or unique ids", () => {
  assert.throws(() => parseExperimentResults("编号,ROI\nA,1.5", ["A"]), /测试编号.*消耗/u);
  assert.throws(() => parseExperimentResults("测试编号,消耗\nA,", ["A"]), /缺少消耗/u);
  assert.throws(() => parseExperimentResults("测试编号,消耗,CTR\nA,10,150%", ["A"]), /0%.*100%/u);
  assert.throws(() => parseExperimentResults("测试编号,消耗\nA,10\nA,20", ["A"]), /重复测试编号/u);
});

test("rejects impossible funnels and surfaces material metric-definition differences", () => {
  assert.throws(() => parseExperimentResults("测试编号,消耗,展示,点击\nA,10,100,101", ["A"]), /点击量不能大于展示量/u);
  assert.throws(() => parseExperimentResults("测试编号,消耗,点击,转化\nA,10,5,6", ["A"]), /转化量不能大于点击量/u);
  const parsed = parseExperimentResults("测试编号,消耗,成交金额,ROI,展示,点击,CTR\nA,100,200,7,1000,100,1%", ["A"]);
  assert.equal(parsed.warnings.length, 2);
  assert.deepEqual(parsed.warnings.map((entry) => entry.field), ["roi", "ctr"]);
  assert.deepEqual(parsed.matched[0].qualityWarnings, ["roi_mismatch", "ctr_mismatch"]);
  assert.match(parsed.notice, /人工核对/u);
});

test("validates a single manual result with the same rate and quality rules", () => {
  const parsed = parseManualExperimentResult({
    testId: "TEST-1",
    spend: "400",
    gmv: "720",
    roi: "1.8",
    impressions: "10000",
    clicks: "400",
    conversions: "20",
    ctr: "4%",
    cvr: "5%",
    threeSecondRate: "32.5%",
    completionRate: "0.18"
  }, ["TEST-1"]);
  assert.equal(parsed.inputMode, "manual");
  assert.equal(parsed.matched[0].metrics.ctr, 0.04);
  assert.equal(parsed.matched[0].metrics.completionRate, 0.18);
  assert.deepEqual(parsed.matched[0].qualityWarnings, []);
  assert.match(parsed.notice, /当前项目/u);
});

test("manual result fails closed before it can replace a stored result", () => {
  assert.throws(() => parseManualExperimentResult({ testId: "UNKNOWN", spend: "100" }, ["TEST-1"]), /不属于当前项目/u);
  assert.throws(() => parseManualExperimentResult({ testId: "TEST-1", spend: "" }, ["TEST-1"]), /缺少消耗/u);
  assert.throws(() => parseManualExperimentResult({ testId: "TEST-1", spend: "100", impressions: "10", clicks: "11" }, ["TEST-1"]), /点击量不能大于展示量/u);
  assert.throws(() => parseManualExperimentResult({ testId: "TEST-1", spend: "100", unexpected: "drop" }, ["TEST-1"]), /未知字段/u);
});
