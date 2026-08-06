import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkbenchOverview } from "../src/workbench-overview.js";

test("guides a new workbench session to local material selection", () => {
  const overview = buildWorkbenchOverview();
  assert.deepEqual(overview.next, {
    target: "source",
    focus: "material-video-files-trigger",
    label: "下一步：选择本地素材"
  });
  assert.equal(overview.steps.source.status, "current");
  assert.equal(overview.steps.processing.status, "pending");
});

test("focuses the first missing source prerequisite without starting work", () => {
  const overview = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: false,
    missingSourceField: "sourceRoot"
  });
  assert.equal(overview.next.target, "source");
  assert.equal(overview.next.focus, "material-source-root");
  assert.equal(overview.steps.source.text, "2 个 · 待补齐");
});

test("advances through processing, transcription and structure from real page state", () => {
  const ready = buildWorkbenchOverview({ filesCount: 2, sourceReady: true });
  assert.equal(ready.next.target, "processing");
  assert.equal(ready.next.focus, "create-material-tasks");
  assert.equal(ready.steps.source.status, "complete");

  const processed = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 0, completed: 0 }
  });
  assert.equal(processed.next.target, "processing");
  assert.equal(processed.next.focus, "export-material-manifest");
  assert.equal(processed.steps.processing.text, "4 项待执行");

  const completed = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 4, completed: 4, failed: 0, skipped: 0 }
  });
  assert.equal(completed.next.target, "transcription");
  assert.equal(completed.steps.processing.status, "complete");

  const transcribed = buildWorkbenchOverview({ transcriptLength: 1280 });
  assert.equal(transcribed.next.target, "structure");
  assert.equal(transcribed.next.focus, "analyze-transcript");
  assert.equal(transcribed.steps.transcription.status, "complete");

  const analyzed = buildWorkbenchOverview({
    transcriptLength: 1280,
    analysis: { coveredStructures: 6, totalStructures: 7, structureCoveragePercent: 86 }
  });
  assert.equal(analyzed.next.label, "查看分析结果");
  assert.equal(analyzed.steps.structure.text, "覆盖 6/7");
  assert.match(analyzed.summary, /结构覆盖 86%/u);
});

test("flags failed or skipped local processing without claiming completion", () => {
  const overview = buildWorkbenchOverview({
    filesCount: 1,
    sourceReady: true,
    processing: { total: 2, finished: 2, completed: 1, failed: 0, skipped: 1 }
  });
  assert.equal(overview.steps.processing.status, "attention");
  assert.equal(overview.current, "processing");
  assert.equal(overview.steps.processing.text, "1 成功 · 1 异常");
  assert.equal(overview.next.label, "下一步：检查处理结果");
  assert.equal(overview.next.focus, "import-material-result");
});

test("allows direct local text import to proceed without forcing a video task", () => {
  const overview = buildWorkbenchOverview({ transcriptLength: 42 });
  assert.equal(overview.steps.source.status, "pending");
  assert.equal(overview.steps.transcription.status, "complete");
  assert.equal(overview.steps.structure.status, "current");
  assert.equal(overview.next.target, "structure");
});
