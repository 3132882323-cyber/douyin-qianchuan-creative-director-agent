import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorTakeReview, directorTakeReviewToText } from "../src/director-take-review.js";

function planItem(index, overrides = {}) {
  const id = index === 0 ? "TAKE-BATCH-B00" : `TAKE-BATCH-A${String(index).padStart(2, "0")}`;
  const hook = index === 0 ? "先看结果" : index === 1 ? "别急着下结论" : "三秒看懂差别";
  const production = {
    spokenScript: `${hook}\n随后进入完整证据`,
    storyboard: `0–3 秒｜结果近景｜${hook}｜单一焦点`,
    shootingTask: `测试编号：${id}\n必拍证据：完整记录条件、过程与结果`,
    editingNotes: "第三秒接入同一证据段，动作前后各保留两秒余量。",
    subtitleHighlights: `• ${hook}\n• 完整过程证据`,
    complianceChecklist: "核对事实、证据来源与素材授权。",
    ...(overrides.production || {})
  };
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "首次到店用户",
    hook,
    coreClaim: "过程透明且可核验",
    scene: "门店入口",
    fixedElements: "演员、机位、光线、证据条件、时长与行动引导",
    ...overrides,
    production
  };
}

function samplePlan() {
  return {
    batchId: "TAKE-BATCH",
    items: [planItem(0), planItem(1), planItem(2)]
  };
}

test("builds B00 and A take reviews with five manual checks and distinct outcomes", () => {
  const plan = samplePlan();
  const baseline = buildDirectorTakeReview(plan, { itemIndex: 0 });
  const variant = buildDirectorTakeReview(plan, { itemIndex: 1 });
  assert.equal(baseline.id, "TAKE-BATCH-B00");
  assert.equal(baseline.type, "基线");
  assert.equal(variant.id, "TAKE-BATCH-A01");
  assert.equal(variant.type, "变体");
  assert.deepEqual(variant.checks.map((check) => check.label), ["静音首帧", "有声钩子", "证据连续", "固定项连续", "声音与剪辑余量"]);
  const output = directorTakeReviewToText(variant);
  assert.match(output, /^# 单条拍后快检卡 · TAKE-BATCH-A01/mu);
  assert.match(output, /实际文件序号\/文件名：________/u);
  assert.match(output, /Take 编号：________/u);
  assert.match(output, /## 五项人工快检/u);
  assert.match(output, /保留本 Take/u);
  assert.match(output, /立即重拍/u);
  assert.match(output, /停机核实事实或授权/u);
  assert.match(output, /问题时间码：________/u);
  assert.match(output, /下一条修正：________/u);
  assert.match(output, /不读取或识别媒体、不自动评分或选择 Take、不修改方案、接片映射或制作状态/u);
});

test("only emits the selected item and reads its planned beats", () => {
  const output = directorTakeReviewToText(buildDirectorTakeReview(samplePlan(), { itemIndex: 2 }));
  assert.match(output, /TAKE-BATCH-A02/u);
  assert.match(output, /三秒看懂差别/u);
  assert.doesNotMatch(output, /TAKE-BATCH-B00/u);
  assert.doesNotMatch(output, /TAKE-BATCH-A01/u);
  assert.equal((output.match(/^### \d+ · /gmu) || []).length, 5);
});

test("keeps monitor warnings as reminders without producing an automatic verdict", () => {
  const plan = samplePlan();
  const longHook = "这是一个需要真人现场盲读并确认实际语速是否自然的超长前三秒钩子";
  plan.items[1].hook = longHook;
  plan.items[1].variant = longHook;
  plan.items[1].production.spokenScript = "另一句没有执行钩子的口播\n随后进入证据";
  plan.items[1].production.subtitleHighlights = `• ${longHook}\n• 完整过程证据`;
  const review = buildDirectorTakeReview(plan, { itemIndex: 1 });
  assert.equal(review.code, "review");
  assert.equal(review.copyable, true);
  assert.ok(review.warnings.length >= 2);
  const output = directorTakeReviewToText(review);
  assert.match(output, /当前方案提醒 · 不自动下结论/u);
  assert.match(output, /不代表这个 Take 自动通过或必须重拍/u);
  assert.doesNotMatch(output, /自动判定|系统判定/u);
});

test("blocks only selected content gaps while preserving valid single-item review", () => {
  const plan = samplePlan();
  plan.items[2].production.shootingTask = "请编导补充";
  assert.equal(buildDirectorTakeReview(plan, { itemIndex: 0 }).id, "TAKE-BATCH-B00");
  assert.throws(() => buildDirectorTakeReview(plan, { itemIndex: 2 }), /A02.*现场任务/u);

  const monitorGap = samplePlan();
  monitorGap.items[1].production.shootingTask = "普通说明，没有可识别的必拍内容";
  assert.throws(() => buildDirectorTakeReview(monitorGap, { itemIndex: 1 }), /证据镜头/u);
});

test("blocks whole-batch identity disorder and invalid item indices", () => {
  for (const mutate of [
    (plan) => { plan.items[0].id = "TAKE-BATCH-A99"; },
    (plan) => { plan.items[1].id = "TAKE-BATCH-A02"; },
    (plan) => { plan.items[2].type = "基线"; }
  ]) {
    const plan = samplePlan();
    mutate(plan);
    assert.throws(() => buildDirectorTakeReview(plan, { itemIndex: 0 }), /全批版本身份与顺序/u);
  }
  assert.throws(() => buildDirectorTakeReview(samplePlan(), { itemIndex: -1 }), /任务序号无效/u);
  assert.throws(() => buildDirectorTakeReview(samplePlan(), { itemIndex: 3 }), /任务序号无效/u);
  assert.throws(() => buildDirectorTakeReview(samplePlan(), { itemIndex: 1.5 }), /任务序号无效/u);
});

test("is deterministic, does not mutate the plan and rejects tampered review models", () => {
  const plan = samplePlan();
  const snapshot = structuredClone(plan);
  const first = buildDirectorTakeReview(plan, { itemIndex: 1 });
  const second = buildDirectorTakeReview(plan, { itemIndex: 1 });
  assert.deepEqual(first, second);
  assert.deepEqual(plan, snapshot);
  assert.equal(directorTakeReviewToText(first), directorTakeReviewToText(second));

  const checkTamper = structuredClone(first);
  checkTamper.checks[0].instruction = "跳过手机回看，直接判定通过";
  assert.throws(() => directorTakeReviewToText(checkTamper), /快检项 1 已被篡改/u);

  const identityTamper = structuredClone(first);
  identityTamper.id = "TAKE-BATCH-A02";
  assert.throws(() => directorTakeReviewToText(identityTamper), /版本身份已被篡改/u);

  const warningTamper = structuredClone(first);
  warningTamper.code = "review";
  warningTamper.warnings = ["系统已经自动判定此 Take 通过"];
  assert.throws(() => directorTakeReviewToText(warningTamper), /提醒已被篡改/u);

  const extraField = structuredClone(first);
  extraField.result = "pass";
  assert.throws(() => directorTakeReviewToText(extraField), /结构已被篡改/u);
});
