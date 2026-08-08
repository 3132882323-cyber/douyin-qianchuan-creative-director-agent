import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_HANDOFF_KIND,
  ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION,
  ANALYSIS_HANDOFF_METHOD,
  ANALYSIS_HANDOFF_SOURCE,
  MAX_ANALYSIS_HANDOFF_BYTES,
  analysisHandoffFillCandidates,
  createAnalysisHandoff,
  isDuplicateAnalysisHandoff,
  validateAnalysisHandoff,
  validateAnalysisHandoffFile
} from "../src/analysis-handoff.js";
import { createCreativeRevisionDraft } from "../src/creative-revision.js";

function sampleAnalysis(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "qianchuan-rule-based-copy-structure-v1",
    method: "local_deterministic_rules",
    sourceName: "不会进入交接包的本地文件.txt",
    summary: {
      characters: 72,
      segments: 5,
      coveredStructures: 4,
      totalStructures: 7,
      structureCoveragePercent: 57
    },
    coverage: {
      hook: { count: 0 },
      audience: { count: 1 },
      pain: { count: 1 },
      selling_point: { count: 1 },
      evidence: { count: 1 },
      scene: { count: 0 },
      cta: { count: 0 }
    },
    segments: [
      { index: 1, content: "通勤上班族可以先看这里", tags: ["audience"] },
      { index: 2, content: "早晨整理通常很耗时", tags: ["pain"] },
      { index: 3, content: "三步即可完成整理", tags: ["selling_point"] },
      { index: 4, content: "现场实测用时 30 秒", tags: ["evidence"] },
      { index: 5, content: "PRIVATE-RAW-CONTENT", tags: [] }
    ],
    recommendations: [
      { id: "hook", label: "ignored", advice: "补一句可以验证的开场信息。" },
      { id: "scene", label: "ignored", advice: "补一个真实使用场景。" },
      { id: "cta", label: "ignored", advice: "补充清晰的下一步行动。" }
    ],
    ...overrides
  };
}

function sampleRevisionAnalysis() {
  const value = sampleAnalysis({ generatedAt: "2026-08-06T03:00:00.000Z" });
  value.segments = value.segments.map((segment, index) => ({
    ...segment,
    index: index + 1,
    source: { kind: "paragraph", cueIndex: index + 1, label: "", startMs: null, endMs: null, start: "", end: "" }
  }));
  return value;
}

function sampleRevisionDraft(analysis = sampleRevisionAnalysis()) {
  return createCreativeRevisionDraft(analysis, {
    selectedRecommendationIds: ["rev-hook"],
    testVariables: ["hook"],
    createdAt,
    parentVersionId: "base-v1",
    entropy: "handoff-test"
  });
}

const createdAt = "2026-08-06T03:04:05.000Z";

test("builds a minimal fixed-schema handoff without raw transcript or file metadata", () => {
  const handoff = createAnalysisHandoff(sampleAnalysis(), { createdAt });
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.kind, ANALYSIS_HANDOFF_KIND);
  assert.deepEqual(handoff.source, { tool: ANALYSIS_HANDOFF_SOURCE, method: ANALYSIS_HANDOFF_METHOD });
  assert.equal(handoff.createdAt, createdAt);
  assert.match(handoff.handoffId, /^handoff-[0-9a-f]{8}$/u);
  assert.deepEqual(Object.keys(handoff.suggestions), ["targetAudience", "audienceProblems", "coreClaim", "evidence"]);
  assert.equal(handoff.suggestions.targetAudience, "通勤上班族可以先看这里");
  const serialized = JSON.stringify(handoff);
  assert.doesNotMatch(serialized, /PRIVATE-RAW-CONTENT|"sourceName"|"file"|"video"|"path"/iu);
  assert.deepEqual(validateAnalysisHandoff(handoff), handoff);
});

test("adds a strictly validated revision draft only in the backwards-compatible V2 package", () => {
  const analysis = sampleRevisionAnalysis();
  const revisionDraft = sampleRevisionDraft(analysis);
  const handoff = createAnalysisHandoff(analysis, { createdAt, revisionDraft });
  assert.equal(handoff.schemaVersion, ANALYSIS_HANDOFF_LATEST_SCHEMA_VERSION);
  assert.equal(handoff.revisionDraft.testId, revisionDraft.testId);
  assert.equal(handoff.revisionDraft.primaryVariable.id, "hook");
  assert.deepEqual(validateAnalysisHandoff(handoff), handoff);
  assert.equal(createAnalysisHandoff(analysis, { createdAt }).schemaVersion, 1, "legacy creation remains V1");
});

test("V2 rejects mismatched analysis references and unsafe revision fields", () => {
  const analysis = sampleRevisionAnalysis();
  const revisionDraft = sampleRevisionDraft(analysis);
  const otherAnalysis = sampleRevisionAnalysis();
  otherAnalysis.segments[0].content += "另一份分析";
  assert.throws(() => createAnalysisHandoff(otherAnalysis, { createdAt, revisionDraft }), /与当前结构分析不一致/u);

  const handoff = createAnalysisHandoff(analysis, { createdAt, revisionDraft });
  const unknown = structuredClone(handoff);
  unknown.revisionDraft.hiddenPath = "secret";
  assert.throws(() => validateAnalysisHandoff(unknown), /不受支持字段/u);
  const active = structuredClone(handoff);
  active.revisionDraft.hook = '<script>alert(1)</script>';
  assert.throws(() => validateAnalysisHandoff(active), /活动内容/u);
});

test("rejects the wrong schema, kind, source or analysis method", () => {
  const handoff = createAnalysisHandoff(sampleAnalysis(), { createdAt });
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.kind = "unknown"; },
    (value) => { value.source.tool = "remote-service"; },
    (value) => { value.source.method = "prediction_model"; }
  ]) {
    const changed = structuredClone(handoff);
    mutate(changed);
    assert.throws(() => validateAnalysisHandoff(changed));
  }
  assert.throws(() => createAnalysisHandoff(sampleAnalysis({ method: "prediction_model" }), { createdAt }), /确定性结构分析/u);
});

test("enforces JSON extension, content type and the 128 KB file limit", () => {
  assert.deepEqual(validateAnalysisHandoffFile({ name: "analysis-handoff.json", size: 1024, type: "application/json" }), {
    name: "analysis-handoff.json",
    size: 1024,
    type: "application/json"
  });
  assert.throws(() => validateAnalysisHandoffFile({ name: "analysis.txt", size: 1024, type: "application/json" }), /\.json/u);
  assert.throws(() => validateAnalysisHandoffFile({ name: "analysis.json", size: MAX_ANALYSIS_HANDOFF_BYTES + 1, type: "application/json" }), /文件大小/u);
  assert.throws(() => validateAnalysisHandoffFile({ name: "analysis.json", size: 10, type: "video/mp4" }), /类型/u);

  const oversizedDocument = { ...createAnalysisHandoff(sampleAnalysis(), { createdAt }), padding: "x".repeat(MAX_ANALYSIS_HANDOFF_BYTES) };
  assert.throws(() => validateAnalysisHandoff(oversizedDocument), /128 KB/u);
});

test("rejects unknown or prototype-like fields instead of carrying hidden data", () => {
  const handoff = createAnalysisHandoff(sampleAnalysis(), { createdAt });
  const unknown = structuredClone(handoff);
  unknown.privateFilePath = "secret";
  assert.throws(() => validateAnalysisHandoff(unknown), /不受支持字段/u);

  const prototypeKey = JSON.parse(JSON.stringify(handoff));
  prototypeKey.suggestions.__proto_marker__ = "blocked";
  assert.throws(() => validateAnalysisHandoff(prototypeKey), /不受支持字段/u);

  const parsed = JSON.parse(JSON.stringify(handoff).replace(/\{/, '{"__proto__":{"polluted":true},'));
  assert.throws(() => validateAnalysisHandoff(parsed), /不受支持字段/u);
  assert.equal({}.polluted, undefined);
});

test("rejects overlong suggestions, machine paths and active content", () => {
  const longAnalysis = sampleAnalysis();
  longAnalysis.segments[0].content = "人".repeat(801);
  assert.throws(() => createAnalysisHandoff(longAnalysis, { createdAt }), /800 字符/u);

  const pathAnalysis = sampleAnalysis();
  pathAnalysis.segments[0].content = "请读取 C:\\Users\\Editor\\private.txt";
  assert.throws(() => createAnalysisHandoff(pathAnalysis, { createdAt }), /本机路径/u);

  const activeAnalysis = sampleAnalysis();
  activeAnalysis.segments[0].content = '<img src=x onerror="alert(1)">';
  assert.throws(() => createAnalysisHandoff(activeAnalysis, { createdAt }), /活动内容/u);
});

test("detects repeat imports and maps only non-empty suggestions into empty task fields", () => {
  const handoff = createAnalysisHandoff(sampleAnalysis(), { createdAt });
  assert.equal(isDuplicateAnalysisHandoff(handoff, ""), false);
  assert.equal(isDuplicateAnalysisHandoff(handoff, handoff.handoffId), true);
  const appliedIds = new Set();
  assert.equal(isDuplicateAnalysisHandoff(handoff, appliedIds), false, "preview does not mark a handoff as applied");
  assert.equal(isDuplicateAnalysisHandoff(handoff, appliedIds), false, "clearing an unapplied preview permits re-import");
  appliedIds.add(handoff.handoffId);
  assert.equal(isDuplicateAnalysisHandoff(handoff, appliedIds), true, "a successfully applied handoff cannot be applied again in the session");
  const candidates = analysisHandoffFillCandidates(handoff, {
    targetAudience: "保留现有受众",
    audienceProblems: "",
    coreClaim: "",
    evidence: "已有证据"
  });
  assert.deepEqual(candidates.map(({ field, canFill }) => [field, canFill]), [
    ["targetAudience", false],
    ["audienceProblems", true],
    ["coreClaim", true],
    ["evidence", false]
  ]);
});

test("detects a changed payload even when an attacker reuses the previous id", () => {
  const handoff = createAnalysisHandoff(sampleAnalysis(), { createdAt });
  const changed = structuredClone(handoff);
  changed.suggestions.coreClaim = "被修改的建议";
  assert.throws(() => validateAnalysisHandoff(changed), /校验标识/u);
});
