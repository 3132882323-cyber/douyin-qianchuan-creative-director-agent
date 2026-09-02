import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_EDITOR_FIELD_PATHS, mountPlanEditor } from "../src/plan-editor-ui.js";

class FakeList {
  constructor() {
    this.listeners = new Map();
    this.children = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(target) {
    for (const listener of this.listeners.get("input") || []) listener({ target });
  }

  dispatchEvent(type, target, extra = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target, ...extra });
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

function fakeRoot() {
  const list = new FakeList();
  return { list, querySelector: (selector) => selector === "#plan-list" ? list : null };
}

function field({ tagName = "INPUT", index = "0", path = "hook", value = "新钩子" } = {}) {
  return { tagName, dataset: { index, path }, value };
}

test("routes every whitelisted plan field through one delegated input listener", () => {
  const root = fakeRoot();
  const edits = [];
  const controller = mountPlanEditor({ root, onEdit: (edit) => edits.push(edit) });
  assert.equal(controller.mounted, true);
  assert.equal(root.list.listeners.get("input").size, 1);
  PLAN_EDITOR_FIELD_PATHS.forEach((path, index) => root.list.dispatch(field({
    tagName: index % 2 ? "TEXTAREA" : "INPUT",
    index: String(index % 4),
    path,
    value: `${path}-${index}`
  })));
  assert.equal(edits.length, PLAN_EDITOR_FIELD_PATHS.length);
  assert.deepEqual(edits[0], { index: 0, path: "hypothesis", value: "hypothesis-0", node: field({ path: "hypothesis", value: "hypothesis-0" }) });
  assert.equal(edits.at(-1).path, "production.complianceChecklist");
  const replacement = field({ index: "2", path: "scene", value: "新场景" });
  root.list.replaceChildren(replacement);
  root.list.dispatch(replacement);
  assert.equal(root.list.listeners.get("input").size, 1);
  assert.equal(edits.length, PLAN_EDITOR_FIELD_PATHS.length + 1);
  assert.equal(edits.at(-1).value, "新场景");
});

test("ignores unsafe targets, reports edit failures and removes the shared listener", () => {
  const root = fakeRoot();
  const edits = [];
  const errors = [];
  const controller = mountPlanEditor({
    root,
    getItemCount: () => 1,
    onEdit: (edit) => {
      edits.push(edit);
      if (edit.path === "hook") throw new Error("plan unavailable");
    },
    onError: (error) => errors.push(error.message)
  });
  root.list.dispatch(field({ tagName: "BUTTON" }));
  root.list.dispatch(field({ index: "-1" }));
  root.list.dispatch(field({ index: "100" }));
  root.list.dispatch(field({ index: "NaN" }));
  root.list.dispatch(field({ index: "1" }));
  root.list.dispatch(field({ path: "__proto__.polluted" }));
  assert.equal(edits.length, 0);
  root.list.dispatch(field());
  assert.equal(edits.length, 1);
  assert.deepEqual(errors, ["plan unavailable"]);
  controller.destroy();
  assert.equal(root.list.listeners.get("input").size, 0);
  assert.equal(root.list.listeners.get("compositionstart").size, 0);
  assert.equal(root.list.listeners.get("compositionend").size, 0);
  root.list.dispatch(field({ path: "scene" }));
  assert.equal(edits.length, 1);
});

test("keeps IME composition in the field and commits its final value only once", () => {
  const root = fakeRoot();
  const edits = [];
  mountPlanEditor({
    root,
    getItemCount: () => 1,
    onEdit: (edit) => edits.push(edit.value)
  });
  const target = field({ value: "" });
  root.list.dispatchEvent("compositionstart", target);
  target.value = "你";
  root.list.dispatchEvent("input", target, { isComposing: true });
  target.value = "你好";
  root.list.dispatchEvent("input", target, { isComposing: true });
  assert.deepEqual(edits, []);
  root.list.dispatchEvent("compositionend", target);
  assert.deepEqual(edits, ["你好"]);
  root.list.dispatchEvent("input", target, { isComposing: false });
  assert.deepEqual(edits, ["你好"]);
  target.value = "你好！";
  root.list.dispatchEvent("input", target, { isComposing: false });
  assert.deepEqual(edits, ["你好", "你好！"]);
  root.list.dispatchEvent("compositionstart", target);
  root.list.dispatchEvent("compositionend", target);
  root.list.dispatchEvent("input", target, { isComposing: false });
  assert.deepEqual(edits, ["你好", "你好！"]);
});
