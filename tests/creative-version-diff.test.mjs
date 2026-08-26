import test from "node:test";
import assert from "node:assert/strict";
import { CREATIVE_VERSION_DIFF_EXCERPT_LIMIT, buildCreativeVersionDiff } from "../src/creative-version-diff.js";

function planItem(overrides = {}) {
  return {
    variant: "旧钩子",
    audience: "通勤人群",
    hook: "旧钩子",
    coreClaim: "真实体验",
    scene: "地铁",
    fixedElements: "事实口径与行动引导、目标受众、核心主张、拍摄场景",
    observationMetrics: "3 秒留存、CTR，辅助观察 ROI",
    production: {
      spokenScript: "旧口播",
      storyboard: "旧分镜",
      shootingTask: "旧拍摄任务",
      editingNotes: "旧剪辑要求",
      subtitleHighlights: "旧字幕",
      complianceChecklist: "旧合规检查",
      ...(overrides.production || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "production"))
  };
}

function entry(testId, {
  projectId = "prj_12345678",
  parentVersionId = null,
  primaryVariable = "前三秒钩子",
  baselineCreative = "母版 A",
  minSpend = 300,
  item = planItem()
} = {}) {
  return { version: { projectId, testId, parentVersionId, primaryVariable, baselineCreative, minSpend, planItem: item } };
}

test("returns no content diff for a root version", () => {
  const root = entry("ROOT");
  assert.equal(buildCreativeVersionDiff(root, [root]), null);
});

test("accepts one declared semantic change and its production consequences", () => {
  const parent = entry("PARENT");
  const child = entry("CHILD", {
    parentVersionId: "PARENT",
    item: planItem({
      variant: "新钩子",
      hook: "新钩子",
      production: { spokenScript: "新口播", storyboard: "新分镜", subtitleHighlights: "新字幕" }
    })
  });
  const diff = buildCreativeVersionDiff(child, [child, parent]);
  assert.equal(diff.code, "aligned");
  assert.equal(diff.variantConsistent, true);
  assert.deepEqual(diff.semanticChanges.map((change) => change.key), ["hook"]);
  assert.deepEqual(diff.productionChanges.map((change) => change.key), ["spokenScript", "storyboard", "subtitleHighlights"]);
});

test("flags an additional semantic variable and changed test guardrails", () => {
  const parent = entry("PARENT");
  const child = entry("CHILD", {
    parentVersionId: "PARENT",
    baselineCreative: "母版 B",
    item: planItem({ variant: "新钩子", hook: "新钩子", scene: "办公室", fixedElements: "已改变" })
  });
  const diff = buildCreativeVersionDiff(child, [child, parent]);
  assert.equal(diff.code, "needs_review");
  assert.match(diff.label, /拍摄场景/u);
  assert.match(diff.label, /基线素材/u);
  assert.match(diff.label, /保持不变项/u);
});

test("flags a declared variable that did not visibly change or disagrees with its value", () => {
  const parent = entry("PARENT");
  const productionOnly = entry("PRODUCTION", { parentVersionId: "PARENT", item: planItem({ production: { spokenScript: "只改了口播" } }) });
  assert.equal(buildCreativeVersionDiff(productionOnly, [productionOnly, parent]).code, "primary_unchanged");
  const mismatch = entry("MISMATCH", { parentVersionId: "PARENT", item: planItem({ variant: "声明值", hook: "另一个值" }) });
  assert.equal(buildCreativeVersionDiff(mismatch, [mismatch, parent]).code, "needs_review");
  assert.equal(buildCreativeVersionDiff(mismatch, [mismatch, parent]).variantConsistent, false);
});

test("bounds displayed excerpts and reports unchanged content honestly", () => {
  const parent = entry("PARENT");
  const unchanged = entry("UNCHANGED", { parentVersionId: "PARENT" });
  assert.equal(buildCreativeVersionDiff(unchanged, [unchanged, parent]).code, "unchanged");
  const longText = "字".repeat(CREATIVE_VERSION_DIFF_EXCERPT_LIMIT + 50);
  const child = entry("CHILD", { parentVersionId: "PARENT", item: planItem({ variant: "新钩子", hook: "新钩子", production: { spokenScript: longText } }) });
  const spoken = buildCreativeVersionDiff(child, [child, parent]).productionChanges.find((change) => change.key === "spokenScript");
  assert.equal(spoken.after.length, CREATIVE_VERSION_DIFF_EXCERPT_LIMIT);
  assert.ok(spoken.after.endsWith("…"));
});

test("isolates parent lookup by project and fails closed for malformed input", () => {
  const child = entry("CHILD", { parentVersionId: "PARENT" });
  const foreignParent = entry("PARENT", { projectId: "prj_87654321" });
  assert.equal(buildCreativeVersionDiff(child, [child, foreignParent]).code, "parent_missing");
  assert.throws(() => buildCreativeVersionDiff({}, []), /当前拍摄方案/u);
  assert.throws(() => buildCreativeVersionDiff(child, {}), /时间线格式/u);
});
