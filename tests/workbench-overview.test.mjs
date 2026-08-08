import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkbenchOverview, buildWorkbenchResetPrompt } from "../src/workbench-overview.js";

test("treats a fresh workbench as an honest no-op reset", () => {
  const reset = buildWorkbenchResetPrompt();
  assert.equal(reset.hasWork, false);
  assert.deepEqual(reset.atRisk, []);
  assert.equal(reset.message, "");
});

test("names unsaved page-only work without implying storage or file deletion", () => {
  const reset = buildWorkbenchResetPrompt({
    entryMode: "video",
    filesCount: 2,
    processingTaskCount: 4,
    processingExported: false,
    transcriptionTaskCount: 2,
    transcriptionExported: true,
    transcriptLength: 1280,
    hasAnalysis: true,
    analysisPreserved: false,
    handoffState: "failed",
    hasSetupValues: true
  });
  assert.equal(reset.hasWork, true);
  assert.deepEqual(reset.atRisk, ["尚未导出的处理任务", "尚未导出或成功发送的分析结果"]);
  assert.match(reset.message, /无法从扩展恢复/u);
  assert.match(reset.message, /本地原文件/u);
  assert.match(reset.message, /chrome\.storage\.local 工作区/u);
  assert.match(reset.message, /已经发送到编导台会话收件箱的结果/u);
  assert.doesNotMatch(reset.message, /尚未导出的转写任务/u);
});

test("starts without forcing every user into the video route", () => {
  const overview = buildWorkbenchOverview();
  assert.deepEqual(overview.next, {
    type: "choose-entry",
    target: "",
    control: "",
    focus: "workbench-entry-video",
    label: "先选择一个开始方式",
    disabled: true
  });
  assert.equal(overview.entryMode, "");
  assert.equal(overview.phase.id, "entry");
  assert.equal(overview.phase.progress, 0);
  assert.equal(overview.current, null);
  assert.equal(overview.steps.source.status, "pending");
  assert.equal(overview.steps.processing.status, "pending");
});

test("offers video processing and existing-transcript routes through the same primary action", () => {
  const video = buildWorkbenchOverview({ entryMode: "video" });
  assert.equal(video.entryMode, "video");
  assert.equal(video.current, "source");
  assert.equal(video.next.control, "material-video-files");
  assert.equal(video.next.label, "开始：选择本地视频");

  const transcript = buildWorkbenchOverview({ entryMode: "transcript" });
  assert.equal(transcript.entryMode, "transcript");
  assert.equal(transcript.current, "transcription");
  assert.equal(transcript.next.control, "transcript-file");
  assert.equal(transcript.next.label, "开始：导入已有转写");
  assert.match(transcript.phase.guidance, /粘贴区/u);
});

test("switching to the transcript route preserves existing video progress without forcing it", () => {
  const overview = buildWorkbenchOverview({
    entryMode: "transcript",
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 0, completed: 0 },
    processingPrepared: true
  });
  assert.equal(overview.current, "transcription");
  assert.equal(overview.next.control, "transcript-file");
  assert.equal(overview.steps.source.status, "complete");
  assert.equal(overview.steps.processing.text, "4 项 · 清单已导出");
  assert.equal(overview.phase.progress, 25);
  assert.match(overview.entryNotice, /4 项视频处理任务仍保留/u);
  assert.match(overview.summary, /4 项处理任务/u);
});

test("focuses the first missing source prerequisite without bypassing validation", () => {
  const overview = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: false,
    missingSourceField: "sourceRoot"
  });
  assert.equal(overview.next.type, "focus");
  assert.equal(overview.next.target, "source");
  assert.equal(overview.next.focus, "material-source-root");
  assert.equal(overview.next.label, "下一步：填写原片根目录");
  assert.equal(overview.steps.source.text, "2 个 · 待补齐");
  assert.equal(overview.phase.tone, "attention");
});

test("turns the single primary action into the real next operation", () => {
  const ready = buildWorkbenchOverview({ filesCount: 2, sourceReady: true });
  assert.equal(ready.next.control, "create-material-tasks");
  assert.equal(ready.next.type, "activate");
  assert.equal(ready.phase.progress, 20);

  const generated = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 0, completed: 0 }
  });
  assert.equal(generated.next.control, "export-material-manifest");
  assert.equal(generated.steps.processing.text, "4 项待执行");

  const exported = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 0, completed: 0 },
    processingPrepared: true
  });
  assert.equal(exported.next.control, "import-material-result");
  assert.equal(exported.next.label, "下一步：导入本机结果");
  assert.equal(exported.steps.processing.text, "4 项 · 清单已导出");

  const completed = buildWorkbenchOverview({
    filesCount: 2,
    sourceReady: true,
    processing: { total: 4, finished: 4, completed: 4, failed: 0, skipped: 0 }
  });
  assert.equal(completed.next.control, "transcript-file");
  assert.equal(completed.steps.processing.status, "complete");
  assert.equal(completed.phase.progress, 55);

  const transcribed = buildWorkbenchOverview({ transcriptLength: 1280 });
  assert.equal(transcribed.next.control, "analyze-transcript");
  assert.equal(transcribed.phase.progress, 75);

  const analyzed = buildWorkbenchOverview({
    transcriptLength: 1280,
    analysis: { coveredStructures: 6, totalStructures: 7, structureCoveragePercent: 86 }
  });
  assert.equal(analyzed.next.control, "send-analysis-handoff");
  assert.equal(analyzed.next.label, "完成：发送到编导台");
  assert.equal(analyzed.phase.progress, 90);
  assert.match(analyzed.summary, /结构覆盖 86%/u);
});

test("flags failed or skipped processing and retains a retry action", () => {
  const overview = buildWorkbenchOverview({
    filesCount: 1,
    sourceReady: true,
    processing: { total: 2, finished: 2, completed: 1, failed: 0, skipped: 1 }
  });
  assert.equal(overview.steps.processing.status, "attention");
  assert.equal(overview.current, "processing");
  assert.equal(overview.steps.processing.text, "1 成功 · 1 异常");
  assert.equal(overview.next.label, "重试：导入处理结果");
  assert.equal(overview.next.control, "import-material-result");
  assert.equal(overview.phase.tone, "attention");
});

test("treats a successful handoff as complete and a conflict as recoverable", () => {
  const analysis = { coveredStructures: 6, totalStructures: 7, structureCoveragePercent: 86 };
  const sent = buildWorkbenchOverview({ transcriptLength: 1280, analysis, handoffState: "sent" });
  assert.equal(sent.phase.id, "complete");
  assert.equal(sent.phase.progress, 100);
  assert.equal(sent.next.type, "open-sidepanel");
  assert.equal(sent.next.label, "打开编导台查看结果");
  assert.equal(sent.current, null);

  const conflict = buildWorkbenchOverview({ transcriptLength: 1280, analysis, handoffState: "conflict" });
  assert.equal(conflict.phase.tone, "attention");
  assert.equal(conflict.steps.structure.status, "attention");
  assert.equal(conflict.next.type, "open-sidepanel");
  assert.match(conflict.phase.guidance, /没有覆盖/u);

  const failed = buildWorkbenchOverview({ transcriptLength: 1280, analysis, handoffState: "failed" });
  assert.equal(failed.next.control, "send-analysis-handoff");
  assert.equal(failed.next.label, "重试：发送到编导台");
});

test("keeps real transcript and analysis progress when the entry selection changes", () => {
  const overview = buildWorkbenchOverview({ entryMode: "video", transcriptLength: 42 });
  assert.equal(overview.entryMode, "video");
  assert.equal(overview.steps.source.status, "pending");
  assert.equal(overview.steps.transcription.status, "complete");
  assert.equal(overview.steps.structure.status, "current");
  assert.equal(overview.next.target, "structure");
  assert.equal(overview.next.control, "analyze-transcript");
  assert.match(overview.entryNotice, /当前转写正文仍保留/u);
});
