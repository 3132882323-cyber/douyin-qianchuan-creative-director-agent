import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_STAGE_CODES,
  createProductionStatus,
  productionStageCode,
  productionStageLabel,
  sanitizeProductionStatus,
  summarizeProductionTimeline
} from "../src/production-status.js";

test("creates an explicit bounded manual production status", () => {
  const status = createProductionStatus("editing", "2026-08-31T01:00:00.000Z");
  assert.deepEqual(status, { stage: "editing", updatedAt: "2026-08-31T01:00:00.000Z" });
  assert.equal(productionStageLabel(status), "剪辑中");
  assert.ok(PRODUCTION_STAGE_CODES.includes("launched"));
});

test("keeps missing production status honestly untracked", () => {
  assert.equal(sanitizeProductionStatus(null), null);
  assert.equal(productionStageCode(null), "untracked");
  assert.equal(productionStageLabel(undefined), "未标记");
});

test("strips unknown fields and rejects invalid status or timestamps", () => {
  const status = sanitizeProductionStatus({ stage: "planned", updatedAt: "2026-08-31T01:00:00.000Z", inferredFrom: "export" });
  assert.equal("inferredFrom" in status, false);
  assert.throws(() => createProductionStatus("published", "2026-08-31T01:00:00.000Z"), /状态代码/u);
  assert.throws(() => createProductionStatus("ready", "yesterday"), /时间格式/u);
  assert.throws(() => sanitizeProductionStatus([]), /状态格式/u);
});

test("summarizes only explicit stages without mutating the timeline", () => {
  const timeline = [
    { version: { productionStatus: null } },
    { version: { productionStatus: createProductionStatus("planned", "2026-08-31T01:00:00.000Z") } },
    { version: { productionStatus: createProductionStatus("editing", "2026-08-31T02:00:00.000Z") } },
    { version: { productionStatus: createProductionStatus("launched", "2026-08-31T03:00:00.000Z") } },
    { version: { productionStatus: createProductionStatus("paused", "2026-08-31T04:00:00.000Z") } }
  ];
  const before = structuredClone(timeline);
  const summary = summarizeProductionTimeline(timeline);
  assert.equal(summary.total, 5);
  assert.equal(summary.untracked, 1);
  assert.equal(summary.active, 2);
  assert.equal(summary.launched, 1);
  assert.equal(summary.paused, 1);
  assert.deepEqual(timeline, before);
});

test("fails closed for a malformed production timeline", () => {
  assert.throws(() => summarizeProductionTimeline({}), /时间线格式/u);
  assert.throws(() => summarizeProductionTimeline([{ version: { productionStatus: { stage: "ready", updatedAt: "bad" } } }]), /时间格式/u);
});
