import test from "node:test";
import assert from "node:assert/strict";
import { analyzeReport, normalizedStem, numberOf, parseCsv } from "../src/core.js";

test("parses quoted CSV", () => {
  const rows = parseCsv('素材名称,消耗,钩子\nA,100,"痛点,反问"\n');
  assert.equal(rows[0].钩子, "痛点,反问");
});

test("normalizes percentages and money", () => {
  assert.equal(numberOf("￥1,200"), 1200);
  assert.equal(numberOf("3.5%"), 0.035);
});

test("segments report and creates controlled matrix", () => {
  const rows = parseCsv("素材名称,消耗,GMV,支付ROI,人群,钩子,核心卖点,场景\nA,1200,2880,2.4,女性代买,痛点,舒适,卧室\nB,900,990,1.1,男性自购,参数,弹力,近景\nC,1100,2530,2.3,女性代买,结果,舒适,收纳\nD,120,90,0.75,泛人群,低价,促销,直播间\n");
  const result = analyzeReport(rows, 1.5);
  assert.equal(result.segments["高消耗且达标"], 2);
  assert.equal(result.segments["低曝光待验证"], 2);
  assert.equal(result.testMatrix.length, 4);
  assert.equal(new Set(result.testMatrix.map((row) => row.singleVariable)).size, 1);
});

test("normalizes downloaded file suffixes", () => {
  assert.equal(normalizedStem("creative-douyin.mp4"), "creative");
  assert.equal(normalizedStem("素材_副本.mov"), "素材");
});
