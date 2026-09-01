import test from "node:test";
import assert from "node:assert/strict";
import { buildInspirationRelay, inspirationCardToChallenge, inspirationRelayToText } from "../src/inspiration-relay.js";

function entry(testId, value, {
  evaluation = "pending",
  warnings = [],
  createdAt = "2026-09-02T01:00:00.000Z"
} = {}) {
  const batchId = "SECRET-BATCH";
  const baseline = /-B00$/u.test(testId);
  return {
    version: {
      testId,
      batchId,
      parentVersionId: null,
      createdAt,
      sourceGeneratedAt: createdAt,
      primaryVariable: "前三秒钩子",
      baselineCreative: "绝密素材名称",
      minSpend: 500,
      productionStatus: { stage: "ready", updatedAt: createdAt },
      planItem: {
        id: testId,
        type: baseline ? "基线" : "变体",
        baselineCreative: "绝密素材名称",
        singleVariable: "前三秒钩子",
        variant: value,
        audience: "秘密受众",
        hook: value,
        coreClaim: "秘密品牌主张",
        scene: "秘密场景",
        hypothesis: "秘密测试假设",
        fixedElements: "受众、主张、场景保持一致",
        observationMetrics: "CTR、ROI",
        minSpend: 500,
        stopCondition: "达到最低消耗后人工核对",
        successAction: "人工确认后再进入下一轮",
        production: { spokenScript: "这一段完整秘密脚本绝不能被分享" }
      }
    },
    result: warnings.length || evaluation !== "pending" ? { metrics: { spend: 987.65, roi: 1.88 }, qualityWarnings: warnings } : null,
    evaluation: { code: evaluation },
    decisionState: { code: "missing" }
  };
}

test("abstracts distinct transferable mechanisms from the latest local batch", () => {
  const timeline = [
    entry("SECRET-A02", "真实实测证据对比", { evaluation: "target_met" }),
    entry("SECRET-B00", "还在被通勤问题困扰？"),
    entry("SECRET-A01", "先看结果变化", { evaluation: "above_parent" }),
    entry("OLD-B00", "旧批次内容", { createdAt: "2026-09-01T01:00:00.000Z" })
  ];
  timeline.at(-1).version.batchId = "OLD-BATCH";
  const original = structuredClone(timeline);
  const relay = buildInspirationRelay(timeline, { targetRoi: 1.5 });
  assert.equal(relay.code, "ready");
  assert.deepEqual(relay.cards.map((card) => card.mechanismCode), ["problem_first", "result_first", "proof_first"]);
  assert.equal(relay.cards.at(-1).evidenceCode, "target_met");
  assert.deepEqual(timeline, original);
});

test("exports a privacy-safe inspiration pack instead of source copy", () => {
  const timeline = [
    entry("SECRET-B00", "先看结果：秘密品牌主张"),
    entry("SECRET-A01", "真实实测证据对比", { evaluation: "target_met" })
  ];
  const relay = buildInspirationRelay(timeline, { targetRoi: 1.5 });
  const text = inspirationRelayToText(relay);
  assert.match(text, /# 创意灵感接力包/u);
  assert.match(text, /至少改写受众、场景、证据、节奏与行动引导中的三项/u);
  assert.match(text, /不能证明此创意机制导致结果/u);
  assert.match(text, /不得据此复制他人素材/u);
  for (const secret of ["SECRET", "绝密素材名称", "秘密品牌主张", "秘密受众", "秘密场景", "完整秘密脚本", "987.65", "1.88"]) {
    assert.doesNotMatch(text, new RegExp(secret, "u"));
  }
});

test("deduplicates similar mechanisms and fails closed without a usable batch", () => {
  const relay = buildInspirationRelay([
    entry("SECRET-B00", "先看结果"),
    entry("SECRET-A01", "先看变化"),
    entry("SECRET-A02", "结果先行", { warnings: ["roi_mismatch"] })
  ], { targetRoi: 1.5 });
  assert.equal(relay.cards.length, 1);
  assert.equal(relay.cards[0].sourceCount, 3);
  assert.equal(relay.cards[0].evidenceCode, "quality_review");
  assert.equal(buildInspirationRelay([], { targetRoi: 1.5 }).code, "empty");
  assert.throws(() => buildInspirationRelay([{}], { targetRoi: 1.5 }), /无效测试版本/u);
  assert.throws(() => inspirationRelayToText({ cards: [] }), /没有可分享/u);
});

test("turns one safe mechanism into an actionable three-route co-creation challenge", () => {
  const relay = buildInspirationRelay([entry("SECRET-B00", "先看结果变化")], { targetRoi: 1.5 });
  const card = { ...relay.cards[0], mechanism: "绝密原文", question: "绝密问题", originalityMoves: ["绝密动作"] };
  const challenge = inspirationCardToChallenge(card);
  assert.match(challenge, /# 创意共创挑战 · 结果前置/u);
  assert.match(challenge, /## 三路发散/u);
  assert.match(challenge, /同机制异情境/u);
  assert.match(challenge, /反向机制/u);
  assert.match(challenge, /新证据路线/u);
  assert.match(challenge, /一句话测试假设：只声明一个主要变量/u);
  assert.match(challenge, /至少改变受众、场景、证据、节奏与行动引导中的三项/u);
  assert.doesNotMatch(challenge, /绝密/u);
  assert.throws(() => inspirationCardToChallenge({ variableCode: "hook", mechanismCode: "unknown", evidenceCode: "untested" }), /格式无效/u);
});
