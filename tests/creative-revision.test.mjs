import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTranscriptStructure } from "../src/material-analysis.js";
import {
  CREATIVE_REVISION_EDITABLE_FIELDS,
  CREATIVE_REVISION_METHOD,
  creativeRevisionToMarkdown,
  creativeRevisionWithEdits,
  createCreativeRevisionDraft,
  revisionRecommendationsForAnalysis,
  validateCreativeRevisionDraft
} from "../src/creative-revision.js";
import { parseTranscriptDocument } from "../src/timed-transcript.js";

function sampleAnalysis() {
  const document = parseTranscriptDocument([
    "1", "00:00:00,000 --> 00:00:03,000", "先别划走，通勤上班族是不是总担心闷？", "",
    "2", "00:00:03,000 --> 00:00:08,000", "实拍面料轻薄透气，三步即可穿好。", "",
    "3", "00:00:08,000 --> 00:00:12,000", "办公室和地铁通勤都能穿，现在查看详情。"
  ].join("\n"), { name: "owned-captions.srt" });
  return analyzeTranscriptStructure(document.text, {
    sourceName: "本地字幕.srt",
    transcriptDocument: document,
    generatedAt: "2026-08-08T01:02:03.000Z"
  });
}

const deterministicOptions = {
  selectedRecommendationIds: ["rev-hook"],
  testVariables: ["hook"],
  parentVersionId: "base-v2",
  createdAt: "2026-08-08T02:03:04.000Z",
  entropy: "unit-test"
};

test("offers selectable improvements tied to analysis evidence", () => {
  const recommendations = revisionRecommendationsForAnalysis(sampleAnalysis());
  assert.equal(recommendations.length, 7);
  assert.deepEqual(recommendations.map((item) => item.id), [
    "rev-hook", "rev-audience", "rev-pain", "rev-selling_point", "rev-evidence", "rev-scene", "rev-cta"
  ]);
  assert.ok(recommendations.every((item) => item.advice && Array.isArray(item.evidenceSegmentIndexes)));
});

test("requires a selected improvement and exactly one primary test variable", () => {
  const analysis = sampleAnalysis();
  assert.throws(() => createCreativeRevisionDraft(analysis, { ...deterministicOptions, selectedRecommendationIds: [] }), /至少选择一项/u);
  assert.throws(() => createCreativeRevisionDraft(analysis, { ...deterministicOptions, testVariables: [] }), /只能包含一个/u);
  assert.throws(() => createCreativeRevisionDraft(analysis, { ...deterministicOptions, testVariables: ["hook", "scene"] }), /只能包含一个/u);
  assert.throws(() => createCreativeRevisionDraft(analysis, {
    ...deterministicOptions,
    selectedRecommendationIds: ["rev-hook", "rev-scene"]
  }), /多个测试变量/u);
});

test("generates a complete editable deterministic draft with local references", () => {
  const draft = createCreativeRevisionDraft(sampleAnalysis(), deterministicOptions);
  assert.equal(draft.method, CREATIVE_REVISION_METHOD);
  assert.equal(draft.primaryVariable.id, "hook");
  assert.equal(draft.parentVersionId, "base-v2");
  assert.match(draft.testId, /^QC-/u);
  assert.match(draft.sourceAnalysisId, /^AN-[0-9a-f]{8}$/u);
  assert.equal(draft.evidence[0].sourceLabel, "00:00:00.000 → 00:00:03.000 · 1");
  for (const field of CREATIVE_REVISION_EDITABLE_FIELDS) assert.equal(typeof draft[field], "string", `${field} should be editable text`);
  assert.doesNotMatch(JSON.stringify(draft), /owned-captions|本地字幕|Users|Cookie/u);
  assert.deepEqual(validateCreativeRevisionDraft(draft), draft);
});

test("edits only whitelisted draft fields and preserves immutable identity", () => {
  const draft = createCreativeRevisionDraft(sampleAnalysis(), deterministicOptions);
  const edited = creativeRevisionWithEdits(draft, { hook: "新的三秒开场，事实待编导复核。" });
  assert.equal(edited.hook, "新的三秒开场，事实待编导复核。");
  assert.equal(edited.testId, draft.testId);
  assert.throws(() => creativeRevisionWithEdits(draft, { testId: "changed" }), /不受支持字段/u);
});

test("fails closed for unknown fields, paths, active content and oversized drafts", () => {
  const draft = createCreativeRevisionDraft(sampleAnalysis(), deterministicOptions);
  assert.throws(() => validateCreativeRevisionDraft({ ...draft, hidden: "private" }), /不受支持字段/u);
  assert.throws(() => validateCreativeRevisionDraft({ ...draft, hook: "读取 C:\\Users\\Editor\\private.txt" }), /本机路径/u);
  assert.throws(() => validateCreativeRevisionDraft({ ...draft, hook: '<img src=x onerror="alert(1)">' }), /活动内容/u);
  assert.throws(() => validateCreativeRevisionDraft({ ...draft, spokenScript: "字".repeat(50_000) }), /48 KB|5000 字符/u);
});

test("exports an honest shootable-task Markdown document without outcome prediction", () => {
  const markdown = creativeRevisionToMarkdown(createCreativeRevisionDraft(sampleAnalysis(), deterministicOptions));
  assert.match(markdown, /下一版可拍任务草稿/u);
  assert.match(markdown, /唯一测试变量：前三秒钩子/u);
  assert.match(markdown, /不是投放效果预测/u);
});
