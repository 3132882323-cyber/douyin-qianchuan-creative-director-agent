import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTranscriptStructure } from "../src/material-analysis.js";
import { analysisReferenceId, createRevisionIdentity, normalizeRevisionIdentifier } from "../src/revision-id.js";

function sampleAnalysis() {
  return analyzeTranscriptStructure("先别划走。通勤上班族早晨整理总耗时。三步完成，现场实测 30 秒。", {
    sourceName: "本地正文.txt",
    generatedAt: "2026-08-08T01:02:03.000Z"
  });
}

test("creates deterministic anonymous analysis references without leaking source metadata", () => {
  const analysis = sampleAnalysis();
  const reference = analysisReferenceId(analysis);
  assert.match(reference, /^AN-[0-9a-f]{8}$/u);
  assert.equal(analysisReferenceId(structuredClone(analysis)), reference);
  assert.doesNotMatch(reference, /本地正文|Users|\\/u);
});

test("creates unique local test ids while allowing deterministic test entropy", () => {
  const analysis = sampleAnalysis();
  const options = {
    createdAt: "2026-08-08T02:03:04.000Z",
    parentVersionId: "parent-v3",
    entropy: "fixed-local-entropy"
  };
  const first = createRevisionIdentity(analysis, options);
  const repeated = createRevisionIdentity(analysis, options);
  const changed = createRevisionIdentity(analysis, { ...options, entropy: "another-local-entropy" });
  assert.deepEqual(first, repeated);
  assert.notEqual(first.revisionId, changed.revisionId);
  assert.equal(first.parentVersionId, "parent-v3");
  assert.match(first.revisionId, /^QC-\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
});

test("rejects unsafe or malformed parent identifiers", () => {
  assert.equal(normalizeRevisionIdentifier(" release:3 "), "release:3");
  assert.throws(() => normalizeRevisionIdentifier("C:\\Users\\Editor\\draft"), /只允许/u);
  assert.throws(() => normalizeRevisionIdentifier("空 格"), /只允许/u);
});
