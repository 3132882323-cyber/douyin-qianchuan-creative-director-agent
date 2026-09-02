import test from "node:test";
import assert from "node:assert/strict";
import { createPlanDerivedRefresh, derivePlanAsyncFeedback } from "../src/plan-derived-refresh.js";

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    requestFrame(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      callbacks.delete(id);
    },
    runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      callbacks.delete(id);
      callback(16.7);
      return true;
    },
    size: () => callbacks.size
  };
}

test("coalesces repeated edits into one frame and reads the latest state", () => {
  const frames = createFrameHarness();
  let latest = "";
  const rendered = [];
  const queue = createPlanDerivedRefresh({
    refresh: () => rendered.push(latest),
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame
  });
  for (let index = 0; index < 20; index += 1) {
    latest = `钩子-${index}`;
    assert.equal(queue.schedule(), true);
  }
  assert.equal(frames.size(), 1);
  assert.deepEqual(queue.getState(), { pending: true, running: false, scheduled: true, destroyed: false });
  frames.runNext();
  assert.deepEqual(rendered, ["钩子-19"]);
  assert.deepEqual(queue.getState(), { pending: false, running: false, scheduled: false, destroyed: false });
});

test("queues a second frame when refresh schedules more derived work", () => {
  const frames = createFrameHarness();
  let runs = 0;
  let queue;
  queue = createPlanDerivedRefresh({
    refresh: () => {
      runs += 1;
      if (runs === 1) queue.schedule();
    },
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame
  });
  queue.schedule();
  frames.runNext();
  assert.equal(runs, 1);
  assert.equal(frames.size(), 1);
  frames.runNext();
  assert.equal(runs, 2);
  assert.equal(frames.size(), 0);
});

test("flushes, cancels and destroys pending work without leaking stale frames", () => {
  const frames = createFrameHarness();
  const errors = [];
  let runs = 0;
  const queue = createPlanDerivedRefresh({
    refresh: () => {
      runs += 1;
      if (runs === 2) throw new Error("render failed");
    },
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    onError: (error) => errors.push(error.message)
  });
  queue.schedule();
  assert.equal(queue.flush(), true);
  assert.equal(runs, 1);
  assert.equal(frames.size(), 0);
  queue.schedule();
  frames.runNext();
  assert.equal(runs, 2);
  assert.deepEqual(errors, ["render failed"]);
  queue.schedule();
  queue.cancel();
  assert.equal(frames.size(), 0);
  assert.equal(queue.flush(), false);
  queue.schedule();
  queue.cancel();
  queue.schedule();
  frames.runNext();
  assert.equal(runs, 3);
  queue.schedule();
  queue.destroy();
  assert.equal(frames.size(), 0);
  assert.equal(queue.schedule(), false);
  assert.equal(queue.getState().destroyed, true);
});

test("keeps refresh failures visible when autosave later succeeds", () => {
  assert.deepEqual(derivePlanAsyncFeedback({ saveCode: "saved", refreshError: "监看卡刷新失败" }), {
    status: "已保存 · 提示异常",
    good: false,
    error: "监看卡刷新失败"
  });
  assert.deepEqual(derivePlanAsyncFeedback({ saveCode: "error", saveError: "存储失败", refreshError: "盲审刷新失败" }), {
    status: "保存失败 · 提示异常",
    good: false,
    error: "存储失败；盲审刷新失败"
  });
  assert.deepEqual(derivePlanAsyncFeedback({ saveCode: "saved" }), {
    status: "已保存",
    good: true,
    error: ""
  });
});
