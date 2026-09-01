import test from "node:test";
import assert from "node:assert/strict";
import { createLatestOperationGuard } from "../src/operation-guard.js";

test("only accepts the latest operation in one scope", () => {
  const guard = createLatestOperationGuard();
  const first = guard.begin("transcript-import");
  const second = guard.begin("transcript-import");
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  assert.equal(guard.end(first), false);
  assert.equal(guard.end(second), true);
  assert.equal(guard.isCurrent(second), false);
});

test("cancels one scope without disturbing another", () => {
  const guard = createLatestOperationGuard();
  const transcript = guard.begin("transcript-import");
  const result = guard.begin("material-result-import");
  assert.equal(guard.cancel("transcript-import"), true);
  assert.equal(guard.isCurrent(transcript), false);
  assert.equal(guard.isCurrent(result), true);
});

test("invalidates every pending operation after a session reset", () => {
  const guard = createLatestOperationGuard();
  const transcript = guard.begin("transcript-import");
  const handoff = guard.begin("handoff-send");
  guard.invalidateAll();
  assert.equal(guard.isCurrent(transcript), false);
  assert.equal(guard.isCurrent(handoff), false);
  assert.equal(guard.isCurrent(guard.begin("transcript-import")), true);
});

test("rejects ambiguous or unbounded operation scopes", () => {
  const guard = createLatestOperationGuard();
  assert.throws(() => guard.begin(""), /范围无效/u);
  assert.throws(() => guard.cancel("../../reset"), /范围无效/u);
});
