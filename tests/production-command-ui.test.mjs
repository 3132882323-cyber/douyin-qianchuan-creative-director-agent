import test from "node:test";
import assert from "node:assert/strict";
import { mountProductionCommandBoard } from "../src/production-command-ui.js";

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
    this.hidden = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
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
    const ids = [
      "production-command-state",
      "production-command-summary",
      "production-command-list",
      "production-command-feedback",
      "copy-production-shift-brief",
      "manage-content-priority",
      "refresh-production-command"
    ];
    this.nodes = Object.fromEntries(ids.map((id) => [id, new FakeElement(id === "production-command-list" ? "div" : "button")]));
  }

  querySelector(selector) {
    return selector.startsWith("#") ? this.nodes[selector.slice(1)] || null : null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function command(index, overrides = {}) {
  return {
    id: `command:${index}`,
    projectId: `prj_command_${index}`,
    name: `项目 ${index}`,
    laneLabel: index === 1 ? "立即做" : "本周",
    reason: `人工排期理由 ${index}`,
    statusLabel: "待拍摄",
    detail: `执行说明 ${index}`,
    actionCode: `action_${index}`,
    actionLabel: `执行动作 ${index}`,
    testId: `test_${index}`,
    route: { type: "production", testId: `test_${index}`, target: `target_${index}` },
    dueOn: index === 1 ? "2026-09-02" : null,
    overdue: false,
    ...overrides
  };
}

function board(commands, overrides = {}) {
  return {
    commands,
    total: commands.length,
    hiddenCount: Math.max(0, commands.length - 3),
    blockedCount: 0,
    staleCount: 0,
    unplannedCount: 0,
    ...overrides
  };
}

function actionButtons(root) {
  return root.nodes["production-command-list"].querySelectorAll("[data-command-kind]");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("starts in loading state, reads one complete snapshot and renders only the first three model commands", async () => {
  const root = new FakeDocument();
  const snapshot = { projects: [{ id: "one" }], versions: [], results: [], takeReviews: [] };
  const commands = [command(1), command(2, {
    blocked: true,
    assignment: {
      source: "manual_take_review",
      ownerRole: "director",
      ownerLabel: "编导",
      materialCode: "A01-CAM1",
      takeNumber: "Take 03",
      issueTimecode: "00:02.4",
      nextCorrection: "补拍证据镜头"
    }
  }), command(3), command(4)];
  let loadCount = 0;
  let built = null;
  const controller = mountProductionCommandBoard({
    root,
    loadSnapshot: async () => {
      loadCount += 1;
      return snapshot;
    },
    buildBoard: (received, options) => {
      built = { received, options };
      return board(commands, { total: 4, hiddenCount: 1, blockedCount: 2, staleCount: 1, unplannedCount: 3 });
    },
    getCurrentProjectId: () => commands[0].projectId,
    getToday: () => TODAY
  });

  assert.equal(controller.mounted, true);
  assert.equal(root.nodes["production-command-state"].dataset.commandState, "loading");
  await controller.refresh();
  assert.equal(loadCount, 1);
  assert.equal(built.received, snapshot);
  assert.deepEqual(built.options, { currentProjectId: commands[0].projectId, today: TODAY });
  assert.equal(root.nodes["production-command-state"].dataset.commandState, "ready");
  assert.equal(root.nodes["production-command-list"].children.length, 3);
  assert.equal(root.nodes["production-command-list"].children[1].dataset.commandBlocked, "true");
  const assignment = root.nodes["production-command-list"].children[1].children.find((node) => node.className === "production-command-assignment");
  assert.match(assignment.textContent + assignment.children.map((node) => node.textContent).join(" "), /人工责任 · 编导/u);
  assert.match(assignment.children.map((node) => node.textContent).join(" "), /A01-CAM1 · Take 03 · 00:02\.4/u);
  assert.match(assignment.children.map((node) => node.textContent).join(" "), /下一条修正 · 补拍证据镜头/u);
  const targetVersion = root.nodes["production-command-list"].children[1].children
    .find((node) => node.className === "production-command-target");
  assert.equal(targetVersion.textContent, `目标版本 · ${commands[1].testId}`);
  assert.match(root.nodes["production-command-summary"].textContent, /阻塞 2/u);
  assert.match(root.nodes["production-command-summary"].textContent, /另有 1 项/u);

  const buttons = actionButtons(root);
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].textContent, "前往处理");
  assert.equal(buttons[0].dataset.commandProjectId, commands[0].projectId);
  assert.equal(buttons[0].dataset.commandId, commands[0].id);
  assert.equal(buttons[0].dataset.commandAction, commands[0].actionCode);
  assert.equal(buttons[0].dataset.commandTestId, commands[0].testId);
  assert.equal(buttons[1].textContent, "切换到项目");
  assert.equal(buttons[1].dataset.commandKind, "switch");
  const secondNextAction = root.nodes["production-command-list"].children[1].children
    .find((node) => node.className === "production-command-next");
  assert.equal(secondNextAction.textContent, `唯一下一步 · ${commands[1].actionLabel}`);
});

test("routes the exact current command or project switch once and locks every action while pending", async () => {
  const root = new FakeDocument();
  const current = command(1);
  const other = command(2);
  const actionGate = deferred();
  const calls = [];
  const controller = mountProductionCommandBoard({
    root,
    loadSnapshot: async () => ({}),
    buildBoard: () => board([current, other]),
    getCurrentProjectId: () => current.projectId,
    getToday: () => TODAY,
    runCurrentAction: async (received) => {
      calls.push(["run", received]);
      await actionGate.promise;
    },
    switchProject: async (projectId, received) => calls.push(["switch", projectId, received])
  });
  await controller.refresh();
  const buttons = actionButtons(root);
  const pending = buttons[0].click();
  await buttons[0].click();
  await buttons[1].click();
  assert.deepEqual(calls, [["run", current]]);
  assert.equal(root.nodes["manage-content-priority"].disabled, true);
  assert.equal(root.nodes["refresh-production-command"].disabled, true);
  actionGate.resolve();
  await pending;
  assert.match(root.nodes["production-command-feedback"].textContent, /已定位/u);
  assert.doesNotMatch(root.nodes["production-command-feedback"].textContent, /已执行/u);
  await buttons[1].click();
  assert.deepEqual(calls, [
    ["run", current],
    ["switch", other.projectId, other]
  ]);

  const cancelledRoot = new FakeDocument();
  const cancelled = mountProductionCommandBoard({
    root: cancelledRoot,
    loadSnapshot: async () => ({}),
    buildBoard: () => board([current, other]),
    getCurrentProjectId: () => current.projectId,
    getToday: () => TODAY,
    runCurrentAction: async () => false,
    switchProject: async () => false
  });
  await cancelled.refresh();
  await actionButtons(cancelledRoot)[0].click();
  assert.equal(cancelledRoot.nodes["production-command-feedback"].textContent, "操作已取消，未改变项目状态。");
  await actionButtons(cancelledRoot)[1].click();
  assert.equal(cancelledRoot.nodes["production-command-feedback"].textContent, "已取消切换，当前项目未变化。");
  assert.equal(actionButtons(cancelledRoot)[0].disabled, false);
});

test("shows empty and load-error states without reusing stale cards", async () => {
  const emptyRoot = new FakeDocument();
  const empty = mountProductionCommandBoard({
    root: emptyRoot,
    loadSnapshot: async () => ({}),
    buildBoard: () => board([]),
    getToday: () => TODAY
  });
  await empty.refresh();
  assert.equal(emptyRoot.nodes["production-command-state"].dataset.commandState, "empty");
  assert.equal(emptyRoot.nodes["production-command-list"].children.length, 0);
  assert.equal(emptyRoot.nodes["copy-production-shift-brief"].disabled, true);

  const errorRoot = new FakeDocument();
  const failure = mountProductionCommandBoard({
    root: errorRoot,
    loadSnapshot: async () => { throw new Error("IndexedDB 跨项目快照读取失败"); },
    buildBoard: () => board([command(1)]),
    getToday: () => TODAY
  });
  await failure.refresh();
  assert.equal(errorRoot.nodes["production-command-state"].dataset.commandState, "error");
  assert.match(errorRoot.nodes["production-command-summary"].textContent, /IndexedDB 跨项目快照读取失败/u);
  assert.equal(errorRoot.nodes["production-command-list"].children.length, 0);
  assert.equal(errorRoot.nodes["copy-production-shift-brief"].disabled, true);
});

test("an older async refresh cannot overwrite the latest complete snapshot", async () => {
  const root = new FakeDocument();
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const controller = mountProductionCommandBoard({
    root,
    loadSnapshot: () => {
      reads += 1;
      return reads === 1 ? first.promise : second.promise;
    },
    buildBoard: (snapshot) => board(snapshot.commands),
    getCurrentProjectId: () => "",
    getToday: () => TODAY
  });
  const oldRefresh = controller.refresh();
  const latestRefresh = controller.refresh();
  second.resolve({ commands: [command(2, { name: "新快照项目" })] });
  await latestRefresh;
  first.resolve({ commands: [command(1, { name: "旧快照项目" })] });
  await oldRefresh;
  assert.equal(reads, 2);
  assert.equal(root.nodes["production-command-list"].querySelector("strong").textContent, "新快照项目");
  assert.equal(root.nodes["production-command-state"].dataset.commandState, "ready");
});

test("copy brief and manage priority are routed once, refresh is guarded, and destroy suppresses late results", async () => {
  const root = new FakeDocument();
  const actionGate = deferred();
  const copyGate = deferred();
  const refreshGate = deferred();
  let manageCalls = 0;
  const copiedBoards = [];
  let loads = 0;
  const current = command(1);
  const controller = mountProductionCommandBoard({
    root,
    loadSnapshot: () => {
      loads += 1;
      return loads === 1 ? Promise.resolve({ commands: [current] }) : refreshGate.promise;
    },
    buildBoard: (snapshot) => board(snapshot.commands),
    getCurrentProjectId: () => current.projectId,
    getToday: () => TODAY,
    runCurrentAction: () => actionGate.promise,
    copyBrief: async (value) => {
      copiedBoards.push(value);
      await copyGate.promise;
    },
    managePriority: async () => { manageCalls += 1; }
  });
  await controller.refresh();
  const pendingCopy = root.nodes["copy-production-shift-brief"].click();
  await root.nodes["copy-production-shift-brief"].click();
  await root.nodes["manage-content-priority"].click();
  await root.nodes["refresh-production-command"].click();
  assert.deepEqual(copiedBoards, [controller.board]);
  assert.equal(manageCalls, 0);
  assert.equal(loads, 1);
  copyGate.resolve();
  await pendingCopy;
  assert.match(root.nodes["production-command-feedback"].textContent, /共 1 个项目/u);
  await root.nodes["manage-content-priority"].click();
  assert.equal(manageCalls, 1);

  const buttonRefresh = root.nodes["refresh-production-command"].click();
  await root.nodes["refresh-production-command"].click();
  assert.equal(loads, 2);
  refreshGate.resolve({ commands: [current] });
  await buttonRefresh;

  const pending = actionButtons(root)[0].click();
  controller.destroy();
  actionGate.resolve();
  await pending;
  assert.equal(root.nodes["production-command-feedback"].textContent, "");
  assert.equal(root.nodes["production-command-list"].listeners.has("click"), false);
  assert.equal(root.nodes["copy-production-shift-brief"].listeners.has("click"), false);
  assert.equal(root.nodes["manage-content-priority"].listeners.has("click"), false);
  assert.equal(root.nodes["refresh-production-command"].listeners.has("click"), false);

  const retryRoot = new FakeDocument();
  let copyAttempts = 0;
  const retryController = mountProductionCommandBoard({
    root: retryRoot,
    loadSnapshot: async () => ({ commands: [current] }),
    buildBoard: (snapshot) => board(snapshot.commands),
    getCurrentProjectId: () => current.projectId,
    getToday: () => TODAY,
    copyBrief: async () => {
      copyAttempts += 1;
      if (copyAttempts === 1) throw new Error("剪贴板暂不可用");
    }
  });
  await retryController.refresh();
  await retryRoot.nodes["copy-production-shift-brief"].click();
  assert.equal(retryRoot.nodes["production-command-feedback"].textContent, "剪贴板暂不可用");
  assert.equal(retryRoot.nodes["copy-production-shift-brief"].disabled, false);
  await retryRoot.nodes["copy-production-shift-brief"].click();
  assert.equal(copyAttempts, 2);
  assert.match(retryRoot.nodes["production-command-feedback"].textContent, /已复制今日素材生产排产单/u);
});
