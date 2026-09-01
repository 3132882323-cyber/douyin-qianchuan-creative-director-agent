import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OPERATOR_BATCH_VERSIONS,
  buildLatestOperatorBatchHandoff,
  latestOperatorBatchToText
} from "../src/operator-batch-handoff.js";

function planItem({ type = "变体", hook = "结果先行", variant = hook, stopCondition = "达到最低消耗后人工核对 ROI" } = {}) {
  return {
    id: "placeholder",
    type,
    baselineCreative: "自有母版 A",
    singleVariable: "前三秒钩子",
    variant,
    audience: "通勤人群",
    hook,
    coreClaim: "真实体验",
    scene: "地铁",
    hypothesis: "只修改前三秒钩子，观察 CTR 与 ROI",
    fixedElements: "受众、主张、场景和出价口径保持一致",
    observationMetrics: "CTR、3 秒播放率、ROI",
    minSpend: 500,
    stopCondition,
    successAction: "人工确认后保留变量并进入下一轮",
    production: {}
  };
}

function entry(testId, batchId, {
  createdAt = "2026-09-01T01:00:00.000Z",
  type = /-B00$/u.test(testId) ? "基线" : "变体",
  hook = /-B00$/u.test(testId) ? "旧钩子" : "结果先行",
  stage = "ready",
  stopCondition
} = {}) {
  const item = planItem({ type, hook, stopCondition });
  item.id = testId;
  return {
    version: {
      testId,
      batchId,
      parentVersionId: null,
      createdAt,
      sourceGeneratedAt: createdAt,
      primaryVariable: "前三秒钩子",
      baselineCreative: "自有母版 A",
      minSpend: 500,
      productionStatus: { stage, updatedAt: createdAt },
      planItem: item
    },
    result: null,
    evaluation: { code: "pending" },
    decisionState: { code: "missing" }
  };
}

test("selects the newest batch and orders its baseline before numbered variants", () => {
  const old = entry("OLD-B00", "OLD", { createdAt: "2026-08-31T01:00:00.000Z" });
  const baseline = entry("NEW-B00", "NEW", { hook: "旧钩子" });
  const a02 = entry("NEW-A02", "NEW", { hook: "证据先行" });
  const a01 = entry("NEW-A01", "NEW", { hook: "结果先行" });
  const timeline = [a02, old, a01, baseline];
  const original = structuredClone(timeline);
  const batch = buildLatestOperatorBatchHandoff(timeline, { targetRoi: 1.8 });
  assert.equal(batch.batchId, "NEW");
  assert.deepEqual(batch.entries.map((item) => item.testId), ["NEW-B00", "NEW-A01", "NEW-A02"]);
  assert.equal(batch.ready, true);
  assert.equal(batch.readyCount, 3);
  assert.equal(batch.readyChecks, batch.totalChecks);
  assert.deepEqual(timeline, original);
});

test("reports batch blockers and refuses an oversized or malformed batch", () => {
  const baseline = entry("NEW-B00", "NEW");
  const variant = entry("NEW-A01", "NEW", { stage: "editing", stopCondition: "待确认" });
  const batch = buildLatestOperatorBatchHandoff([variant, baseline], { targetRoi: 0 });
  assert.equal(batch.ready, false);
  assert.equal(batch.readyCount, 0);
  const variantIssue = batch.issues.find((issue) => issue.testId === "NEW-A01");
  assert.match(variantIssue.missing.join("；"), /待投放或已上线/u);
  assert.match(variantIssue.missing.join("；"), /目标 ROI/u);
  assert.match(variantIssue.missing.join("；"), /停止条件/u);

  const oversized = Array.from({ length: MAX_OPERATOR_BATCH_VERSIONS + 1 }, (_, index) => entry(`HUGE-A${String(index + 1).padStart(2, "0")}`, "HUGE"));
  const oversizedBatch = buildLatestOperatorBatchHandoff(oversized, { targetRoi: 1.8 });
  assert.equal(oversizedBatch.code, "too_large");
  assert.equal(oversizedBatch.copyable, false);
  assert.throws(() => latestOperatorBatchToText(oversized, { targetRoi: 1.8 }), /拆分/u);
  assert.equal(buildLatestOperatorBatchHandoff([], { targetRoi: 1.8 }).code, "empty");
  assert.throws(() => buildLatestOperatorBatchHandoff([{}], { targetRoi: 1.8 }), /无效测试版本/u);
});

test("creates a complete local-only batch handoff without performing platform actions", () => {
  const baseline = entry("NEW-B00", "NEW");
  const variant = entry("NEW-A01", "NEW");
  const text = latestOperatorBatchToText([variant, baseline], { targetRoi: 1.8, projectName: "秋季素材" });
  assert.match(text, /# 千川批次投放交接包/u);
  assert.match(text, /项目：秋季素材/u);
  assert.match(text, /执行顺序：NEW-B00 → NEW-A01/u);
  assert.match(text, /版本就绪：2 \/ 2/u);
  assert.ok(text.indexOf("## 01 · NEW-B00") < text.indexOf("## 02 · NEW-A01"));
  assert.match(text, /不会读取账户、执行投放或验证平台状态/u);
  assert.match(text, /不创建广告计划、不设置预算、不自动启停、不读取千川账户/u);
  assert.throws(() => latestOperatorBatchToText([], { targetRoi: 1.8 }), /没有可交接/u);
});
