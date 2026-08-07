import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LOCAL_VIDEO_BATCH_LIMITS,
  TRANSCODE_MANIFEST_KIND,
  TRANSCODE_RESULT_KIND,
  buildPowerShellCommand,
  createTranscodeManifest,
  normalizeTranscodeSettings,
  transcodeProgress,
  validateLocalVideoBatch,
  validateTranscodeResult
} from "../src/transcode.js";

const ownedVideos = [
  { name: "主片.mp4", type: "video/mp4", size: 1024, lastModified: 1, webkitRelativePath: "自有原片/夏季/主片.mp4" },
  { name: "主片.mov", type: "video/quicktime", size: 2048, lastModified: 2, webkitRelativePath: "自有原片/冬季/主片.mov" }
];

function settings(overrides = {}) {
  return {
    authorizationConfirmed: true,
    sourceRoot: "D:\\品牌素材\\自有原片",
    outputRoot: "D:\\品牌素材\\转码输出",
    preset: "balanced",
    resolution: "1080p",
    frameRate: "30",
    audioBitrateKbps: 192,
    sampleRate: "48000",
    outputSuffix: "_千川版",
    ffmpegExecutable: "ffmpeg",
    ...overrides
  };
}

test("builds local MP4 H.264/AAC tasks that preserve metadata and chapters", () => {
  const manifest = createTranscodeManifest(ownedVideos, settings(), {
    createdAt: "2026-08-03T00:00:00.000Z",
    manifestId: "TX-TEST",
    creatorVersion: "1.0.4"
  });
  assert.equal(manifest.kind, TRANSCODE_MANIFEST_KIND);
  assert.equal(manifest.processing.remoteUpload, false);
  assert.equal(manifest.processing.overwrite, false);
  assert.equal(manifest.processing.preserveMetadata, true);
  assert.equal(manifest.processing.preserveChapters, true);
  assert.equal(manifest.tasks.length, 2);
  const task = manifest.tasks[0];
  assert.match(task.sourcePath, /D:\\品牌素材\\自有原片\\夏季\\主片\.mp4$/);
  assert.match(task.outputPath, /主片_千川版\.mp4$/);
  assert.deepEqual(task.ffmpegArguments.slice(0, 4), ["-hide_banner", "-n", "-i", task.sourcePath]);
  assert.ok(task.ffmpegArguments.includes("-map_metadata"));
  assert.equal(task.ffmpegArguments[task.ffmpegArguments.indexOf("-map_metadata") + 1], "0");
  assert.equal(task.ffmpegArguments[task.ffmpegArguments.indexOf("-map_chapters") + 1], "0");
  assert.equal(task.ffmpegArguments[task.ffmpegArguments.indexOf("-c:v") + 1], "libx264");
  assert.equal(task.ffmpegArguments[task.ffmpegArguments.indexOf("-c:a") + 1], "aac");
  assert.match(task.ffmpegArguments[task.ffmpegArguments.indexOf("-vf") + 1], /^scale=/);
  assert.doesNotMatch(task.ffmpegArguments.join(" "), /(?:crop|blur|delogo|filter_complex|-metadata )/i);
  assert.ok(task.ffmpegArguments.includes("-n"));
  assert.ok(!task.ffmpegArguments.includes("-y"));
});

test("supports quality and bitrate presets without exposing arbitrary filters", () => {
  const quality = normalizeTranscodeSettings(settings({ preset: "high_quality", resolution: "keep" }));
  assert.equal(quality.qualityMode, "crf");
  assert.equal(quality.crf, 18);
  const bitrate = createTranscodeManifest(ownedVideos.slice(0, 1), settings({ preset: "custom_bitrate", videoBitrateKbps: 8500, resolution: "keep" }), { manifestId: "TX-BITRATE" });
  const args = bitrate.tasks[0].ffmpegArguments;
  assert.equal(args[args.indexOf("-b:v") + 1], "8500k");
  assert.ok(!args.includes("-vf"));
});

test("requires explicit ownership authorization and valid local roots", () => {
  assert.throws(() => createTranscodeManifest(ownedVideos, settings({ authorizationConfirmed: false })), /自有或已获得明确转码授权/);
  assert.throws(() => createTranscodeManifest(ownedVideos, settings({ sourceRoot: "" })), /自有原片根目录/);
  assert.throws(() => createTranscodeManifest(ownedVideos, settings({ outputRoot: "relative-output" })), /Windows 绝对路径/);
  assert.throws(() => createTranscodeManifest(ownedVideos, settings({ ffmpegExecutable: "powershell.exe" })), /ffmpeg\.exe/);
  assert.throws(() => createTranscodeManifest([{ name: "说明.txt", type: "text/plain", size: 12 }], settings()), /不是受支持的视频格式/);
});

test("fails closed on unsupported, empty, oversized and excessive local video batches", () => {
  assert.deepEqual(LOCAL_VIDEO_BATCH_LIMITS, {
    maxFiles: 100,
    maxSingleFileBytes: 20 * 1024 ** 3,
    maxTotalBytes: 100 * 1024 ** 3
  });
  const limits = { maxFiles: 2, maxSingleFileBytes: 100, maxTotalBytes: 150 };
  assert.equal(validateLocalVideoBatch([{ name: "a.mp4", type: "video/mp4", size: 50 }], limits).totalBytes, 50);
  assert.throws(() => validateLocalVideoBatch([], limits), /请选择至少一个/);
  assert.throws(() => validateLocalVideoBatch([{ name: "a.txt", type: "text/plain", size: 5 }], limits), /不是受支持的视频格式/);
  assert.throws(() => validateLocalVideoBatch([{ name: "a.mp4", type: "video/mp4", size: 0 }], limits), /大小无效/);
  assert.throws(() => validateLocalVideoBatch([{ name: "a.mp4", type: "video/mp4", size: 101 }], limits), /单文件/);
  assert.throws(() => validateLocalVideoBatch([
    { name: "a.mp4", type: "video/mp4", size: 80 },
    { name: "b.mp4", type: "video/mp4", size: 80 }
  ], limits), /总大小/);
  assert.throws(() => validateLocalVideoBatch([
    { name: "a.mp4", type: "video/mp4", size: 10 },
    { name: "b.mp4", type: "video/mp4", size: 10 },
    { name: "c.mp4", type: "video/mp4", size: 10 }
  ], limits), /最多选择 2/);
  assert.throws(() => createTranscodeManifest([...ownedVideos, { name: "说明.txt", type: "text/plain", size: 8 }], settings()), /说明\.txt/);
});

test("quotes PowerShell paths instead of interpolating them", () => {
  const task = { ffmpegArguments: ["-i", "D:\\品牌's\\原片.mp4", "D:\\输出\\成片.mp4"] };
  const command = buildPowerShellCommand(task, "C:\\Program Files\\ffmpeg\\ffmpeg.exe");
  assert.match(command, /^& 'C:\\Program Files\\ffmpeg\\ffmpeg\.exe'/);
  assert.match(command, /品牌''s/);
});

test("imports matching worker results and summarizes failures", () => {
  const manifest = createTranscodeManifest(ownedVideos, settings({ resolution: "keep" }), { manifestId: "TX-RESULT" });
  const results = validateTranscodeResult({
    schemaVersion: 1,
    kind: TRANSCODE_RESULT_KIND,
    manifestId: "TX-RESULT",
    tasks: [
      { id: manifest.tasks[0].id, status: "completed", exitCode: 0, outputPath: manifest.tasks[0].outputPath },
      { id: manifest.tasks[1].id, status: "failed", exitCode: 1, outputPath: manifest.tasks[1].outputPath, failureReason: "输入编码不受支持" }
    ]
  }, manifest);
  const progress = transcodeProgress(results);
  assert.deepEqual({ total: progress.total, completed: progress.completed, failed: progress.failed, percent: progress.percent }, { total: 2, completed: 1, failed: 1, percent: 100 });
  assert.match(results[1].failureReason, /编码不受支持/);
  assert.throws(() => validateTranscodeResult({ schemaVersion: 1, kind: TRANSCODE_RESULT_KIND, manifestId: "OTHER", tasks: [] }, manifest), /不属于当前/);
});

test("ships an auditable local worker with fail-closed safeguards", async () => {
  const worker = await readFile(new URL("../tools/transcode-worker.ps1", import.meta.url), "utf8");
  assert.match(worker, /preserveMetadata/);
  assert.match(worker, /-map_metadata/);
  assert.match(worker, /-map_chapters/);
  assert.match(worker, /requires no-overwrite mode/);
  assert.match(worker, /Only aspect-ratio-preserving scale filters are allowed/);
  assert.doesNotMatch(worker, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/);
});
