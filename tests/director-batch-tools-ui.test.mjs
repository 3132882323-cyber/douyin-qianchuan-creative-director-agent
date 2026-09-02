import test from "node:test";
import assert from "node:assert/strict";
import { mountDirectorBatchTools } from "../src/director-batch-tools-ui.js";

class FakeNode {
  constructor() {
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  async click() {
    await this.listeners.get("click")?.();
  }
}

function fakeRoot() {
  const ids = [
    "director-batch-board-state",
    "director-batch-board-summary",
    "director-batch-board-feedback",
    "copy-director-batch-board",
    "copy-director-take-handoff",
    "copy-director-edit-assembly",
    "copy-director-cut-review"
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode()]));
  return { nodes, querySelector: (selector) => nodes[selector.replace(/^#/u, "")] || null };
}

function planItem(index, hook) {
  const id = index === 0 ? "BATCH-UI-B00" : `BATCH-UI-A${String(index).padStart(2, "0")}`;
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "自有母版",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "目标受众",
    hook,
    coreClaim: "可核验主张",
    scene: "真实现场",
    fixedElements: "受众、主张、场景、证据、时长和行动引导",
    production: {
      spokenScript: `${hook}\n随后进入证据`,
      storyboard: `0–3 秒｜结果近景｜${hook}｜单一焦点`,
      shootingTask: `测试编号：${id}\n必拍证据：完整过程和结果`,
      editingNotes: "第三秒接入同一证据段。",
      subtitleHighlights: `• ${hook}\n• 过程证据`,
      complianceChecklist: "核对事实和授权。"
    }
  };
}

function samplePlan() {
  return {
    batchId: "BATCH-UI",
    testVariable: "hook",
    items: [planItem(0, "先看结果"), planItem(1, "别急着判断"), planItem(2, "三秒看懂差别")]
  };
}

test("renders one fail-closed four-stage controller from current plan state", () => {
  const root = fakeRoot();
  let plan = null;
  let stale = false;
  const controller = mountDirectorBatchTools({ root, getPlan: () => plan, getPlanStale: () => stale, writeText: async () => {} });
  assert.equal(controller.mounted, true);
  assert.equal(controller.render(), null);
  assert.equal(root.nodes["director-batch-board-state"].textContent, "等待方案");
  assert.ok(["copy-director-batch-board", "copy-director-take-handoff", "copy-director-edit-assembly", "copy-director-cut-review"].every((id) => root.nodes[id].disabled));
  plan = samplePlan();
  const board = controller.render();
  assert.equal(board.copyable, true);
  assert.match(root.nodes["director-batch-board-summary"].textContent, /按 1 拍摄、2 接片、3 剪辑、4 验收顺序使用/u);
  assert.ok(["copy-director-batch-board", "copy-director-take-handoff", "copy-director-edit-assembly", "copy-director-cut-review"].every((id) => !root.nodes[id].disabled));
  stale = true;
  assert.equal(controller.render(), null);
  assert.equal(root.nodes["director-batch-board-state"].textContent, "方案已过期");
});

test("copies each stage through the injected clipboard and removes listeners on destroy", async () => {
  const root = fakeRoot();
  const writes = [];
  const controller = mountDirectorBatchTools({ root, getPlan: samplePlan, getPlanStale: () => false, writeText: async (value) => writes.push(value) });
  controller.render();
  await root.nodes["copy-director-batch-board"].click();
  await root.nodes["copy-director-take-handoff"].click();
  await root.nodes["copy-director-edit-assembly"].click();
  await root.nodes["copy-director-cut-review"].click();
  assert.equal(writes.length, 4);
  assert.match(writes[0], /批次共用镜头板/u);
  assert.match(writes[1], /批次收工接片单/u);
  assert.match(writes[2], /批次剪辑装配单/u);
  assert.match(writes[3], /批次成片验收单/u);
  const copiedFeedback = root.nodes["director-batch-board-feedback"].textContent;
  assert.match(copiedFeedback, /逐条选择通过、返剪或补拍/u);
  controller.render();
  assert.equal(root.nodes["director-batch-board-feedback"].textContent, copiedFeedback);
  controller.destroy();
  assert.ok(["copy-director-batch-board", "copy-director-take-handoff", "copy-director-edit-assembly", "copy-director-cut-review"].every((id) => !root.nodes[id].listeners.has("click")));

  const delayedRoot = fakeRoot();
  let revision = 1;
  let finishWrite;
  const delayed = mountDirectorBatchTools({
    root: delayedRoot,
    getPlan: samplePlan,
    getPlanStale: () => false,
    getRevision: () => revision,
    writeText: () => new Promise((resolve) => { finishWrite = resolve; })
  });
  delayed.render();
  const pendingCopy = delayedRoot.nodes["copy-director-take-handoff"].click();
  revision += 1;
  delayedRoot.nodes["director-batch-board-feedback"].textContent = "方案已经修改";
  finishWrite();
  await pendingCopy;
  assert.equal(delayedRoot.nodes["director-batch-board-feedback"].textContent, "方案已经修改");
});
