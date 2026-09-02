import test from "node:test";
import assert from "node:assert/strict";
import { mountDirectorItemRunSheetTools } from "../src/director-item-run-sheet-ui.js";

class FakeNode {
  constructor({ id = "", index = "" } = {}) {
    this.id = id;
    this.dataset = index === "" ? {} : { index };
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.actions = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  querySelectorAll(selector) {
    return selector === ".director-item-run-sheet-action" ? this.actions : [];
  }

  async click() {
    for (const listener of this.listeners.get("click") || []) await listener({ target: this });
  }
}

function fakeRoot(indices = [0, 1]) {
  const list = new FakeNode({ id: "plan-list" });
  const copyState = new FakeNode({ id: "copy-state" });
  const nodes = { "plan-list": list, "copy-state": copyState };
  list.actions = indices.map((index) => {
    const button = new FakeNode({ index: String(index) });
    const status = new FakeNode({ id: `director-item-run-sheet-state-${index}` });
    const variable = new FakeNode({ id: `director-execution-variable-value-${index}` });
    const locks = new FakeNode({ id: `director-execution-locks-${index}` });
    nodes[status.id] = status;
    nodes[variable.id] = variable;
    nodes[locks.id] = locks;
    return button;
  });
  return {
    list,
    copyState,
    nodes,
    querySelector(selector) {
      return nodes[selector.replace(/^#/u, "")] || null;
    }
  };
}

function planItem(index, overrides = {}) {
  const production = {
    spokenScript: "先看结果，再看完整过程。",
    storyboard: "0-3秒结果近景，随后进入完整过程。",
    shootingTask: "锁定机位，拍完整过程与结果证据。",
    editingNotes: "第三秒接同一证据段，不改变主张。",
    subtitleHighlights: "先看结果｜完整过程",
    complianceChecklist: "核对事实、授权与发布表达。",
    ...(overrides.production || {})
  };
  return {
    id: index === 0 ? "B00" : `A${String(index).padStart(2, "0")}`,
    type: index === 0 ? "基线" : "变体",
    singleVariable: "前三秒钩子",
    variant: index === 0 ? "先看结果" : "别急着划走",
    audience: "高意向人群",
    hook: "先看结果",
    scene: "真实使用现场",
    fixedElements: "演员、机位、光线、证据、时长和行动引导",
    ...overrides,
    production
  };
}

function samplePlan() {
  return { batchId: "BATCH-01", items: [planItem(0), planItem(1)] };
}

test("renders waiting, ready, missing and stale states fail-closed", async () => {
  const root = fakeRoot();
  let plan = null;
  let stale = false;
  const writes = [];
  const controller = mountDirectorItemRunSheetTools({
    root,
    getPlan: () => plan,
    getPlanStale: () => stale,
    writeText: async (value) => writes.push(value)
  });

  assert.equal(controller.mounted, true);
  assert.ok(controller.render().every((state) => state.code === "waiting"));
  assert.ok(root.list.actions.every((button) => button.disabled));
  assert.match(root.nodes["director-item-run-sheet-state-0"].textContent, /等待生成/u);

  plan = samplePlan();
  assert.ok(controller.render().every((state) => state.code === "ready"));
  assert.ok(root.list.actions.every((button) => !button.disabled));
  assert.equal(root.list.actions[0].textContent, "复制本条开拍单");

  plan.items[1].production.editingNotes = "请编导补充";
  assert.equal(controller.render()[1].code, "blocked");
  assert.equal(root.list.actions[1].disabled, true);
  assert.match(root.nodes["director-item-run-sheet-state-1"].textContent, /剪辑要求/u);
  await root.list.actions[1].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /请先补齐 A01.*剪辑要求/u);

  plan.items[1].production.editingNotes = "第三秒接同一证据段，不改变主张。";
  plan.items[1].singleVariable = "";
  assert.equal(controller.render()[1].code, "blocked");
  assert.match(root.nodes["director-item-run-sheet-state-1"].textContent, /唯一变量/u);

  stale = true;
  assert.ok(controller.render().every((state) => state.code === "stale"));
  await root.list.actions[0].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /当前方案已过期/u);
});

test("copies only the selected ready item and reads the latest edit", async () => {
  const root = fakeRoot();
  const plan = samplePlan();
  const writes = [];
  const feedback = [];
  const controller = mountDirectorItemRunSheetTools({
    root,
    getPlan: () => plan,
    getPlanStale: () => false,
    getRevision: () => 7,
    writeText: async (value) => writes.push(value),
    onFeedback: (message) => feedback.push(message)
  });
  controller.render();
  plan.items[1].hook = "刚改好的现场钩子";
  plan.items[1].variant = "刚改好的变量值";
  plan.items[1].fixedElements = "刚锁定的演员、机位和证据";
  controller.render();
  assert.equal(root.nodes["director-execution-variable-value-1"].textContent, "前三秒钩子 → 刚改好的变量值");
  assert.equal(root.nodes["director-execution-locks-1"].textContent, "其余锁定：刚锁定的演员、机位和证据");
  await root.list.actions[1].click();

  assert.equal(writes.length, 1);
  assert.match(writes[0], /^# 千川单条开拍单/mu);
  assert.match(writes[0], /A01/u);
  assert.match(writes[0], /刚改好的现场钩子/u);
  assert.match(writes[0], /刚改好的变量值/u);
  assert.doesNotMatch(writes[0], /## 01 · B00/u);
  assert.match(feedback.at(-1), /已复制 A01/u);
});

test("blocks out-of-range controls and does not bind duplicate listeners", async () => {
  const root = fakeRoot([0, 4]);
  const writes = [];
  const controller = mountDirectorItemRunSheetTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => false,
    writeText: async (value) => writes.push(value)
  });
  for (let index = 0; index < 20; index += 1) controller.render();
  assert.equal(root.list.actions[0].listeners.get("click").size, 1);
  assert.equal(root.list.actions[1].listeners.get("click").size, 1);
  assert.equal(root.list.actions[1].disabled, true);
  assert.match(root.nodes["director-item-run-sheet-state-4"].textContent, /任务序号无效/u);
  await root.list.actions[1].click();
  assert.equal(writes.length, 0);
  assert.match(root.copyState.textContent, /任务序号无效/u);

  controller.destroy();
  assert.equal(root.list.actions[0].listeners.get("click").size, 0);
  assert.equal(root.list.actions[1].listeners.get("click").size, 0);
  await root.list.actions[0].click();
  assert.equal(writes.length, 0);
});

test("blocks every item when baseline or sequential version identity is inconsistent", async () => {
  for (const mutate of [
    (plan) => { plan.items[0].id = "A99"; },
    (plan) => { plan.items[1].id = "B00"; },
    (plan) => { plan.items[1].id = "A02"; },
    (plan) => { plan.items[0].type = "变体"; }
  ]) {
    const root = fakeRoot();
    const plan = samplePlan();
    const writes = [];
    mutate(plan);
    const controller = mountDirectorItemRunSheetTools({
      root,
      getPlan: () => plan,
      getPlanStale: () => false,
      writeText: async (value) => writes.push(value)
    });
    assert.ok(controller.render().every((state) => state.code === "blocked"));
    assert.ok(root.list.actions.every((button) => button.disabled));
    assert.match(root.nodes["director-item-run-sheet-state-0"].textContent, /版本身份与顺序/u);
    await root.list.actions[0].click();
    assert.equal(writes.length, 0);
  }
});

test("suppresses delayed clipboard feedback after revision or stale state changes", async () => {
  for (const change of ["revision", "stale"]) {
    const root = fakeRoot([0]);
    let revision = 1;
    let stale = false;
    let finishWrite;
    const controller = mountDirectorItemRunSheetTools({
      root,
      getPlan: samplePlan,
      getPlanStale: () => stale,
      getRevision: () => revision,
      writeText: () => new Promise((resolve) => { finishWrite = resolve; })
    });
    controller.render();
    const pending = root.list.actions[0].click();
    if (change === "revision") revision += 1;
    else stale = true;
    root.copyState.textContent = "较新的方案反馈";
    finishWrite();
    await pending;
    assert.equal(root.copyState.textContent, "较新的方案反馈");
  }
});

test("suppresses delayed feedback when a newer global operation takes over", async () => {
  const root = fakeRoot([0]);
  let activeToken = null;
  let sequence = 0;
  let finishWrite;
  const controller = mountDirectorItemRunSheetTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => false,
    getRevision: () => 1,
    beginOperation: () => (activeToken = { sequence: ++sequence }),
    isOperationCurrent: (token) => token === activeToken,
    writeText: () => new Promise((resolve) => { finishWrite = resolve; })
  });
  controller.render();
  const pending = root.list.actions[0].click();
  activeToken = { sequence: ++sequence };
  root.copyState.textContent = "全局新操作正在进行";
  finishWrite();
  await pending;
  assert.equal(root.copyState.textContent, "全局新操作正在进行");
});

test("destroy invalidates an in-flight copy before it can write feedback", async () => {
  const root = fakeRoot([0]);
  let finishWrite;
  const controller = mountDirectorItemRunSheetTools({
    root,
    getPlan: samplePlan,
    getPlanStale: () => false,
    getRevision: () => 1,
    writeText: () => new Promise((resolve) => { finishWrite = resolve; })
  });
  controller.render();
  const pending = root.list.actions[0].click();
  controller.destroy();
  root.copyState.textContent = "控制器已卸载";
  finishWrite();
  await pending;
  assert.equal(root.copyState.textContent, "控制器已卸载");
});
