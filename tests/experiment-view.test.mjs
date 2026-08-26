import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIMENT_VIEW_PAGE_SIZE,
  buildExperimentView,
  experimentBatchOptions
} from "../src/experiment-view.js";

function entry(index, {
  batchId = index < 3 ? "BATCH-NEW" : "BATCH-OLD",
  evaluation = "pending",
  decisionState = "missing",
  decisionReason = ""
} = {}) {
  return {
    version: {
      testId: `TEST-${String(index).padStart(3, "0")}`,
      parentVersionId: index ? `TEST-${String(index - 1).padStart(3, "0")}` : null,
      batchId,
      primaryVariable: index % 2 ? "前三秒钩子" : "字幕节奏",
      baselineCreative: `母版 ${index}`,
      planItem: { variant: index === 2 ? "直接说出核心利益" : `方案 ${index}` },
      decision: decisionReason ? { outcome: "keep", reason: decisionReason } : null
    },
    evaluation: { code: evaluation },
    decisionState: { code: decisionState }
  };
}

test("combines status, batch and non-sensitive version search without changing source order", () => {
  const timeline = [
    entry(0, { evaluation: "target_met" }),
    entry(1),
    entry(2),
    entry(3, { evaluation: "target_met" })
  ];
  const before = structuredClone(timeline);
  const view = buildExperimentView(timeline, { filter: "pending", batchId: "BATCH-NEW", query: "核心利益" });
  assert.deepEqual(view.items.map((item) => item.version.testId), ["TEST-002"]);
  assert.equal(view.total, 1);
  assert.deepEqual(timeline, before);
  assert.deepEqual(experimentBatchOptions(timeline), [
    { id: "BATCH-NEW", count: 3 },
    { id: "BATCH-OLD", count: 1 }
  ]);
});

test("paginates every version instead of silently truncating the history", () => {
  const timeline = Array.from({ length: 500 }, (_, index) => entry(index, { batchId: `BATCH-${Math.floor(index / 10)}` }));
  const ids = [];
  for (let page = 1; page <= 25; page += 1) {
    const view = buildExperimentView(timeline, { page });
    assert.equal(view.pageSize, EXPERIMENT_VIEW_PAGE_SIZE);
    ids.push(...view.items.map((item) => item.version.testId));
  }
  assert.equal(ids.length, 500);
  assert.equal(new Set(ids).size, 500);
  assert.deepEqual(ids, timeline.map((item) => item.version.testId));
});

test("clamps a stale page after filters reduce the result set", () => {
  const view = buildExperimentView(Array.from({ length: 41 }, (_, index) => entry(index)), { page: 99 });
  assert.equal(view.page, 3);
  assert.equal(view.totalPages, 3);
  assert.equal(view.from, 41);
  assert.equal(view.to, 41);
  assert.equal(view.items.length, 1);

  const empty = buildExperimentView([], { page: 4 });
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.from, 0);
  assert.equal(empty.to, 0);
});

test("does not search free-form human decision reasons", () => {
  const timeline = [entry(1, { decisionState: "current", decisionReason: "内部敏感判断只在决策编辑器显示" })];
  assert.equal(buildExperimentView(timeline, { query: "敏感判断" }).total, 0);
  assert.equal(buildExperimentView(timeline, { query: "TEST-001" }).total, 1);
  assert.equal(buildExperimentView(timeline, { query: "test-001" }).total, 1);
});

test("rejects invalid pagination and unsafe search controls", () => {
  assert.throws(() => buildExperimentView([], { page: 0 }), /页码/u);
  assert.throws(() => buildExperimentView([], { pageSize: 101 }), /每页版本数/u);
  assert.throws(() => buildExperimentView([], { query: "x".repeat(129) }), /最多 128/u);
  assert.throws(() => buildExperimentView([], { query: "test\u0000id" }), /控制字符/u);
  assert.throws(() => buildExperimentView({}), /格式无效/u);
});
