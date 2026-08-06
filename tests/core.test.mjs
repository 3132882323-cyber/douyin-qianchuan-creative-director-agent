import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeReport,
  creativePlanDependencyFingerprint,
  creativePlanDependencySnapshot,
  generateCreativePlan,
  inspectColumnMapping,
  migrateLegacyProductBrief,
  normalizedStem,
  numberOf,
  parseCsv,
  parseCsvDocument,
  planToCsv,
  planToMarkdown,
  resolveColumns,
  toMarkdown
} from "../src/core.js";

const reportText = "素材名称,消耗,展示量,点击量,成交订单,GMV,支付ROI,人群,钩子,核心主张,场景\nA,1200,80000,2400,96,2880,2.4,女性代买,痛点开场,透气舒适,卧室\nB,900,60000,1500,38,990,1.1,男性自购,参数开场,弹力不勒,近景\nC,1100,70000,2240,82,2530,2.3,女性代买,结果展示,透气舒适,收纳\nD,120,9000,210,5,90,0.75,泛人群,直接行动,补充证据,直播间\n";

const creativeTask = {
  subject: "夏日通勤真实体验",
  targetAudience: "怕闷热的女性、给伴侣购买的人",
  creativeGoal: "用真实过程说明体验变化",
  audienceProblems: "夏天闷热、普通面料勒身",
  coreClaim: "凉感透气、弹力不勒",
  evidence: "面料近景、真人穿着实测",
  shootingConstraints: "卧室整理、真人试穿",
  riskNotes: "不得承诺百分百凉感",
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

test("generates a controlled strategy from an optional creative task and historical data", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const plan = generateCreativePlan(creativeTask, analysis, { testVariable: "hook", minSpend: 500 });
  assert.equal(plan.items.length, 4);
  assert.equal(new Set(plan.items.map((item) => item.singleVariable)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.audience)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.coreClaim)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.scene)).size, 1);
  assert.equal(new Set(plan.items.map((item) => item.hook)).size, 4);
  assert.equal(plan.items[1].minSpend, 500);
  assert.match(plan.items[1].hypothesis, /仅将前三秒钩子改为/);
  assert.match(plan.items[1].stopCondition, /基线 80%/);
  assert.equal(plan.version, "1.0.3");
  assert.match(plan.dependencyFingerprint, /^fnv1a32:[0-9a-f]{8}$/u);
});

test("fingerprints every normalized dependency that can make a saved plan stale", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const options = { testVariable: "hook", minSpend: 500 };
  const base = creativePlanDependencyFingerprint(creativeTask, analysis, options);
  const normalized = creativePlanDependencySnapshot(
    { ...creativeTask, subject: `  ${creativeTask.subject}  ` },
    { ...structuredClone(analysis), columns: Object.fromEntries(Object.entries(analysis.columns).map(([key, value]) => [key, ` ${value} `])) },
    options
  );
  assert.equal(creativePlanDependencyFingerprint(normalized.creativeTask, normalized.analysis, options), base);

  const mutations = [
    (value) => value.topCreatives.reverse(),
    (value) => { value.topCreatives[0].hook = "另一种钩子"; },
    (value) => { value.columns.creativeName = "另一列"; },
    (value) => { value.summary.targetRoi += 0.1; },
    (value) => { value.tagInsights.hook[0].value = "另一标签"; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(analysis);
    mutate(changed);
    assert.notEqual(creativePlanDependencyFingerprint(creativeTask, changed, options), base);
  }
  assert.notEqual(creativePlanDependencyFingerprint({ ...creativeTask, subject: "另一主题" }, analysis, options), base);
  assert.notEqual(creativePlanDependencyFingerprint(creativeTask, analysis, { ...options, testVariable: "scene" }), base);
  assert.notEqual(creativePlanDependencyFingerprint(creativeTask, analysis, { ...options, minSpend: 550 }), base);
});

test("generates editable production materials and export formats", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const plan = generateCreativePlan(creativeTask, analysis, { testVariable: "sellingPoint", minSpend: 400 });
  const production = plan.items[0].production;
  assert.match(production.spokenScript, /夏日通勤真实体验/);
  assert.match(production.storyboard, /0-3秒/);
  assert.match(production.shootingTask, /测试编号/);
  assert.match(production.editingNotes, /30 秒/);
  assert.match(production.complianceChecklist, /不得承诺百分百凉感/);
  assert.match(planToMarkdown(plan), /下一版素材任务/);
  assert.match(planToMarkdown(plan), /核心主张/);
  assert.ok(planToCsv(plan).startsWith("\uFEFF测试编号"));
  assert.match(planToCsv(plan), /目标受众,钩子,核心主张/);
  assert.doesNotMatch(JSON.stringify(plan), /productName|category|promotion|productBrief|"brief"/u);
  assert.match(toMarkdown(analysis), /优先复盘素材/);
});

test("generates without any task fields and only requires a completed review", () => {
  const analysis = analyzeReport(parseCsv(reportText), 1.5);
  const plan = generateCreativePlan({}, analysis);
  assert.equal(plan.items.length, 4);
  assert.match(plan.items[0].id, /^MAT[A-Z0-9]{7}-HOOK-B00$/);
  assert.equal(plan.creativeTask.subject, "");
  const otherAnalysis = structuredClone(analysis);
  otherAnalysis.topCreatives[0].creativeName = "另一条基线素材";
  assert.notEqual(generateCreativePlan({}, otherAnalysis).items[0].id, plan.items[0].id);
  assert.throws(() => generateCreativePlan(creativeTask, null), /素材复盘/);
});

test("migrates legacy task context without keeping it as an active dependency", () => {
  const migrated = migrateLegacyProductBrief({
    productName: "旧主题",
    targetAudience: "旧受众",
    painPoints: "旧问题",
    sellingPoints: "旧主张",
    evidence: "旧证据",
    shootingConditions: "旧限制",
    forbiddenExpressions: "旧风险",
    duration: 60,
    category: "仅归档"
  });
  assert.equal(migrated.subject, "旧主题");
  assert.equal(migrated.audienceProblems, "旧问题");
  assert.equal(migrated.coreClaim, "旧主张");
  assert.equal(migrated.shootingConstraints, "旧限制");
  assert.equal(migrated.duration, 60);
  assert.equal(migrated._migration.archivedLegacyData.category, "仅归档");
});

test("normalizes downloaded file suffixes", () => {
  assert.equal(normalizedStem("creative-douyin.mp4"), "creative");
  assert.equal(normalizedStem("素材_副本.mov"), "素材");
});
