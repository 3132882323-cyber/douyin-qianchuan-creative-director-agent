import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeReport,
  generateCreativePlan,
  inspectColumnMapping,
  normalizedStem,
  numberOf,
  parseCsv,
  parseCsvDocument,
  planToCsv,
  planToMarkdown,
  resolveColumns,
  toMarkdown
} from "../src/core.js";

const reportText = "素材名称,消耗,展示量,点击量,成交订单,GMV,支付ROI,人群,钩子,核心卖点,场景\nA,1200,80000,2400,96,2880,2.4,女性代买,痛点开场,透气舒适,卧室\nB,900,60000,1500,38,990,1.1,男性自购,参数开场,弹力不勒,近景\nC,1100,70000,2240,82,2530,2.3,女性代买,结果展示,透气舒适,收纳\nD,120,9000,210,5,90,0.75,泛人群,低价促销,价格权益,直播间\n";

const brief = {
  productName: "凉感家居服",
  category: "服饰",
  targetAudience: "怕闷热的女性、给伴侣购买的人",
  painPoints: "夏天闷热、普通面料勒身",
  sellingPoints: "凉感透气、弹力不勒",
  evidence: "面料近景、真人穿着实测",
  promotion: "两件组合装，价格以商品页为准",
  shootingConditions: "卧室整理、真人试穿",
  forbiddenExpressions: "全网最低、百分百凉感",
  duration: 30
};

test("parses quoted CSV and tab-separated files", () => {
  const rows = parseCsv('素材名称,消耗,钩子\nA,100,"痛点,反问"\n');
  assert.equal(rows[0].钩子, "痛点,反问");
  const document = parseCsvDocument("素材名称\t消耗\nA\t100\n");
  assert.deepEqual(document.headers, ["素材名称", "消耗"]);
  assert.equal(document.rows[0].消耗, "100");
});

test("normalizes percentages and formatted money", () => {
  assert.equal(numberOf("￥1,200"), 1200);
  assert.equal(numberOf("3.5%"), 0.035);
  assert.equal(numberOf("--"), 0);
});

test("recognizes common Qianchuan aliases and reports missing fields", () => {
  const complete = inspectColumnMapping(["广告创意名称", "总消耗", "整体支付ROI", "曝光量"]);
  assert.equal(complete.mapping.creativeName, "广告创意名称");
  assert.equal(complete.mapping.spend, "总消耗");
  assert.equal(complete.mapping.roi, "整体支付ROI");
  assert.deepEqual(complete.missingRequired, []);
  assert.throws(() => resolveColumns(["素材名称"]), /消耗/);
});

test("supports an explicit column mapping", () => {
  const mapping = resolveColumns(["名称列", "费用列"], { creativeName: "名称列", spend: "费用列" });
  assert.deepEqual(mapping, { creativeName: "名称列", spend: "费用列" });
});

test("segments report, calculates confidence and keeps editable tags", () => {
  const result = analyzeReport(parseCsv(reportText), 1.5);
  assert.equal(result.segments["高消耗且达标"], 2);
  assert.equal(result.segments["低曝光待验证"], 2);
  assert.equal(result.summary.creativeCount, 4);
  assert.equal(result.topCreatives[0].confidence, "高");
  assert.match(result.topCreatives[0].diagnosis, /基线/);
  assert.equal(result.tagInsights.hook[0].value, "痛点开场");
});

test("generates a controlled strategy from Brief and historical data", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const plan = generateCreativePlan(brief, analysis, { testVariable: "hook", minSpend: 500 });
  assert.equal(plan.items.length, 4);
  assert.equal(new Set(plan.items.map((item) => item.singleVariable)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.audience)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.sellingPoint)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.scene)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.hook)).size, 4);
  assert.equal(plan.items[1].minSpend, 500);
  assert.match(plan.items[1].hypothesis, /仅将前三秒钩子改为/);
  assert.match(plan.items[1].stopCondition, /基线 80%/);
});

test("generates editable production materials and export formats", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const plan = generateCreativePlan(brief, analysis, { testVariable: "sellingPoint", minSpend: 400 });
  const production = plan.items[0].production;
  assert.match(production.spokenScript, /凉感家居服/);
  assert.match(production.storyboard, /0-3秒/);
  assert.match(production.shootingTask, /测试编号/);
  assert.match(production.editingNotes, /30 秒/);
  assert.match(production.complianceChecklist, /全网最低/);
  assert.match(planToMarkdown(plan), /下一批素材拍摄方案/);
  assert.ok(planToCsv(plan).startsWith("\uFEFF测试编号"));
  assert.match(toMarkdown(analysis), /优先复盘素材/);
});

test("rejects plan generation without the required workflow state", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  assert.throws(() => generateCreativePlan({}, analysis), /商品名称/);
  assert.throws(() => generateCreativePlan(brief, null), /素材复盘/);
});

test("normalizes downloaded file suffixes", () => {
  assert.equal(normalizedStem("creative-douyin.mp4"), "creative");
  assert.equal(normalizedStem("素材_副本.mov"), "素材");
});
