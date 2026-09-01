import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectorBlindReview,
  directorBlindReviewDecisionSheetToText,
  directorBlindReviewKeyToText,
  directorBlindReviewPackToText
} from "../src/director-blind-review.js";

function item(index, overrides = {}) {
  const id = index === 0 ? "SECRET-B00" : `SECRET-A${String(index).padStart(2, "0")}`;
  const hook = overrides.hook || `${id} 先看变化，ROI：2.${index}`;
  const production = {
    spokenScript: `${hook}\n随后展示完整过程`,
    storyboard: `0-3秒｜内部母版甲的结果近景｜${hook}｜只留一个重点`,
    shootingTask: `测试编号：${id}\n必拍证据：过程特写，消耗：888`,
    editingNotes: "第三秒后立即进入证据动作。",
    subtitleHighlights: `• ${hook}\n• 过程证据 ¥888`,
    complianceChecklist: "核对事实与授权。",
    ...(overrides.production || {})
  };
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "内部母版甲",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "内部母版甲的目标受众",
    hook,
    scene: "真实使用现场",
    fixedElements: "演员、机位、光线、证据和行动引导",
    ...overrides,
    production
  };
}

function samplePlan(count = 4) {
  return {
    batchId: "SECRET-BATCH",
    items: Array.from({ length: count }, (_, index) => item(index))
  };
}

test("builds a deterministic anonymous review pack and keeps the baseline out of the first slot", () => {
  const plan = samplePlan();
  const original = structuredClone(plan);
  const first = buildDirectorBlindReview(plan);
  const second = buildDirectorBlindReview(plan);
  assert.deepEqual(second, first);
  assert.equal(first.code, "ready");
  assert.equal(first.cards.length, 4);
  assert.equal(first.answerKey[0].originalIndex === 0, false);
  assert.deepEqual(first.cards.map((card) => card.label), ["A", "B", "C", "D"]);
  assert.ok(first.cards.every((card) => !Object.hasOwn(card, "testId")));
  assert.deepEqual(plan, original);
});

test("removes source identity and performance values from the public pack but keeps a separate answer key", () => {
  const review = buildDirectorBlindReview(samplePlan());
  const publicText = directorBlindReviewPackToText({ ...review, answerKey: [{ label: "X", testId: "绝密映射" }] });
  for (const secret of ["SECRET-B00", "SECRET-A01", "SECRET-BATCH", "内部母版甲", "ROI:2.0", "ROI:2.1", "¥888", "绝密映射"]) {
    assert.doesNotMatch(publicText, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(publicText, /\[已隐藏来源\]/u);
  assert.match(publicText, /\[已隐藏指标\]/u);
  assert.match(publicText, /不询问作者、基线身份和历史表现/u);
  assert.match(publicText, /不复用原句的一个新开场/u);
  const key = directorBlindReviewKeyToText(review);
  assert.match(key, new RegExp(review.reviewId, "u"));
  assert.match(key, /SECRET-B00/u);
  assert.match(key, /必须在反馈锁定后查看/u);
});

test("changes the review id after creative content changes so stale mappings are visible", () => {
  const plan = samplePlan();
  const before = buildDirectorBlindReview(plan);
  plan.items[1].hook = "换成另一个前三秒开场";
  plan.items[1].production.spokenScript = "换成另一个前三秒开场\n随后展示完整过程";
  const after = buildDirectorBlindReview(plan);
  assert.notEqual(after.reviewId, before.reviewId);
  assert.match(directorBlindReviewPackToText(after), new RegExp(after.reviewId, "u"));
  assert.match(directorBlindReviewKeyToText(after), new RegExp(after.reviewId, "u"));
});

test("turns locked feedback into a private three-action director decision sheet without auto-selecting a winner", () => {
  const review = buildDirectorBlindReview(samplePlan());
  const sheet = directorBlindReviewDecisionSheetToText(review);
  assert.match(sheet, new RegExp(review.reviewId, "u"));
  assert.match(sheet, /方案 [A-D] → SECRET-(?:B00|A\d{2})/u);
  assert.match(sheet, /回收事实（先填，不下结论）/u);
  assert.match(sheet, /保留开拍/u);
  assert.match(sheet, /单变量重写/u);
  assert.match(sheet, /本轮淘汰/u);
  assert.match(sheet, /第一拍仍为批次基线/u);
  assert.match(sheet, /不保存反馈、不自动选优、不修改方案或制作状态/u);
  assert.doesNotMatch(sheet, /自动判定|爆款|胜率/u);
  const broken = structuredClone(review);
  broken.answerKey[0].label = broken.answerKey[1].label;
  assert.throws(() => directorBlindReviewDecisionSheetToText(broken), /重复的盲审标签/u);
});

test("fails closed for incomplete, undersized, excessive or overlong reviews", () => {
  const incompletePlan = samplePlan();
  incompletePlan.items[2].production.shootingTask = "只有普通拍摄说明";
  const incomplete = buildDirectorBlindReview(incompletePlan);
  assert.equal(incomplete.copyable, false);
  assert.ok(incomplete.blockers.some((blocker) => /证据镜头/u.test(blocker)));
  assert.throws(() => directorBlindReviewPackToText(incomplete), /拍前盲审仍待补/u);
  assert.throws(() => buildDirectorBlindReview(samplePlan(1)), /2–12/u);
  assert.throws(() => buildDirectorBlindReview(samplePlan(13)), /2–12/u);
  const overlong = samplePlan();
  const text = "长".repeat(801);
  overlong.items[0].hook = text;
  overlong.items[0].production.spokenScript = `${text}\n继续`;
  assert.throws(() => buildDirectorBlindReview(overlong), /盲审字段过长/u);
});
