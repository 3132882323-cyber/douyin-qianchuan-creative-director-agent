import test from "node:test";
import assert from "node:assert/strict";
import { assessOperatorHandoffReadiness, buildOperatorSingleVariableDiff, experimentVersionToOperatorCard } from "../src/operator-handoff.js";

function planItem(overrides = {}) {
  return {
    baselineCreative: "历史母版 A",
    type: "基线",
    singleVariable: "前三秒钩子",
    variant: "先展示结果再解释过程",
    audience: "通勤人群",
    hook: "先展示结果再解释过程",
    coreClaim: "真实体验",
    scene: "地铁",
    hypothesis: "只修改前三秒钩子，观察 CTR 与 ROI",
    fixedElements: "受众、主张、场景、出价口径保持一致",
    observationMetrics: "CTR、3 秒播放率、ROI",
    minSpend: 500,
    stopCondition: "达到最低消耗后人工核对 ROI 与护栏指标",
    successAction: "人工确认后保留变量并进入下一轮",
    ...overrides
  };
}

function entry(overrides = {}) {
  const item = planItem(overrides.planItem || {});
  return {
    version: {
      testId: "QC-HOOK-20260901-A01",
      batchId: overrides.batchId ?? "QC-HOOK-20260901",
      parentVersionId: overrides.parentVersionId ?? null,
      primaryVariable: "前三秒钩子",
      baselineCreative: overrides.baselineCreative ?? item.baselineCreative,
      minSpend: overrides.minSpend ?? item.minSpend,
      productionStatus: overrides.productionStatus ?? { stage: "ready", updatedAt: "2026-09-01T01:00:00.000Z" },
      planItem: item
    }
  };
}

const alignedDiff = Object.freeze({
  code: "aligned",
  badge: "单变量一致",
  label: "可见创意语义只变化了声明变量“前三秒钩子”"
});

test("marks a complete root version ready for manual operator handoff without mutating it", () => {
  const current = entry();
  const original = structuredClone(current);
  const readiness = assessOperatorHandoffReadiness(current, { targetRoi: 1.8 });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.readyCount, readiness.total);
  assert.equal(readiness.productionStage, "ready");
  assert.equal(readiness.singleVariableCode, "root");
  assert.deepEqual(current, original);

  const baseline = entry({ planItem: { type: "基线", variant: "旧钩子", hook: "旧钩子" } });
  baseline.version.testId = "QC-HOOK-20260901-B00";
  const variant = entry({ planItem: { type: "变体", variant: "新钩子", hook: "新钩子" } });
  const batchDiff = buildOperatorSingleVariableDiff(variant, [variant, baseline]);
  assert.equal(batchDiff.code, "aligned");
  assert.equal(batchDiff.parentTestId, baseline.version.testId);
});

test("reports production, threshold, content and single-variable gaps instead of auto-filling them", () => {
  const current = entry({
    parentVersionId: "QC-HOOK-20260831-B00",
    baselineCreative: "待补充",
    minSpend: 0,
    productionStatus: { stage: "planned", updatedAt: "2026-09-01T01:00:00.000Z" },
    planItem: { type: "变体", variant: "", stopCondition: "待确认", successAction: "" }
  });
  const readiness = assessOperatorHandoffReadiness(current, {
    targetRoi: 0,
    contentDiff: { code: "needs_review", badge: "需核对", label: "除声明变量外，拍摄场景也发生变化" }
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing.map((gap) => gap.code), [
    "production_stage", "baseline", "variant", "min_spend", "target_roi", "stop_condition", "success_action", "single_variable"
  ]);
  assert.match(readiness.missing.at(-1).label, /拍摄场景/u);
  const missingBaseline = buildOperatorSingleVariableDiff(current, [current]);
  assert.equal(missingBaseline.code, "baseline_missing");
  const missingBatch = entry({ batchId: "", planItem: { type: "变体" } });
  const unrelatedBaseline = entry({ batchId: "OTHER", planItem: { type: "基线" } });
  unrelatedBaseline.version.testId = "OTHER-B00";
  assert.match(buildOperatorSingleVariableDiff(missingBatch, [missingBatch, unrelatedBaseline]).label, /缺少批次编号/u);
  const firstBaseline = entry({ planItem: { type: "基线" } });
  firstBaseline.version.testId = "QC-HOOK-20260901-BASE-1";
  const secondBaseline = entry({ planItem: { type: "基线" } });
  secondBaseline.version.testId = "QC-HOOK-20260901-BASE-2";
  assert.match(buildOperatorSingleVariableDiff(current, [current, firstBaseline, secondBaseline]).label, /多个可用基线/u);
  assert.throws(() => assessOperatorHandoffReadiness({}, { targetRoi: 1.5 }), /测试版本/u);
});

test("builds a plain-text operator card with thresholds, backfill rules and explicit non-automation boundaries", () => {
  const current = entry({ parentVersionId: "QC-HOOK-20260831-B00", productionStatus: { stage: "launched", updatedAt: "2026-09-01T01:00:00.000Z" }, planItem: { type: "变体" } });
  const card = experimentVersionToOperatorCard(current, {
    targetRoi: 1.8,
    projectName: "秋季素材测试",
    contentDiff: alignedDiff
  });
  assert.match(card, /# 千川投放交接卡/u);
  assert.match(card, /项目：秋季素材测试/u);
  assert.match(card, /测试编号：QC-HOOK-20260901-A01/u);
  assert.match(card, /单变量一致/u);
  assert.match(card, /当前项目目标 ROI：1\.80/u);
  assert.match(card, /最低测试消耗：¥500\.00/u);
  assert.match(card, /必填：测试编号、消耗/u);
  assert.match(card, /完整度：12 \/ 12/u);
  assert.match(card, /不创建广告计划、不设置预算、不自动启停、不读取千川账户/u);
});
