import test from "node:test";
import assert from "node:assert/strict";
import { createPlanAutosave } from "../src/plan-autosave.js";

function manualTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimer(id) {
      callbacks.delete(id);
    },
    get size() {
      return callbacks.size;
    },
    async runOnly() {
      assert.equal(callbacks.size, 1);
      const [[id, callback]] = callbacks;
      callbacks.delete(id);
      return callback();
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test("debounces repeated edits and saves only the latest revision", async () => {
  const timers = manualTimers();
  const saves = [];
  const states = [];
  const autosave = createPlanAutosave({
    save: async ({ revision }) => saves.push(revision),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (state) => states.push(state.code)
  });
  autosave.schedule();
  autosave.schedule();
  autosave.schedule();
  assert.equal(timers.size, 1);
  await timers.runOnly();
  assert.deepEqual(saves, [3]);
  assert.deepEqual(autosave.getState(), {
    revision: 3,
    savedRevision: 3,
    pending: false,
    running: false,
    scheduled: false,
    error: null
  });
  assert.equal(states.at(-1), "saved");
});

test("serializes an in-flight save and never reports an older revision as current", async () => {
  const timers = manualTimers();
  const gates = [];
  const starts = [];
  const states = [];
  let active = 0;
  let maxActive = 0;
  const autosave = createPlanAutosave({
    save: async ({ revision }) => {
      starts.push(revision);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (state) => states.push({ code: state.code, revision: state.revision, savedRevision: state.savedRevision })
  });
  autosave.schedule();
  const flush = autosave.flush();
  await Promise.resolve();
  assert.deepEqual(starts, [1]);
  autosave.schedule();
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1, 2]);
  assert.equal(states.some((state) => state.code === "saved" && state.savedRevision === 1), false);
  gates[1].resolve();
  assert.equal(await flush, true);
  assert.equal(maxActive, 1);
  assert.equal(autosave.getState().savedRevision, 2);
  assert.equal(states.at(-1).code, "saved");
});

test("keeps a failed revision pending so an explicit flush can retry it", async () => {
  const timers = manualTimers();
  const states = [];
  let attempts = 0;
  const autosave = createPlanAutosave({
    save: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (state) => states.push(state)
  });
  autosave.schedule();
  assert.equal(await autosave.flush(), false);
  assert.equal(autosave.getState().pending, true);
  assert.equal(states.at(-1).code, "error");
  assert.match(states.at(-1).error.message, /storage unavailable/u);
  assert.equal(await autosave.flush(), true);
  assert.equal(attempts, 2);
  assert.equal(autosave.getState().pending, false);
  assert.equal(states.at(-1).code, "saved");
});
