import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisHandoff } from "../src/analysis-handoff.js";
import { createCreativeRevisionDraft } from "../src/creative-revision.js";
import {
  ANALYSIS_HANDOFF_INBOX_KEY,
  ANALYSIS_HANDOFF_INBOX_KIND,
  ANALYSIS_HANDOFF_INBOX_TTL_MS,
  analysisHandoffForAnalysis,
  createAnalysisHandoffEnvelope,
  decideAnalysisHandoffPreview,
  enqueueAnalysisHandoff,
  inspectAnalysisHandoffInbox,
  openAnalysisHandoffSidePanel,
  resolveAnalysisHandoffInbox,
  validateAnalysisHandoffEnvelope
} from "../src/analysis-handoff-inbox.js";

const createdAt = "2026-08-07T02:00:00.000Z";
const analysis = () => ({
  schemaVersion: 1,
  kind: "qianchuan-rule-based-copy-structure-v1",
  method: "local_deterministic_rules",
  summary: { characters: 32, segments: 2, coveredStructures: 2, totalStructures: 7, structureCoveragePercent: 29 },
  coverage: {
    hook: { count: 1 }, audience: { count: 1 }, pain: { count: 0 }, selling_point: { count: 0 },
    evidence: { count: 0 }, scene: { count: 0 }, cta: { count: 0 }
  },
  segments: [
    { content: "先别划走，通勤上班族看这里", tags: ["hook", "audience"] },
    { content: "普通结构说明", tags: [] }
  ],
  recommendations: []
});

function handoff(offset = 0) {
  const value = analysis();
  if (offset) value.segments[0].content += String(offset);
  return createAnalysisHandoff(value, { createdAt });
}

function revisionAnalysis() {
  const value = analysis();
  value.generatedAt = "2026-08-07T01:59:00.000Z";
  value.segments = value.segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    source: { kind: "paragraph", cueIndex: index + 1, label: "", startMs: null, endMs: null, start: "", end: "" }
  }));
  return value;
}

function revisionDraft(value) {
  return createCreativeRevisionDraft(value, {
    selectedRecommendationIds: ["rev-hook"],
    testVariables: ["hook"],
    createdAt,
    entropy: "inbox-test"
  });
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; }
  };
}

test("creates a fixed two-hour session envelope without sensitive material fields", () => {
  const envelope = createAnalysisHandoffEnvelope(handoff(), { queuedAt: createdAt });
  assert.deepEqual(Object.keys(envelope), ["schemaVersion", "kind", "source", "queuedAt", "expiresAt", "handoff"]);
  assert.equal(envelope.kind, ANALYSIS_HANDOFF_INBOX_KIND);
  assert.equal(Date.parse(envelope.expiresAt) - Date.parse(envelope.queuedAt), ANALYSIS_HANDOFF_INBOX_TTL_MS);
  assert.doesNotMatch(JSON.stringify(envelope), /transcript|sourceName|fileName|video|localPath|C:\\/iu);
});

test("reuses one handoff id for the same analysis and creates a new one after analysis changes", () => {
  const firstAnalysis = analysis();
  const first = analysisHandoffForAnalysis(null, firstAnalysis, { createdAt });
  const repeated = analysisHandoffForAnalysis(first, firstAnalysis, { createdAt: "2026-08-07T02:01:00.000Z" });
  assert.equal(repeated.handoff.handoffId, first.handoff.handoffId);
  const changedAnalysis = analysis();
  changedAnalysis.segments[0].content += "新分析";
  const changed = analysisHandoffForAnalysis(repeated, changedAnalysis, { createdAt: "2026-08-07T02:01:00.000Z" });
  assert.notEqual(changed.handoff.handoffId, first.handoff.handoffId);
});

test("caches V2 only for the same analysis and same draft identity", () => {
  const value = revisionAnalysis();
  const draft = revisionDraft(value);
  const first = analysisHandoffForAnalysis(null, value, { createdAt, revisionDraft: draft });
  const repeated = analysisHandoffForAnalysis(first, value, { createdAt: "2026-08-07T02:01:00.000Z", revisionDraft: draft });
  assert.equal(first.handoff.schemaVersion, 2);
  assert.equal(repeated.handoff.handoffId, first.handoff.handoffId);
  const editedDraft = structuredClone(draft);
  editedDraft.hook = "仅修改后的新开场";
  const changed = analysisHandoffForAnalysis(repeated, value, { createdAt: "2026-08-07T02:01:00.000Z", revisionDraft: editedDraft });
  assert.notEqual(changed.handoff.handoffId, first.handoff.handoffId);
});

test("V2 keeps the same single-slot idempotency, conflict and expiry behavior", () => {
  const value = revisionAnalysis();
  const draft = revisionDraft(value);
  const firstHandoff = createAnalysisHandoff(value, { createdAt, revisionDraft: draft });
  const editedDraft = structuredClone(draft);
  editedDraft.hook = "另一版前三秒开场";
  const secondHandoff = createAnalysisHandoff(value, { createdAt, revisionDraft: editedDraft });
  const first = createAnalysisHandoffEnvelope(firstHandoff, { queuedAt: createdAt });
  const second = createAnalysisHandoffEnvelope(secondHandoff, { queuedAt: createdAt });
  const now = Date.parse(createdAt);
  assert.equal(resolveAnalysisHandoffInbox(first, first, { now }).status, "duplicate");
  assert.equal(resolveAnalysisHandoffInbox(first, second, { now }).status, "conflict");
  assert.equal(inspectAnalysisHandoffInbox(first, { now: now + ANALYSIS_HANDOFF_INBOX_TTL_MS }).status, "expired");
});

test("rejects unknown envelope fields, invalid source, oversize and invalid time", () => {
  const envelope = createAnalysisHandoffEnvelope(handoff(), { queuedAt: createdAt });
  assert.throws(() => validateAnalysisHandoffEnvelope({ ...envelope, extra: true }, { now: Date.parse(createdAt) }), /不受支持字段/u);
  assert.throws(() => validateAnalysisHandoffEnvelope({ ...envelope, source: "remote" }, { now: Date.parse(createdAt) }), /来源/u);
  assert.throws(() => validateAnalysisHandoffEnvelope({ ...envelope, expiresAt: createdAt }, { now: Date.parse(createdAt) }), /有效期/u);
  assert.throws(() => validateAnalysisHandoffEnvelope({ ...envelope, padding: "x".repeat(140 * 1024) }, { now: Date.parse(createdAt) }), /大小上限/u);
});

test("reports empty, ready, damaged and expired inbox states", () => {
  const envelope = createAnalysisHandoffEnvelope(handoff(), { queuedAt: createdAt });
  assert.equal(inspectAnalysisHandoffInbox(undefined).status, "empty");
  assert.equal(inspectAnalysisHandoffInbox(envelope, { now: Date.parse(createdAt) }).status, "ready");
  assert.equal(inspectAnalysisHandoffInbox({ broken: true }).status, "invalid");
  assert.equal(inspectAnalysisHandoffInbox(envelope, { now: Date.parse(createdAt) + ANALYSIS_HANDOFF_INBOX_TTL_MS }).status, "expired");
});

test("resolves empty slot, same-package idempotency and different-package conflict", () => {
  const one = createAnalysisHandoffEnvelope(handoff(), { queuedAt: createdAt });
  const two = createAnalysisHandoffEnvelope(handoff(2), { queuedAt: createdAt });
  const now = Date.parse(createdAt);
  assert.equal(resolveAnalysisHandoffInbox(undefined, one, { now }).status, "queued");
  assert.equal(resolveAnalysisHandoffInbox(one, one, { now }).status, "duplicate");
  assert.equal(resolveAnalysisHandoffInbox(one, two, { now }).status, "conflict");
  assert.equal(resolveAnalysisHandoffInbox({ broken: true }, one, { now }).status, "replaced-invalid");
  const later = createAnalysisHandoffEnvelope(handoff(2), { queuedAt: new Date(now + ANALYSIS_HANDOFF_INBOX_TTL_MS).toISOString() });
  assert.equal(resolveAnalysisHandoffInbox(one, later, { now: now + ANALYSIS_HANDOFF_INBOX_TTL_MS }).status, "replaced-expired");
});

test("does not replace an existing different preview without user action", () => {
  const envelope = createAnalysisHandoffEnvelope(handoff(), { queuedAt: createdAt });
  const now = Date.parse(createdAt);
  assert.equal(decideAnalysisHandoffPreview(null, envelope, { now }), "show");
  assert.equal(decideAnalysisHandoffPreview({ handoffId: envelope.handoff.handoffId }, envelope, { now }), "same");
  assert.equal(decideAnalysisHandoffPreview({ handoffId: "handoff-other" }, envelope, { now }), "pending");
});

test("enqueue writes and verifies an empty slot, keeps duplicates and rejects conflicts", async () => {
  const now = Date.parse(createdAt);
  const storage = memoryStorage();
  assert.equal((await enqueueAnalysisHandoff(storage, handoff(), { queuedAt: createdAt, now })).status, "queued");
  assert.ok(storage.data[ANALYSIS_HANDOFF_INBOX_KEY]);
  assert.equal((await enqueueAnalysisHandoff(storage, handoff(), { queuedAt: createdAt, now })).status, "duplicate");
  assert.equal((await enqueueAnalysisHandoff(storage, handoff(2), { queuedAt: createdAt, now })).status, "conflict");
});

test("enqueue fails closed when session storage is unavailable", async () => {
  await assert.rejects(() => enqueueAnalysisHandoff(null, handoff(), { queuedAt: createdAt }), /会话存储不可用/u);
  await assert.rejects(() => enqueueAnalysisHandoff({ get: async () => { throw new Error("off"); }, set: async () => {} }, handoff(), { queuedAt: createdAt }), /无法读取/u);
});

test("side panel opening has success, unsupported and rejected fallbacks", async () => {
  let options;
  assert.deepEqual(await openAnalysisHandoffSidePanel({ open: async (value) => { options = value; } }, { WINDOW_ID_CURRENT: -2 }), { opened: true, reason: "" });
  assert.deepEqual(options, { windowId: -2 });
  assert.equal((await openAnalysisHandoffSidePanel(null, null)).opened, false);
  const rejected = await openAnalysisHandoffSidePanel({ open: async () => { throw new Error("denied"); } }, { WINDOW_ID_CURRENT: -2 });
  assert.equal(rejected.opened, false);
  assert.match(rejected.reason, /点击扩展图标/u);
});
