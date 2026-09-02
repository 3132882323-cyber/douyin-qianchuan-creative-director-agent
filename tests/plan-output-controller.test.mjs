import test from "node:test";
import assert from "node:assert/strict";
import { createRevisionOperationGuard } from "../src/operation-guard.js";
import { createPlanCompletionTracker, createPlanOutputController } from "../src/plan-output-controller.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness({ writeText, downloadFile, persist } = {}) {
  let revision = 1;
  let available = true;
  let plan = { title: "初始方案" };
  let receipt = null;
  const stored = [];
  const removed = [];
  const feedback = [];
  const outdated = [];
  let workflowRefreshes = 0;
  const guard = createRevisionOperationGuard({ getRevision: () => revision, isAvailable: () => available });
  const tracker = createPlanCompletionTracker({
    getPlan: () => plan,
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: (currentPlan) => ({ fingerprint: currentPlan.title, completedAt: "2026-09-02T00:00:00.000Z" }),
    writeReceipt: async (value) => { stored.push(value); },
    removeReceipt: async () => { removed.push("receipt"); },
    persist: persist || (async () => true)
  });
  const controller = createPlanOutputController({
    isAvailable: () => available,
    beginOperation: () => guard.begin(),
    isCurrentOperation: (token) => guard.isCurrent(token),
    isLatestOperation: (token) => guard.isLatest(token),
    writeText: writeText || (async () => {}),
    downloadFile: downloadFile || (async () => {}),
    markCompleted: (token) => tracker.markCompleted(token),
    onFeedback: (message) => feedback.push(message),
    onOutdated: (_token, label) => outdated.push(label),
    onCompletionChange: () => { workflowRefreshes += 1; }
  });
  return {
    controller,
    guard,
    stored,
    removed,
    feedback,
    outdated,
    get receipt() { return receipt; },
    set receipt(value) { receipt = value; },
    get plan() { return plan; },
    set plan(value) { plan = value; },
    get revision() { return revision; },
    set revision(value) { revision = value; },
    get available() { return available; },
    set available(value) { available = value; },
    get workflowRefreshes() { return workflowRefreshes; }
  };
}

const copyOptions = () => ({
  label: "完整方案",
  createContent: () => "当前完整方案",
  successMessage: "复制成功",
  failureMessage: "复制失败",
  completionFailureMessage: "已复制，但完成状态未保存"
});

test("copies the clicked revision and records completion only after delivery", async () => {
  const writes = [];
  const state = harness({ writeText: async (value) => writes.push(value) });
  assert.equal(await state.controller.copy(copyOptions()), true);
  assert.deepEqual(writes, ["当前完整方案"]);
  assert.equal(state.receipt.fingerprint, "初始方案");
  assert.equal(state.stored.length, 1);
  assert.deepEqual(state.feedback, ["复制成功"]);
  assert.equal(state.workflowRefreshes, 1);
});

test("does not mark a new plan complete when editing during a delayed clipboard write", async () => {
  const clipboard = deferred();
  const state = harness({ writeText: () => clipboard.promise });
  const pending = state.controller.copy(copyOptions());
  state.plan = { title: "编辑后的方案" };
  state.revision += 1;
  clipboard.resolve();
  assert.equal(await pending, false);
  assert.equal(state.receipt, null);
  assert.equal(state.stored.length, 0);
  assert.deepEqual(state.outdated, ["完整方案"]);
  assert.equal(state.workflowRefreshes, 0);
});

test("clears a stale receipt when the plan changes during delayed receipt storage", async () => {
  const storage = deferred();
  let revision = 7;
  let receipt = null;
  let persisted = 0;
  let removed = 0;
  const guard = createRevisionOperationGuard({ getRevision: () => revision });
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案 A" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: () => ({ fingerprint: "A" }),
    writeReceipt: () => storage.promise,
    removeReceipt: async () => { removed += 1; },
    persist: async () => { persisted += 1; }
  });
  const pending = tracker.markCompleted(guard.begin());
  assert.equal(receipt.fingerprint, "A");
  revision += 1;
  assert.equal(tracker.clearCompletion(), true);
  storage.resolve();
  assert.equal(await pending, false);
  assert.equal(receipt, null);
  assert.equal(removed, 1);
  assert.equal(persisted, 1);
});

test("a superseded copy cannot overwrite feedback from a newer copy", async () => {
  const firstClipboard = deferred();
  let writeCount = 0;
  const state = harness({
    writeText: () => {
      writeCount += 1;
      return writeCount === 1 ? firstClipboard.promise : Promise.resolve();
    }
  });
  const first = state.controller.copy({ ...copyOptions(), successMessage: "旧复制成功" });
  const second = state.controller.copy({ ...copyOptions(), successMessage: "新复制成功" });
  assert.equal(await second, true);
  firstClipboard.resolve();
  assert.equal(await first, false);
  assert.deepEqual(state.feedback, ["新复制成功"]);
  assert.deepEqual(state.outdated, []);
});

test("exports the current snapshot through the same completion boundary", async () => {
  const downloads = [];
  const state = harness({ downloadFile: async (...args) => downloads.push(args) });
  const result = await state.controller.exportFile({
    name: "plan.md",
    type: "text/markdown",
    label: "Markdown",
    createContent: () => "# 方案",
    successMessage: "导出成功",
    failureMessage: "导出失败"
  });
  assert.equal(result, true);
  assert.deepEqual(downloads, [["plan.md", "# 方案", "text/markdown"]]);
  assert.equal(state.receipt.fingerprint, "初始方案");
});

test("reports delivery failures without creating a completion receipt", async () => {
  const state = harness({ writeText: async () => { throw new Error("denied"); } });
  assert.equal(await state.controller.copy(copyOptions()), false);
  assert.deepEqual(state.feedback, ["复制失败"]);
  assert.equal(state.receipt, null);
  assert.equal(state.workflowRefreshes, 0);
});

test("rolls back completion when both durable stores fail after successful delivery", async () => {
  let receipt = null;
  let workflowRefreshes = 0;
  const feedback = [];
  const guard = createRevisionOperationGuard({ getRevision: () => 1 });
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: () => ({ fingerprint: "failed" }),
    writeReceipt: async () => { throw new Error("storage failed"); },
    removeReceipt: async () => { throw new Error("storage failed"); },
    persist: async () => false
  });
  const controller = createPlanOutputController({
    isAvailable: () => true,
    beginOperation: () => guard.begin(),
    isCurrentOperation: (token) => guard.isCurrent(token),
    isLatestOperation: (token) => guard.isLatest(token),
    writeText: async () => {},
    downloadFile: async () => {},
    markCompleted: (token) => tracker.markCompleted(token),
    onFeedback: (message) => feedback.push(message),
    onOutdated: () => {},
    onCompletionChange: () => { workflowRefreshes += 1; }
  });
  const result = await controller.copy(copyOptions());
  assert.equal(result, false);
  assert.equal(receipt, null);
  assert.deepEqual(feedback, ["复制成功", "已复制，但完成状态未保存"]);
  assert.equal(workflowRefreshes, 2);
});

test("keeps completion when either durable layer succeeds", async () => {
  let receipt = null;
  const guard = createRevisionOperationGuard({ getRevision: () => 1 });
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: () => ({ fingerprint: "stored-in-project" }),
    writeReceipt: async () => { throw new Error("storage failed"); },
    removeReceipt: async () => {},
    persist: async () => true
  });
  assert.equal(await tracker.markCompleted(guard.begin()), true);
  assert.equal(receipt.fingerprint, "stored-in-project");
});

test("compensates an older project write and keeps a newer receipt after revision change", async () => {
  const firstPersistence = deferred();
  let revision = 2;
  let plan = { title: "old" };
  let receipt = null;
  let removed = 0;
  const persistedReceipts = [];
  let persistCalls = 0;
  const guard = createRevisionOperationGuard({ getRevision: () => revision });
  const tracker = createPlanCompletionTracker({
    getPlan: () => plan,
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: (value) => ({ fingerprint: value.title }),
    writeReceipt: async () => {},
    removeReceipt: async () => { removed += 1; },
    persist: () => {
      persistCalls += 1;
      const captured = receipt;
      if (persistCalls === 1) {
        return firstPersistence.promise.then(() => { persistedReceipts.push(captured); });
      }
      persistedReceipts.push(captured);
      return Promise.resolve();
    }
  });
  const first = tracker.markCompleted(guard.begin());
  await Promise.resolve();
  await Promise.resolve();
  revision += 1;
  plan = { title: "new" };
  const second = tracker.markCompleted(guard.begin());
  firstPersistence.resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(receipt, { fingerprint: "new" });
  assert.equal(removed, 0);
  assert.equal(persistCalls, 2);
  assert.deepEqual(persistedReceipts, [{ fingerprint: "old" }, { fingerprint: "new" }]);
});

test("clearCompletion is idempotent and reconciles the durable state once", async () => {
  let receipt = { fingerprint: "done" };
  let removed = 0;
  const persisted = [];
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: () => true,
    createReceipt: () => ({ fingerprint: "unused" }),
    writeReceipt: async () => {},
    removeReceipt: async () => { removed += 1; },
    persist: async () => { persisted.push(receipt); }
  });
  assert.equal(tracker.clearCompletion(), true);
  assert.equal(tracker.clearCompletion(), false);
  await tracker.flush();
  assert.equal(receipt, null);
  assert.equal(removed, 1);
  assert.deepEqual(persisted, [null]);
});

test("defers the project clear to autosave when no older project write is in flight", async () => {
  let receipt = { fingerprint: "done" };
  let removed = 0;
  let persisted = 0;
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: () => true,
    createReceipt: () => ({ fingerprint: "unused" }),
    writeReceipt: async () => {},
    removeReceipt: async () => { removed += 1; },
    persist: async () => { persisted += 1; }
  });
  assert.equal(tracker.clearCompletion({ persistProject: false }), true);
  await tracker.flush();
  assert.equal(receipt, null);
  assert.equal(removed, 1);
  assert.equal(persisted, 0);
});

test("still compensates when a deferred clear arrives during an older project write", async () => {
  const firstPersistence = deferred();
  let receipt = null;
  const persisted = [];
  let persistCalls = 0;
  const guard = createRevisionOperationGuard({ getRevision: () => 1 });
  const tracker = createPlanCompletionTracker({
    getPlan: () => ({ title: "方案" }),
    getReceipt: () => receipt,
    hasCompletion: () => Boolean(receipt),
    setReceipt: (value) => { receipt = value; },
    matchesRevision: (token) => guard.matchesRevision(token),
    createReceipt: () => ({ fingerprint: "done" }),
    writeReceipt: async () => {},
    removeReceipt: async () => {},
    persist: () => {
      persistCalls += 1;
      const captured = receipt;
      if (persistCalls === 1) return firstPersistence.promise.then(() => { persisted.push(captured); });
      persisted.push(captured);
      return Promise.resolve();
    }
  });
  const pending = tracker.markCompleted(guard.begin());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tracker.clearCompletion({ persistProject: false }), true);
  firstPersistence.resolve();
  assert.equal(await pending, false);
  assert.equal(receipt, null);
  assert.deepEqual(persisted, [{ fingerprint: "done" }, null]);
});
