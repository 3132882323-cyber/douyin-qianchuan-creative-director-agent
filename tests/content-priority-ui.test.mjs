import test from "node:test";
import assert from "node:assert/strict";
import { createContentPriority } from "../src/content-priority.js";
import { mountContentPriorityBoard } from "../src/content-priority-ui.js";
import { createProjectRecord } from "../src/project-model.js";

const NOW = "2026-09-02T08:00:00.000Z";
const TODAY = "2026-09-02";

function dataKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function selectorMatch(node, selector) {
  if (selector === "strong") return node.tagName === "STRONG";
  const data = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/u);
  if (data) {
    const value = node.dataset[dataKey(data[1])];
    return data[2] === undefined ? value !== undefined : value === data[2];
  }
  return false;
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.value = "";
    this.selected = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
      if (node.tagName === "OPTION" && node.selected) this.value = node.value;
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute() {}

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  matches(selector) {
    return selectorMatch(this, selector);
  }

  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (cursor.matches(selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  async click() {
    if (this.disabled) return;
    let cursor = this;
    while (cursor) {
      const listener = cursor.listeners.get("click");
      if (listener) return listener({ target: this });
      cursor = cursor.parentNode;
    }
  }
}

class FakeDocument {
  constructor() {
    const ids = ["content-priority-state", "content-priority-summary", "content-priority-lanes", "content-priority-feedback"];
    this.nodes = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  }

  querySelector(selector) {
    return selector.startsWith("#") ? this.nodes[selector.slice(1)] || null : null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function project(index, name, task = {}) {
  return createProjectRecord({
    id: `prj_1234567${index}`,
    name,
    now: NOW,
    workspace: { creativeTask: { subject: `${name}选题`, targetAudience: "明确受众", creativeGoal: "看完理解差异", ...task } }
  });
}

function planned(source, lane, reason, manualOrder, dueOn = null) {
  return {
    ...source,
    contentPriority: createContentPriority({ project: source, lane, reason, dueOn, manualOrder, now: NOW })
  };
}

function cardFor(root, projectId) {
  return root.nodes["content-priority-lanes"].querySelectorAll("[data-project-id]").find((node) => node.dataset.projectId === projectId);
}

function actionFor(card, action) {
  return card.querySelectorAll("[data-priority-action]").find((node) => node.dataset.priorityAction === action);
}

test("renders four manual lanes, an honest unplanned inbox and only current immediate Top 3", () => {
  const root = new FakeDocument();
  const first = planned(project(1, "选题甲"), "now", "今天先验证核心开场", 0, "2026-09-01");
  const staleSource = planned(project(2, "选题乙"), "now", "演员档期只剩今天", 1);
  const stale = { ...staleSource, workspace: { ...staleSource.workspace, creativeTask: { ...staleSource.workspace.creativeTask, creativeGoal: "目标已经改变" } } };
  const unplanned = project(3, "选题丙");
  const controller = mountContentPriorityBoard({
    root,
    getProjects: () => [first, stale, unplanned],
    getCurrentProjectId: () => first.id,
    today: TODAY
  });
  const board = controller.render();
  assert.equal(controller.mounted, true);
  assert.equal(board.lanes.length, 4);
  assert.equal(root.nodes["content-priority-lanes"].children.length, 5);
  assert.match(root.nodes["content-priority-state"].textContent, /立即做 1 · 需重审 1 · 未排期 1/u);
  assert.match(root.nodes["content-priority-summary"].textContent, /选题甲：今天先验证核心开场/u);
  assert.doesNotMatch(root.nodes["content-priority-summary"].textContent, /演员档期只剩今天/u);
  assert.equal(cardFor(root, first.id).dataset.priorityState, "current");
  assert.equal(cardFor(root, stale.id).dataset.priorityState, "stale");
  assert.equal(actionFor(cardFor(root, first.id), "up").disabled, true);
});

test("saves the latest manual fields and keeps them visible when local persistence fails", async () => {
  const root = new FakeDocument();
  let projects = [project(1, "待排项目")];
  let captured = null;
  const controller = mountContentPriorityBoard({
    root,
    getProjects: () => projects,
    getCurrentProjectId: () => projects[0].id,
    today: TODAY,
    savePriority: async (projectId, draft) => {
      captured = { projectId, draft };
      projects = [planned(projects[0], draft.lane, draft.reason, 0, draft.dueOn)];
    }
  });
  controller.render();
  let card = cardFor(root, projects[0].id);
  card.querySelector('[data-priority-field="lane"]').value = "week";
  card.querySelector('[data-priority-field="reason"]').value = "本周先把证据镜头拍齐";
  card.querySelector('[data-priority-field="dueOn"]').value = "2026-09-05";
  controller.render();
  card = cardFor(root, projects[0].id);
  assert.equal(card.querySelector('[data-priority-field="lane"]').value, "week");
  assert.equal(card.querySelector('[data-priority-field="reason"]').value, "本周先把证据镜头拍齐");
  assert.equal(card.querySelector('[data-priority-field="dueOn"]').value, "2026-09-05");
  await actionFor(card, "save").click();
  assert.deepEqual(captured, {
    projectId: projects[0].id,
    draft: { lane: "week", reason: "本周先把证据镜头拍齐", dueOn: "2026-09-05" }
  });
  assert.match(root.nodes["content-priority-feedback"].textContent, /已保存/u);

  const failureRoot = new FakeDocument();
  const failure = mountContentPriorityBoard({
    root: failureRoot,
    getProjects: () => [project(2, "失败项目")],
    getCurrentProjectId: () => "prj_12345672",
    today: TODAY,
    savePriority: async () => { throw new Error("IndexedDB 写入失败，原排期保持不变"); }
  });
  failure.render();
  card = cardFor(failureRoot, "prj_12345672");
  const reason = card.querySelector('[data-priority-field="reason"]');
  reason.value = "这段输入不能丢失";
  await actionFor(card, "save").click();
  assert.equal(reason.value, "这段输入不能丢失");
  assert.match(failureRoot.nodes["content-priority-feedback"].textContent, /原排期保持不变/u);
});

test("preserves other unsaved cards across successful writes and reports drafts before project switching", async () => {
  const root = new FakeDocument();
  let projects = [project(1, "当前项目"), project(2, "另一项目")];
  const controller = mountContentPriorityBoard({
    root,
    getProjects: () => projects,
    getCurrentProjectId: () => projects[0].id,
    today: TODAY,
    savePriority: async (projectId, draft) => {
      projects = projects.map((entry) => entry.id === projectId
        ? planned(entry, draft.lane, draft.reason, 0, draft.dueOn)
        : entry);
    }
  });
  controller.render();
  const firstCard = cardFor(root, projects[0].id);
  const secondCard = cardFor(root, projects[1].id);
  firstCard.querySelector('[data-priority-field="lane"]').value = "now";
  firstCard.querySelector('[data-priority-field="reason"]').value = "今天先完成第一版拍摄";
  secondCard.querySelector('[data-priority-field="reason"]').value = "这条还在讨论排期原因";
  assert.equal(controller.unsavedDraftCount(), 2);

  await actionFor(firstCard, "save").click();
  const preservedSecond = cardFor(root, projects[1].id);
  assert.equal(preservedSecond.querySelector('[data-priority-field="reason"]').value, "这条还在讨论排期原因");
  assert.equal(controller.unsavedDraftCount(), 1);
});

test("routes move, clear and switch once, locks concurrent actions and suppresses stale feedback after destroy", async () => {
  const root = new FakeDocument();
  const first = planned(project(1, "项目一"), "week", "本周先完成第一版", 0);
  const second = planned(project(2, "项目二"), "week", "本周接着完成第二版", 1);
  const calls = [];
  let releaseSave;
  const controller = mountContentPriorityBoard({
    root,
    getProjects: () => [first, second],
    getCurrentProjectId: () => first.id,
    today: TODAY,
    savePriority: () => new Promise((resolve) => { releaseSave = resolve; }),
    movePriority: async (id, direction) => calls.push(["move", id, direction]),
    clearPriority: async (id) => calls.push(["clear", id]),
    switchProject: async (id) => { calls.push(["switch", id]); return false; },
    confirmClear: () => true
  });
  controller.render();
  const firstCard = cardFor(root, first.id);
  const pending = actionFor(firstCard, "save").click();
  assert.equal(firstCard.querySelector('[data-priority-field="reason"]').disabled, true);
  assert.equal(cardFor(root, second.id).querySelector('[data-priority-field="reason"]').disabled, true);
  await actionFor(cardFor(root, second.id), "switch").click();
  assert.deepEqual(calls, []);
  controller.destroy();
  releaseSave();
  await pending;
  assert.equal(root.nodes["content-priority-feedback"].textContent, "");
  assert.equal(root.nodes["content-priority-lanes"].listeners.has("click"), false);

  const routeRoot = new FakeDocument();
  const routes = mountContentPriorityBoard({
    root: routeRoot,
    getProjects: () => [first, second],
    getCurrentProjectId: () => first.id,
    today: TODAY,
    movePriority: async (id, direction) => calls.push(["move", id, direction]),
    clearPriority: async (id) => calls.push(["clear", id]),
    switchProject: async (id) => { calls.push(["switch", id]); return false; },
    confirmClear: () => true
  });
  routes.render();
  await actionFor(cardFor(routeRoot, second.id), "up").click();
  await actionFor(cardFor(routeRoot, second.id), "clear").click();
  await actionFor(cardFor(routeRoot, second.id), "switch").click();
  assert.deepEqual(calls, [
    ["move", second.id, "up"],
    ["clear", second.id],
    ["switch", second.id]
  ]);
});
