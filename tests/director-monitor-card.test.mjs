import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorMonitorCard, directorMonitorCardToText } from "../src/director-monitor-card.js";

function planItem(overrides = {}) {
  const production = {
    spokenScript: "先看结果\n随后说明真实过程",
    storyboard: "0-3秒｜结果近景｜先看结果｜只留一个信息点\n3-8秒｜展示过程",
    shootingTask: "测试编号：TEST-B00\n必拍证据：同条件过程特写",
    editingNotes: "第三秒立即承接完整过程，不用无关转场。",
    subtitleHighlights: "• 先看结果\n• 真实过程",
    complianceChecklist: "核对事实、授权与表达。",
    ...(overrides.production || {})
  };
  return {
    id: "TEST-B00",
    type: "基线",
    singleVariable: "前三秒钩子",
    variant: "先看结果",
    audience: "正在解决具体问题的人",
    hook: "先看结果",
    scene: "真实使用现场",
    fixedElements: "演员、机位、光线、证据与行动引导",
    ...overrides,
    production
  };
}

test("builds a one-page first-three-second monitor card without mutating the plan", () => {
  const plan = { items: [planItem(), planItem({ id: "TEST-A01", type: "变体" })] };
  const original = structuredClone(plan);
  const card = buildDirectorMonitorCard(plan, { itemIndex: 0 });
  assert.equal(card.code, "ready");
  assert.equal(card.copyable, true);
  assert.equal(card.orderLabel, "先拍基线");
  assert.equal(card.beats.spokenOpening, "先看结果");
  assert.equal(card.beats.proofCue, "必拍证据:同条件过程特写");
  const output = directorMonitorCardToText(card);
  assert.match(output, /0\.0–1\.0 秒 · 首帧停滑/u);
  assert.match(output, /1\.0–3\.0 秒 · 信息闭环/u);
  assert.match(output, /3 秒后 · 证据承接/u);
  assert.match(output, /开机前五问/u);
  assert.match(output, /当场返拍触发/u);
  assert.match(output, /不自动评价创意优劣或预测效果/u);
  assert.deepEqual(plan, original);
});

test("surfaces hook, subtitle and first-frame execution risks without inventing a quality score", () => {
  const card = buildDirectorMonitorCard({ items: [planItem({
    hook: "这是一个需要真人认真完整读完才能知道到底发生了什么变化的特别长钩子",
    production: {
      spokenScript: "完全不同的口播开场\n随后说明真实过程",
      storyboard: `0-3秒｜${"很多信息".repeat(24)}｜多个焦点同时出现`,
      subtitleHighlights: `• ${"首屏信息".repeat(6)}`
    }
  })] }, { itemIndex: 0 });
  assert.equal(card.code, "review");
  assert.equal(card.copyable, true);
  assert.ok(card.warnings.some((warning) => /口播首句没有执行当前钩子/u.test(warning)));
  assert.ok(card.warnings.some((warning) => /真人按实际语速盲读计时/u.test(warning)));
  assert.ok(card.warnings.some((warning) => /手机尺寸停帧检查/u.test(warning)));
  assert.ok(card.warnings.some((warning) => /第一秒只有一个视觉焦点/u.test(warning)));
  assert.doesNotMatch(JSON.stringify(card), /score|评分/u);
});

test("fails closed when a critical on-set field is missing", () => {
  const card = buildDirectorMonitorCard({ items: [planItem({
    production: { shootingTask: "只有普通拍摄说明", editingNotes: "" }
  })] }, { itemIndex: 0 });
  assert.equal(card.code, "incomplete");
  assert.equal(card.copyable, false);
  assert.deepEqual(card.missing, ["证据镜头", "剪辑承接"]);
  assert.throws(() => directorMonitorCardToText(card), /证据镜头、剪辑承接/u);
});

test("rejects invalid indexes, excessive batches and oversized fields", () => {
  const plan = { items: [planItem()] };
  assert.throws(() => buildDirectorMonitorCard(plan), /任务序号/u);
  assert.throws(() => buildDirectorMonitorCard(plan, { itemIndex: 2 }), /任务序号/u);
  assert.throws(() => buildDirectorMonitorCard({ items: Array.from({ length: 101 }, () => planItem()) }, { itemIndex: 0 }), /有效拍摄任务/u);
  assert.throws(() => buildDirectorMonitorCard({ items: [planItem({ hook: "钩".repeat(1001) })] }, { itemIndex: 0 }), /处理上限/u);
});

test("blocks a monitor card whose displayed order contradicts batch identity", () => {
  const malformed = { items: [planItem({ id: "TEST-A99", type: "变体" })] };
  const card = buildDirectorMonitorCard(malformed, { itemIndex: 0 });
  assert.equal(card.copyable, false);
  assert.ok(card.missing.includes("版本身份与顺序"));
  assert.throws(() => directorMonitorCardToText(card), /版本身份与顺序/u);
});
