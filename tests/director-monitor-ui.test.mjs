import test from "node:test";
import assert from "node:assert/strict";
import { mountDirectorMonitorTools } from "../src/director-monitor-ui.js";

const MONITOR_SELECTOR = ".director-monitor-action";
const TAKE_REVIEW_SELECTOR = ".director-take-review-action";

class FakeNode {
  constructor({ id = "", index = "" } = {}) {
    this.id = id;
    this.dataset = index === "" ? {} : { index };
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.actionsBySelector = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  querySelectorAll(selector) {
    return this.actionsBySelector.get(selector) || [];
  }

  listenerCount(type = "click") {
    return this.listeners.get(type)?.size || 0;
  }

  async click() {
    let result;
    for (const listener of [...(this.listeners.get("click") || [])]) {
      result = await listener({ currentTarget: this, target: this });
    }
    return result;
  }
}

function actionSet(count, statePrefix, nodes) {
  return Array.from({ length: count }, (_, index) => {
    const button = new FakeNode({ index: String(index) });
    const status = new FakeNode({ id: `${statePrefix}-${index}` });
    nodes[status.id] = status;
    return button;
  });
}

function fakeRoot(count = 2) {
  const list = new FakeNode({ id: "plan-list" });
  const copyState = new FakeNode({ id: "copy-state" });
  const nodes = { "plan-list": list, "copy-state": copyState };
  const monitorActions = actionSet(count, "director-monitor-state", nodes);
  const takeReviewActions = actionSet(count, "director-take-review-state", nodes);
  list.actionsBySelector.set(MONITOR_SELECTOR, monitorActions);
  list.actionsBySelector.set(TAKE_REVIEW_SELECTOR, takeReviewActions);
  return {
    list,
    copyState,
    nodes,
    monitorActions,
    takeReviewActions,
    allActions: [...monitorActions, ...takeReviewActions],
    querySelector(selector) {
      return nodes[selector.replace(/^#/u, "")] || null;
    }
  };
}

function planItem(index, overrides = {}) {
  const id = index === 0 ? "MONITOR-B00" : `MONITOR-A${String(index).padStart(2, "0")}`;
  const production = {
    spokenScript: "先看结果\n随后进入证据过程",
    storyboard: "0-3秒｜结果近景｜先看结果｜单一焦点",
    shootingTask: `测试编号：${id}\n必拍证据：完整过程和结果`,
    editingNotes: "第三秒接入同一证据段。",
    subtitleHighlights: "• 先看结果\n• 过程证据",
    complianceChecklist: "核对事实与授权。",
    ...(overrides.production || {})
  };
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    singleVariable: "前三秒钩子",
    variant: index === 0 ? "先看结果" : "别急着判断",
    audience: "目标受众",
    hook: "先看结果",
    scene: "真实现场",
    fixedElements: "受众、主张、场景、证据与行动引导",
    ...overrides,
    production
  };
}

function samplePlan() {
  return { items: [planItem(0), planItem(1)] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("keeps monitor and take-review controls synchronized across ready, blocked and stale states", async () => {
  const root = fakeRoot();
  let plan = samplePlan();
  let stale = false;
  const writes = [];
  const controller = mountDirectorMonitorTools({
    root,
    getPlan: () => plan,
    getPlanStale: () => stale,
    writeText: async (value) => writes.push(value)
  });

  assert.equal(controller.mounted, true);
  const ready = controller.render();
  assert.equal(ready.length, 4);
  assert.deepEqual(ready.map((entry) => entry.kind), ["monitor", "monitor", "takeReview", "takeReview"]);
  assert.ok(root.allActions.every((button) => !button.disabled));
  assert.ok(root.allActions.every((button) => button.dataset.ready === "true"));
  assert.match(root.nodes["director-monitor-state-0"].textContent, /首帧、口播、字幕与证据字段已齐/u);
  assert.match(root.nodes["director-take-review-state-0"].textContent, /五项人工快检|拍完填写文件与 Take/u);

  plan.items[1].production.shootingTask = "普通拍摄说明";
  controller.render();
  assert.equal(root.monitorActions[0].disabled, false);
  assert.equal(root.takeReviewActions[0].disabled, false);
  assert.equal(root.monitorActions[1].disabled, true);
  assert.equal(root.takeReviewActions[1].disabled, true);
  assert.equal(root.monitorActions[1].dataset.ready, "false");
  assert.equal(root.takeReviewActions[1].dataset.ready, "false");
  assert.match(root.nodes["director-monitor-state-1"].textContent, /证据镜头/u);
  assert.match(root.nodes["director-take-review-state-1"].textContent, /证据镜头/u);
  await root.monitorActions[1].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /证据镜头/u);
  await root.takeReviewActions[1].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /证据镜头/u);

  plan = samplePlan();
  stale = true;
  controller.render();
  assert.ok(root.allActions.every((button) => button.disabled));
  assert.ok(root.monitorActions.every((button) => button.textContent === "监看卡需重新生成"));
  assert.ok(root.takeReviewActions.every((button) => button.textContent === "快检卡需重新生成"));
  await root.monitorActions[0].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /复制前三秒监看卡/u);
  await root.takeReviewActions[0].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /复制拍后快检卡/u);
});

test("binds one listener per action and copies both cards from the latest plan edit", async () => {
  const root = fakeRoot(1);
  const writes = [];
  const plan = samplePlan();
  const controller = mountDirectorMonitorTools({
    root,
    getPlan: () => plan,
    getPlanStale: () => false,
    writeText: async (value) => writes.push(value)
  });

  controller.render();
  controller.render();
  assert.equal(root.monitorActions[0].listenerCount(), 1);
  assert.equal(root.takeReviewActions[0].listenerCount(), 1);

  plan.items[0].hook = "刚刚编辑的钩子";
  plan.items[0].variant = "刚刚编辑的钩子";
  plan.items[0].production.spokenScript = "刚刚编辑的钩子\n随后进入证据过程";
  plan.items[0].production.subtitleHighlights = "• 刚刚编辑的钩子\n• 过程证据";
  await root.monitorActions[0].click();
  await root.takeReviewActions[0].click();

  assert.equal(writes.length, 2);
  assert.match(writes[0], /# 前三秒现场监看卡 · MONITOR-B00/u);
  assert.match(writes[0], /刚刚编辑的钩子/u);
  assert.match(writes[1], /# 单条拍后快检卡 · MONITOR-B00/u);
  assert.match(writes[1], /刚刚编辑的钩子/u);
  assert.match(writes[1], /## 五项人工快检/u);
  assert.match(writes[1], /## 人工结论 · 必须三选一/u);
  assert.match(writes[1], /保留本 Take/u);
  assert.match(root.copyState.textContent, /每个 Take 拍完立即五查/u);

  controller.destroy();
  assert.equal(root.monitorActions[0].listenerCount(), 0);
  assert.equal(root.takeReviewActions[0].listenerCount(), 0);
});

async function assertNewerToolSupersedesOlder({ olderKind, newerKind, newerFeedback }) {
  const root = fakeRoot(1);
  const pendingWrites = [];
  const controller = mountDirectorMonitorTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => false,
    writeText: (value) => {
      const gate = deferred();
      pendingWrites.push({ value, gate });
      return gate.promise;
    }
  });
  controller.render();
  const actions = { monitor: root.monitorActions[0], takeReview: root.takeReviewActions[0] };
  const olderCopy = actions[olderKind].click();
  const newerCopy = actions[newerKind].click();
  assert.equal(pendingWrites.length, 2);

  pendingWrites[1].gate.resolve();
  await newerCopy;
  assert.match(root.copyState.textContent, newerFeedback);
  const latestFeedback = root.copyState.textContent;
  pendingWrites[0].gate.resolve();
  await olderCopy;
  assert.equal(root.copyState.textContent, latestFeedback);
}

test("monitor and take-review copies mutually supersede older asynchronous feedback", async () => {
  await assertNewerToolSupersedesOlder({
    olderKind: "monitor",
    newerKind: "takeReview",
    newerFeedback: /拍后快检卡/u
  });
  await assertNewerToolSupersedesOlder({
    olderKind: "takeReview",
    newerKind: "monitor",
    newerFeedback: /前三秒现场监看卡/u
  });
});

async function assertDelayedCopyCannotOverwrite({ invalidate, expectedSentinel }) {
  const root = fakeRoot(1);
  const gate = deferred();
  let revision = 1;
  let stale = false;
  let externalGeneration = 0;
  const controller = mountDirectorMonitorTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => stale,
    getRevision: () => revision,
    beginOperation: () => ++externalGeneration,
    isOperationCurrent: (token) => token === externalGeneration,
    writeText: () => gate.promise
  });
  controller.render();
  const pendingCopy = root.takeReviewActions[0].click();
  ({ revision, stale, externalGeneration } = invalidate({ revision, stale, externalGeneration, controller, root }));
  root.copyState.textContent = expectedSentinel;
  gate.resolve();
  await pendingCopy;
  assert.equal(root.copyState.textContent, expectedSentinel);
  return { controller, root };
}

test("drops delayed take-review feedback after revision, stale state or a newer global operation", async () => {
  await assertDelayedCopyCannotOverwrite({
    invalidate: (state) => ({ ...state, revision: state.revision + 1 }),
    expectedSentinel: "方案有未导出的修改"
  });
  await assertDelayedCopyCannotOverwrite({
    invalidate: (state) => ({ ...state, stale: true }),
    expectedSentinel: "方案已由新上下文失效"
  });
  await assertDelayedCopyCannotOverwrite({
    invalidate: (state) => ({ ...state, externalGeneration: state.externalGeneration + 1 }),
    expectedSentinel: "已有更新的全局输出"
  });
});

test("destroy removes both action types and invalidates their delayed copy", async () => {
  const root = fakeRoot(1);
  const gate = deferred();
  const controller = mountDirectorMonitorTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => false,
    writeText: () => gate.promise
  });
  controller.render();
  const pendingCopy = root.monitorActions[0].click();
  controller.destroy();
  root.copyState.textContent = "控制器已销毁";
  assert.equal(root.monitorActions[0].listenerCount(), 0);
  assert.equal(root.takeReviewActions[0].listenerCount(), 0);
  gate.resolve();
  await pendingCopy;
  assert.equal(root.copyState.textContent, "控制器已销毁");
});

test("fails closed with visible feedback when plan or revision state cannot be read", async () => {
  const unreadableRoot = fakeRoot(1);
  const unreadable = mountDirectorMonitorTools({
    root: unreadableRoot,
    getPlan: () => { throw new Error("方案读取失败"); },
    getPlanStale: () => false,
    writeText: async () => { throw new Error("不应写入"); }
  });
  unreadable.render();
  assert.ok(unreadableRoot.allActions.every((button) => button.disabled));
  assert.match(unreadableRoot.nodes["director-monitor-state-0"].textContent, /方案读取失败/u);
  await unreadableRoot.takeReviewActions[0].click();
  assert.match(unreadableRoot.copyState.textContent, /方案读取失败/u);

  const revisionRoot = fakeRoot(1);
  const writes = [];
  const revisionFailure = mountDirectorMonitorTools({
    root: revisionRoot,
    getPlan: samplePlan,
    getPlanStale: () => false,
    getRevision: () => { throw new Error("修订号读取失败"); },
    writeText: async (value) => writes.push(value)
  });
  revisionFailure.render();
  await revisionRoot.monitorActions[0].click();
  assert.equal(writes.length, 0);
  assert.match(revisionRoot.copyState.textContent, /修订号读取失败/u);
});
