import test from "node:test";
import assert from "node:assert/strict";
import { DIRECTOR_DESK_MAX_ACTIONS, buildDirectorDesk } from "../src/director-desk.js";

function recent(kind = "plan-ready", overrides = {}) {
  return {
    kind,
    title: "下一版任务待检查",
    description: "当前工作区有 3 个可继续检查的拍摄方案。",
    action: "继续检查任务",
    targetView: "next",
    focusId: "copy-plan",
    ...overrides
  };
}

function planItem(overrides = {}) {
  return {
    variant: "旧钩子",
    audience: "通勤人群",
    hook: "旧钩子",
    coreClaim: "真实体验",
    scene: "地铁",
    fixedElements: "受众、主张与场景不变",
    observationMetrics: "3 秒留存、CTR",
    production: {},
    ...overrides
  };
}

function entry(testId, options = {}) {
  const evaluationCode = options.evaluationCode || "pending";
  return {
    version: {
      projectId: "prj_12345678",
      testId,
      batchId: options.batchId || "B2",
      parentVersionId: options.parentVersionId || null,
      primaryVariable: options.primaryVariable || "前三秒钩子",
      baselineCreative: "母版 A",
      minSpend: 300,
      decision: options.decision || null,
      productionStatus: options.productionStatus || null,
      planItem: options.item || planItem()
    },
    result: options.result === undefined
      ? evaluationCode === "pending" ? null : { metrics: { spend: 400 }, qualityWarnings: [] }
      : options.result,
    evaluation: { code: evaluationCode },
    decisionState: options.decisionState || { code: options.decision ? "current" : "missing" }
  };
}

test("keeps an honest workflow action when no experiment exists", () => {
  const desk = buildDirectorDesk({ recentWork: recent("empty", { title: "暂无任务", action: "从复盘开始", targetView: "review", focusId: "report-file-trigger" }) });
  assert.equal(desk.items.length, 1);
  assert.equal(desk.items[0].kind, "workflow");
  assert.equal(desk.items[0].route.targetView, "review");
  assert.match(desk.summary, /不会自动执行/u);
});

test("puts experiment backfill ahead of routine plan checking", () => {
  const pending = entry("TEST-PENDING", { productionStatus: { stage: "launched", updatedAt: "2026-08-31T01:00:00.000Z" } });
  const desk = buildDirectorDesk({ recentWork: recent(), timeline: [pending] });
  assert.deepEqual(desk.items.map((item) => item.kind), ["experiment", "workflow"]);
  assert.equal(desk.items[0].route.next.target, "manual_result");
  assert.equal(desk.items[0].route.next.testId, "TEST-PENDING");
});

test("puts honest production marking ahead of routine plan checking", () => {
  const pending = entry("TEST-UNTRACKED");
  const desk = buildDirectorDesk({ recentWork: recent(), timeline: [pending] });
  assert.equal(desk.items[0].route.next.code, "production_unmarked");
  assert.equal(desk.items[0].route.next.target, "production");
  assert.match(desk.items[0].description, /当前为“未标记”/u);
});

test("prioritizes stale evidence and surfaces latest-batch single-variable risk", () => {
  const parent = entry("PARENT", { batchId: "B1", evaluationCode: "target_met", decision: { outcome: "keep" } });
  const child = entry("CHILD", {
    parentVersionId: "PARENT",
    evaluationCode: "target_met",
    decision: { outcome: "keep" },
    decisionState: { code: "stale" },
    item: planItem({ variant: "新钩子", hook: "新钩子", scene: "办公室" })
  });
  const desk = buildDirectorDesk({ recentWork: recent("plan-stale"), timeline: [child, parent] });
  assert.equal(desk.items[0].route.next.code, "decision_stale");
  assert.equal(desk.items[1].kind, "content-risk");
  assert.equal(desk.items[1].route.testId, "CHILD");
  assert.equal(desk.contentRiskCount, 1);
});

test("only counts content risks in the newest batch", () => {
  const newest = entry("NEW-ROOT", { batchId: "B2", evaluationCode: "target_met", decision: { outcome: "stop" } });
  const oldParent = entry("OLD-PARENT", { batchId: "B1", evaluationCode: "target_met", decision: { outcome: "stop" } });
  const oldRisk = entry("OLD-RISK", {
    batchId: "B1",
    parentVersionId: "OLD-PARENT",
    evaluationCode: "target_met",
    decision: { outcome: "stop" },
    item: planItem({ variant: "新钩子", hook: "新钩子", scene: "办公室" })
  });
  const desk = buildDirectorDesk({ recentWork: recent(), timeline: [newest, oldRisk, oldParent] });
  assert.equal(desk.contentRiskCount, 0);
  assert.ok(desk.items.every((item) => item.kind !== "content-risk"));
});

test("caps the visible queue at three without mutating source data", () => {
  const parent = entry("PARENT", { batchId: "B1", evaluationCode: "target_met", decision: { outcome: "stop" } });
  const risky = entry("RISKY", { parentVersionId: "PARENT", item: planItem({ production: { spokenScript: "只改口播" } }) });
  const timeline = [risky, parent];
  const snapshot = JSON.stringify(timeline);
  const desk = buildDirectorDesk({ recentWork: recent(), timeline, limit: 99 });
  assert.equal(DIRECTOR_DESK_MAX_ACTIONS, 3);
  assert.ok(desk.items.length <= DIRECTOR_DESK_MAX_ACTIONS);
  assert.equal(JSON.stringify(timeline), snapshot);
});

test("fails closed for malformed workflow, timeline or limit input", () => {
  assert.throws(() => buildDirectorDesk({ recentWork: null }), /流程状态/u);
  assert.throws(() => buildDirectorDesk({ recentWork: recent(), timeline: {} }), /时间线格式/u);
  assert.throws(() => buildDirectorDesk({ recentWork: recent(), timeline: [{}] }), /缺少测试编号/u);
  assert.throws(() => buildDirectorDesk({ recentWork: recent(), limit: 0 }), /正整数/u);
});
