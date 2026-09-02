import test from "node:test";
import assert from "node:assert/strict";
import { mountDirectorBlindReview } from "../src/director-blind-review-ui.js";

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
    "director-blind-review-state",
    "director-blind-review-summary",
    "director-blind-review-feedback",
    "copy-director-blind-review",
    "copy-director-blind-review-key",
    "copy-director-blind-review-decision"
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode()]));
  return { nodes, querySelector: (selector) => nodes[selector.replace(/^#/u, "")] || null };
}

function planItem(index, hook) {
  const id = index === 0 ? "BLIND-UI-B00" : `BLIND-UI-A${String(index).padStart(2, "0")}`;
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "内部自有母版",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "目标受众",
    hook,
    scene: "真实现场",
    fixedElements: "受众、主张、场景、证据与行动引导",
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
    batchId: "BLIND-UI",
    items: [planItem(0, "先看结果"), planItem(1, "别急着判断"), planItem(2, "三秒看懂差别")]
  };
}

test("renders waiting, ready, blocked and stale blind-review controls as one state", () => {
  const root = fakeRoot();
  let plan = null;
  let stale = false;
  const controller = mountDirectorBlindReview({ root, getPlan: () => plan, getPlanStale: () => stale, writeText: async () => {} });
  assert.equal(controller.mounted, true);
  assert.equal(controller.render(), null);
  assert.equal(root.nodes["director-blind-review-state"].textContent, "等待方案");
  plan = samplePlan();
  const review = controller.render();
  assert.equal(review.copyable, true);
  assert.match(root.nodes["director-blind-review-summary"].textContent, /按 1 盲审、2 揭晓、3 合议顺序使用/u);
  assert.ok(["copy-director-blind-review", "copy-director-blind-review-key", "copy-director-blind-review-decision"].every((id) => !root.nodes[id].disabled));
  plan.items[1].production.shootingTask = "普通说明";
  assert.equal(controller.render().copyable, false);
  assert.ok(["copy-director-blind-review", "copy-director-blind-review-key", "copy-director-blind-review-decision"].every((id) => root.nodes[id].disabled));
  plan = samplePlan();
  stale = true;
  assert.equal(controller.render(), null);
  assert.equal(root.nodes["director-blind-review-state"].textContent, "方案已过期");
});

test("copies the public pack, private key and decision sheet separately then removes listeners", async () => {
  const root = fakeRoot();
  const writes = [];
  const controller = mountDirectorBlindReview({ root, getPlan: samplePlan, getPlanStale: () => false, writeText: async (value) => writes.push(value) });
  controller.render();
  await root.nodes["copy-director-blind-review"].click();
  await root.nodes["copy-director-blind-review-key"].click();
  await root.nodes["copy-director-blind-review-decision"].click();
  assert.equal(writes.length, 3);
  assert.match(writes[0], /前三秒拍前盲审/u);
  assert.match(writes[1], /导演盲审映射/u);
  assert.match(writes[2], /导演合议单/u);
  assert.doesNotMatch(writes[0], /BLIND-UI-B00/u);
  assert.match(writes[1], /BLIND-UI-B00/u);
  const copiedFeedback = root.nodes["director-blind-review-feedback"].textContent;
  assert.match(copiedFeedback, /保留、单变量重写和淘汰中三选一/u);
  controller.render();
  assert.equal(root.nodes["director-blind-review-feedback"].textContent, copiedFeedback);
  controller.destroy();
  assert.ok(["copy-director-blind-review", "copy-director-blind-review-key", "copy-director-blind-review-decision"].every((id) => !root.nodes[id].listeners.has("click")));

  const delayedRoot = fakeRoot();
  let revision = 1;
  let finishWrite;
  const delayed = mountDirectorBlindReview({
    root: delayedRoot,
    getPlan: samplePlan,
    getPlanStale: () => false,
    getRevision: () => revision,
    writeText: () => new Promise((resolve) => { finishWrite = resolve; })
  });
  delayed.render();
  const pendingCopy = delayedRoot.nodes["copy-director-blind-review"].click();
  revision += 1;
  delayedRoot.nodes["director-blind-review-feedback"].textContent = "方案已经修改";
  finishWrite();
  await pendingCopy;
  assert.equal(delayedRoot.nodes["director-blind-review-feedback"].textContent, "方案已经修改");
});
