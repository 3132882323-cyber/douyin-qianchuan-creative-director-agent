import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_TRANSCRIPTION_KIND,
  MATERIAL_VIDEO_BATCH_LIMITS,
  MATERIAL_WORKFLOW_KIND,
  analyzeTranscriptStructure,
  createLocalTranscriptionPlan,
  createMaterialProcessingManifest,
  transcriptTextFromDocument,
  validateDouyinSourceNote
} from "../src/material-analysis.js";
import { parseTranscriptDocument } from "../src/timed-transcript.js";

const ownedVideo = {
  name: "主片.mp4",
  type: "video/mp4",
  size: 1024,
  lastModified: 1,
  webkitRelativePath: "自有原片/主片.mp4"
};

function processingSettings(overrides = {}) {
  return {
    authorizationConfirmed: true,
    sourceRoot: "D:\\品牌素材\\自有原片",
    outputRoot: "D:\\品牌素材\\分析输出",
    ffmpegExecutable: "ffmpeg",
    sourceNote: "https://www.douyin.com/video/123456?from=owned-note",
    ...overrides
  };
}

function materialManifest(overrides = {}) {
  return createMaterialProcessingManifest([ownedVideo], processingSettings(overrides), {
    manifestId: "TX-MATERIAL",
    createdAt: "2026-08-03T00:00:00.000Z",
    creatorVersion: "1.0.4"
  });
}

test("accepts a Douyin HTTPS URL only as a source note", () => {
  const note = validateDouyinSourceNote("https://v.douyin.com/AbCdEf/?previous_page=app_code_link");
  assert.equal(note.hostname, "v.douyin.com");
  assert.equal(note.usage, "source_note_and_open_original_only");
  assert.equal(note.fetched, false);
  assert.equal(note.parsedMedia, false);
  assert.throws(() => validateDouyinSourceNote("http://www.douyin.com/video/1"), /https:\/\/douyin\.com/);
  assert.throws(() => validateDouyinSourceNote("https://douyin.com.evil.example/video/1"), /douyin\.com/);
  assert.throws(() => validateDouyinSourceNote("javascript:alert(1)"), /https:\/\/douyin\.com/);
});

test("builds only local standardization and fixed PCM audio extraction tasks", () => {
  const manifest = materialManifest();
  assert.equal(manifest.workflowKind, MATERIAL_WORKFLOW_KIND);
  assert.equal(manifest.processing.remoteUpload, false);
  assert.equal(manifest.sourceNote.fetched, false);
  assert.deepEqual(manifest.tasks.map((task) => task.operation), ["standardize_video", "extract_audio"]);
  const audioTask = manifest.tasks[1];
  assert.deepEqual(audioTask.ffmpegArguments, [
    "-hide_banner", "-n", "-i", audioTask.sourcePath,
    "-map", "0:a:0", "-map_metadata", "0", "-map_chapters", "0",
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    audioTask.outputPath
  ]);
  const commandText = manifest.tasks.flatMap((task) => task.ffmpegArguments).join(" ");
  assert.doesNotMatch(commandText, /douyin\.com|https?:|delogo|crop|filter_complex|metadata\s+-1/iu);
});

test("requires ownership authorization before creating material tasks", () => {
  assert.throws(() => materialManifest({ authorizationConfirmed: false }), /自有或已获得明确转码授权/);
});

test("applies stricter fail-closed video limits in the material workbench", () => {
  assert.deepEqual(MATERIAL_VIDEO_BATCH_LIMITS, {
    maxFiles: 40,
    maxSingleFileBytes: 10 * 1024 ** 3,
    maxTotalBytes: 40 * 1024 ** 3
  });
  assert.throws(() => createMaterialProcessingManifest([
    { ...ownedVideo, size: MATERIAL_VIDEO_BATCH_LIMITS.maxSingleFileBytes + 1 }
  ], processingSettings()), /单文件 10 GB/);
  const tooMany = Array.from({ length: 41 }, (_, index) => ({ ...ownedVideo, name: `${index}.mp4`, size: 1 }));
  assert.throws(() => createMaterialProcessingManifest(tooMany, processingSettings()), /最多选择 40/);
});

test("creates a fixed-argument whisper.cpp plan without remote upload", () => {
  const plan = createLocalTranscriptionPlan(materialManifest(), {
    mode: "whisper_cpp",
    executable: "C:\\Tools\\whisper.cpp\\whisper-cli.exe",
    modelPath: "C:\\Models\\brand's-base.bin",
    language: "zh"
  }, { createdAt: "2026-08-03T00:01:00.000Z" });
  assert.equal(plan.kind, LOCAL_TRANSCRIPTION_KIND);
  assert.equal(plan.remoteUpload, false);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].arguments.length, 9);
  assert.deepEqual(
    [plan.tasks[0].arguments[0], plan.tasks[0].arguments[2], plan.tasks[0].arguments[4], plan.tasks[0].arguments[5], plan.tasks[0].arguments[7]],
    ["-m", "-f", "-otxt", "-of", "-l"]
  );
  assert.match(plan.tasks[0].command, /^& 'C:\\Tools\\whisper\.cpp\\whisper-cli\.exe'/u);
  assert.match(plan.tasks[0].command, /brand''s-base\.bin/u);
  assert.doesNotMatch(plan.tasks[0].command, /Invoke-Expression|powershell(?:\.exe)?\s+-Command/iu);
});

test("rejects arbitrary executables, unsafe paths and remote-processing manifests", () => {
  const manifest = materialManifest();
  assert.throws(() => createLocalTranscriptionPlan(manifest, {
    mode: "whisper_cpp",
    executable: "C:\\Windows\\System32\\powershell.exe",
    modelPath: "C:\\Models\\ggml-base.bin"
  }), /仅允许明确配置 whisper-cli/);
  assert.throws(() => createLocalTranscriptionPlan(manifest, {
    mode: "whisper_cpp",
    executable: "C:\\Tools\\whisper-cli.exe\r\nStart-Process calc",
    modelPath: "C:\\Models\\ggml-base.bin"
  }), /不允许的字符/);
  assert.throws(() => createLocalTranscriptionPlan(manifest, {
    mode: "whisper_cpp",
    executable: "C:\\Tools\\whisper-cli.exe",
    modelPath: "C:\\Models\\ggml-base.bin:payload"
  }), /备用数据流或额外冒号/);
  const remoteManifest = { ...manifest, processing: { ...manifest.processing, remoteUpload: true } };
  assert.throws(() => createLocalTranscriptionPlan(remoteManifest, { mode: "text_import" }), /不接受包含远程上传/);
});

test("cleans local subtitle timing and analyzes the copy structure deterministically", () => {
  const transcript = transcriptTextFromDocument("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n先别划走，上班族夏天通勤是不是总担心闷？\n\n00:00:02.000 --> 00:00:05.000\n实测轻薄透气，现在点击购物车试试。\n");
  assert.doesNotMatch(transcript, /WEBVTT|-->/u);
  const result = analyzeTranscriptStructure(transcript, {
    sourceName: "本地字幕.vtt",
    generatedAt: "2026-08-03T00:02:00.000Z"
  });
  assert.equal(result.method, "local_deterministic_rules");
  assert.equal(result.coverage.hook.present, true);
  assert.equal(result.coverage.audience.present, true);
  assert.equal(result.coverage.pain.present, true);
  assert.equal(result.coverage.evidence.present, true);
  assert.equal(result.coverage.cta.present, true);
});

test("retains cue timing in analysis segments and invalidates edited transcript mappings", () => {
  const document = parseTranscriptDocument([
    "hook", "00:00:00,000 --> 00:00:02,000", "先别划走。", "",
    "proof", "00:00:02,000 --> 00:00:05,000", "现场实测 30 秒。"
  ].join("\n"), { name: "本地字幕.srt" });
  const result = analyzeTranscriptStructure(document.text, {
    sourceName: "本地字幕.srt",
    transcriptDocument: document,
    generatedAt: "2026-08-08T01:02:03.000Z"
  });
  assert.deepEqual(result.segments[0].source, {
    kind: "cue",
    cueIndex: 1,
    label: "hook",
    startMs: 0,
    endMs: 2000,
    start: "00:00:00.000",
    end: "00:00:02.000"
  });
  assert.throws(() => analyzeTranscriptStructure("编辑后的正文", { transcriptDocument: document }), /旧时间码.*已失效/u);
});
