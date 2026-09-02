import test from "node:test";
import assert from "node:assert/strict";
import { firstPlanGap, mountPlanGapNavigator } from "../src/plan-gap-navigator.js";

class FakeButton {
  constructor() {
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.attributeWrites = 0;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  setAttribute(name, value) {
    this.attributeWrites += 1;
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    for (const listener of this.listeners.get("click") || []) listener({ target: this });
  }
}

class FakeField {
  constructor(index, path, card) {
    this.dataset = { index: String(index), path };
    this.card = card;
    this.focusCount = 0;
    this.scrollCalls = [];
  }

  closest(selector) {
    return selector === "details" ? this.card : null;
  }

  focus() {
    this.focusCount += 1;
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }
}

function fakeRoot(fields = []) {
  const button = new FakeButton();
  const list = { querySelectorAll: () => fields };
  return {
    button,
    list,
    querySelector(selector) {
      if (selector === "#focus-plan-gap") return button;
      if (selector === "#plan-list") return list;
      return null;
    }
  };
}

function assessment(items, ready = false) {
  return { ready, items };
}

function item(index, id, missingFields = []) {
  return { index, id, ready: missingFields.length === 0, missingFields };
}

test("selects the first safe missing field in plan and field order", () => {
  const result = firstPlanGap(assessment([
    item(0, "B00", [{ path: "__proto__.polluted", label: "非法字段" }]),
    item(1, "A01", [
      { path: "production.editingNotes", label: "剪辑要求" },
      { path: "hook", label: "前三秒钩子" }
    ]),
    item(2, "A02", [{ path: "scene", label: "拍摄场景" }])
  ]));
  assert.deepEqual(result, { index: 1, id: "A01", path: "production.editingNotes", label: "剪辑要求" });
  assert.equal(firstPlanGap({ ready: true, items: [item(0, "B00", [{ path: "hook", label: "钩子" }])] }), null);
  assert.equal(firstPlanGap({ ready: false, items: [{ index: 100, missingFields: [{ path: "hook", label: "钩子" }] }] }), null);
  assert.equal(firstPlanGap(null), null);
});

test("repeated render binds once and navigation opens, focuses and scrolls the exact field", () => {
  const card = { open: false };
  const other = new FakeField(0, "hook", { open: false });
  const target = new FakeField(1, "production.editingNotes", card);
  const root = fakeRoot([other, target]);
  let current = assessment([item(1, "A01", [{ path: "production.editingNotes", label: "剪辑要求" }])]);
  const controller = mountPlanGapNavigator({ root, getAssessment: () => current });

  for (let index = 0; index < 20; index += 1) controller.render();
  assert.equal(root.button.listeners.get("click").size, 1);
  assert.equal(root.button.attributeWrites, 1);
  assert.equal(root.button.disabled, false);
  assert.equal(root.button.hidden, false);
  assert.match(root.button.textContent, /A01 · 剪辑要求/u);
  root.button.click();
  assert.equal(card.open, true);
  assert.equal(target.focusCount, 1);
  assert.deepEqual(target.scrollCalls, [{ block: "center", inline: "nearest" }]);
  assert.equal(other.focusCount, 0);

  current = assessment([], true);
  controller.render();
  assert.equal(root.button.disabled, true);
  controller.destroy();
  assert.equal(root.button.listeners.get("click").size, 0);
});

test("reads the latest gap on every click and advances safely until complete", () => {
  const firstCard = { open: false };
  const nextCard = { open: false };
  const first = new FakeField(0, "hook", firstCard);
  const next = new FakeField(2, "scene", nextCard);
  const root = fakeRoot([first, next]);
  let current = assessment([item(0, "B00", [{ path: "hook", label: "前三秒钩子" }])]);
  const revealed = [];
  const controller = mountPlanGapNavigator({
    root,
    getAssessment: () => current,
    revealTarget: (target) => revealed.push(target)
  });

  assert.equal(controller.navigate(), true);
  current = assessment([item(0, "B00"), item(2, "A02", [{ path: "scene", label: "拍摄场景" }])]);
  assert.equal(controller.navigate(), true);
  assert.deepEqual(revealed, [first, next]);
  assert.equal(nextCard.open, true);

  current = assessment([item(0, "B00"), item(2, "A02")], true);
  assert.deepEqual(controller.render(), { code: "complete", gap: null });
  assert.equal(controller.navigate(), false);
  assert.equal(root.button.disabled, true);
  assert.equal(root.button.textContent, "开拍项已齐");
});

test("fails closed for missing, stale, malformed and unavailable targets", () => {
  const feedback = [];
  const root = fakeRoot([]);
  let stale = false;
  let current = null;
  const controller = mountPlanGapNavigator({
    root,
    getAssessment: () => current,
    getPlanStale: () => stale,
    onFeedback: (message) => feedback.push(message)
  });

  assert.deepEqual(controller.render(), { code: "waiting", gap: null });
  assert.equal(root.button.hidden, true);
  current = assessment([item(0, "B00", [{ path: "hook", label: "前三秒钩子" }])]);
  assert.equal(controller.navigate(), false);
  assert.match(feedback.at(-1), /暂时无法定位/u);

  stale = true;
  assert.deepEqual(controller.render(), { code: "stale", gap: null });
  assert.equal(root.button.disabled, true);
  assert.equal(controller.navigate(), false);

  stale = false;
  current = { ready: false, items: [{ index: 0, missingFields: [{ path: "unsafe", label: "非法" }] }] };
  assert.deepEqual(controller.render(), { code: "unavailable", gap: null });
  assert.equal(controller.navigate(), false);

  const throwingRoot = fakeRoot([]);
  const throwing = mountPlanGapNavigator({
    root: throwingRoot,
    getAssessment: () => { throw new Error("bad state"); },
    getPlanStale: () => { throw new Error("bad stale state"); }
  });
  assert.deepEqual(throwing.render(), { code: "unavailable", gap: null });
  assert.equal(throwing.navigate(), false);
});

test("reports a target that disappears before the scheduled reveal", () => {
  const feedback = [];
  const target = new FakeField(0, "hook", { open: false });
  const root = fakeRoot([target]);
  let unavailable;
  const controller = mountPlanGapNavigator({
    root,
    getAssessment: () => assessment([item(0, "B00", [{ path: "hook", label: "前三秒钩子" }])]),
    revealTarget: (_node, onUnavailable) => {
      unavailable = onUnavailable;
      return true;
    },
    onFeedback: (message) => feedback.push(message)
  });
  assert.equal(controller.navigate(), true);
  unavailable();
  assert.match(feedback.at(-1), /方案卡可能已经刷新/u);
});
