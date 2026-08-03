export const TRANSCODE_MANIFEST_KIND = "qianchuan-owned-master-transcode-v1";
export const TRANSCODE_RESULT_KIND = "qianchuan-owned-master-transcode-result-v1";

export const TRANSCODE_PRESETS = {
  balanced: { label: "均衡", encoderPreset: "medium", qualityMode: "crf", crf: 23, audioBitrateKbps: 192 },
  high_quality: { label: "高质量", encoderPreset: "slow", qualityMode: "crf", crf: 18, audioBitrateKbps: 256 },
  compact: { label: "小体积", encoderPreset: "medium", qualityMode: "crf", crf: 28, audioBitrateKbps: 128 },
  custom_bitrate: { label: "指定码率", encoderPreset: "medium", qualityMode: "bitrate", videoBitrateKbps: 6000, audioBitrateKbps: 192 }
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg", ".mts", ".m2ts"]);
const RESOLUTIONS = new Set(["keep", "1080p", "720p", "480p"]);
const FRAME_RATES = new Set(["keep", "24", "25", "30", "50", "60"]);
const SAMPLE_RATES = new Set(["keep", "44100", "48000"]);

function cleanText(value, label, { required = false, maxLength = 500 } = {}) {
  const text = String(value ?? "").trim();
  if (/\r|\n|\0/.test(text)) throw new Error(`${label}不能包含换行或空字符`);
  if (required && !text) throw new Error(`请填写${label}`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function boundedInteger(value, fallback, min, max, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}必须在 ${min}-${max} 之间`);
  return parsed;
}

function safeSuffix(value) {
  let suffix = cleanText(value || "_transcoded", "输出后缀", { maxLength: 48 });
  suffix = suffix.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  if (!suffix) suffix = "_transcoded";
  if (!suffix.startsWith("_") && !suffix.startsWith("-")) suffix = `_${suffix}`;
  return suffix;
}

function normalizedRoot(value, label) {
  const root = cleanText(value, label, { required: true }).replace(/[\\/]+$/g, "");
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(root)) throw new Error(`${label}必须是 Windows 绝对路径`);
  return root;
}

function normalizedFfmpegExecutable(value) {
  const executable = cleanText(value || "ffmpeg", "FFmpeg 路径", { required: true, maxLength: 260 });
  const leaf = executable.split(/[\\/]/).pop().toLowerCase();
  if (!new Set(["ffmpeg", "ffmpeg.exe"]).has(leaf)) throw new Error("FFmpeg 路径必须指向 ffmpeg 或 ffmpeg.exe");
  return executable;
}

export function normalizeTranscodeSettings(input = {}) {
  const presetKey = Object.hasOwn(TRANSCODE_PRESETS, input.preset) ? input.preset : "balanced";
  const preset = TRANSCODE_PRESETS[presetKey];
  const resolution = RESOLUTIONS.has(String(input.resolution)) ? String(input.resolution) : "keep";
  const frameRate = FRAME_RATES.has(String(input.frameRate)) ? String(input.frameRate) : "keep";
  const sampleRate = SAMPLE_RATES.has(String(input.sampleRate)) ? String(input.sampleRate) : "48000";
  const qualityMode = input.qualityMode === "bitrate" || preset.qualityMode === "bitrate" ? "bitrate" : "crf";
  return {
    preset: presetKey,
    container: "mp4",
    videoCodec: "libx264",
    audioCodec: "aac",
    encoderPreset: preset.encoderPreset,
    resolution,
    frameRate,
    qualityMode,
    crf: boundedInteger(input.crf, preset.crf ?? 23, 0, 51, "CRF"),
    videoBitrateKbps: boundedInteger(input.videoBitrateKbps, preset.videoBitrateKbps ?? 6000, 300, 100000, "视频码率"),
    audioBitrateKbps: boundedInteger(input.audioBitrateKbps, preset.audioBitrateKbps, 32, 512, "音频码率"),
    sampleRate,
    outputSuffix: safeSuffix(input.outputSuffix),
    ffmpegExecutable: normalizedFfmpegExecutable(input.ffmpegExecutable),
    sourceRoot: normalizedRoot(input.sourceRoot, "自有原片根目录"),
    outputRoot: normalizedRoot(input.outputRoot, "输出目录"),
    overwrite: false,
    preserveMetadata: true,
    preserveChapters: true
  };
}

export function isSupportedVideoFile(file = {}) {
  if (String(file.type || "").toLowerCase().startsWith("video/")) return true;
  const name = String(file.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot));
}

export function ownedMasterRelativePath(file = {}) {
  const raw = cleanText(file.webkitRelativePath || file.relativePath || file.name, "文件相对路径", { required: true, maxLength: 500 }).replace(/\//g, "\\");
  const parts = raw.split("\\").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("文件相对路径不能包含 . 或 .. 段");
  if ((file.webkitRelativePath || file.relativePath) && parts.length > 1) parts.shift();
  return parts.join("\\") || cleanText(file.name, "文件名", { required: true, maxLength: 260 });
}

function joinWindowsPath(root, relativePath) {
  return `${root.replace(/[\\/]+$/g, "")}\\${relativePath.replace(/^[\\/]+/g, "").replace(/\//g, "\\")}`;
}

function splitName(relativePath) {
  const name = relativePath.split(/[\\/]/).pop() || "video";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: "" };
}

function resolutionFilter(resolution) {
  const widths = { "1080p": [1920, 1080], "720p": [1280, 720], "480p": [854, 480] };
  const bounds = widths[resolution];
  if (!bounds) return null;
  const [landscapeWidth, portraitWidth] = bounds;
  return `scale=if(gte(iw\\,ih)\\,min(${landscapeWidth}\\,iw)\\,min(${portraitWidth}\\,iw)):-2`;
}

function buildArguments(sourcePath, outputPath, settings) {
  const args = [
    "-hide_banner", "-n", "-i", sourcePath,
    "-map", "0:v:0", "-map", "0:a?",
    "-map_metadata", "0", "-map_chapters", "0",
    "-c:v", settings.videoCodec,
    "-preset", settings.encoderPreset
  ];
  if (settings.qualityMode === "bitrate") args.push("-b:v", `${settings.videoBitrateKbps}k`);
  else args.push("-crf", String(settings.crf));
  args.push("-pix_fmt", "yuv420p");
  const scale = resolutionFilter(settings.resolution);
  if (scale) args.push("-vf", scale);
  if (settings.frameRate !== "keep") args.push("-r", settings.frameRate);
  args.push("-c:a", settings.audioCodec, "-b:a", `${settings.audioBitrateKbps}k`);
  if (settings.sampleRate !== "keep") args.push("-ar", settings.sampleRate);
  args.push("-movflags", "+faststart", outputPath);
  return args;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildPowerShellCommand(task, ffmpegExecutable = "ffmpeg") {
  return `& ${powerShellQuote(ffmpegExecutable)} ${task.ffmpegArguments.map(powerShellQuote).join(" ")}`;
}

export function createTranscodeManifest(files, rawSettings = {}, options = {}) {
  if (!rawSettings.authorizationConfirmed) throw new Error("请先确认所选文件为商家自有或已获得明确转码授权的原片");
  const settings = normalizeTranscodeSettings(rawSettings);
  const descriptors = [...files].filter(isSupportedVideoFile);
  if (!descriptors.length) throw new Error("请选择至少一个可识别的视频原片");
  const createdAt = options.createdAt || new Date().toISOString();
  const randomPart = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10);
  const manifestId = options.manifestId || `TX-${createdAt.replace(/\D/g, "").slice(0, 14)}-${randomPart}`;
  const usedNames = new Map();
  const tasks = descriptors.map((file, index) => {
    const relativePath = ownedMasterRelativePath(file);
    const { stem } = splitName(relativePath);
    const baseName = `${stem}${settings.outputSuffix}`;
    const occurrence = (usedNames.get(baseName.toLowerCase()) || 0) + 1;
    usedNames.set(baseName.toLowerCase(), occurrence);
    const outputName = `${baseName}${occurrence > 1 ? `-${occurrence}` : ""}.mp4`;
    const sourcePath = joinWindowsPath(settings.sourceRoot, relativePath);
    const outputPath = joinWindowsPath(settings.outputRoot, outputName);
    const task = {
      id: `${manifestId}-${String(index + 1).padStart(3, "0")}`,
      source: {
        name: cleanText(file.name, "文件名", { required: true, maxLength: 260 }),
        relativePath,
        size: Number(file.size || 0),
        lastModified: Number(file.lastModified || 0)
      },
      sourcePath,
      outputPath,
      ffmpegArguments: [],
      status: "pending",
      progress: 0,
      failureReason: ""
    };
    task.ffmpegArguments = buildArguments(sourcePath, outputPath, settings);
    task.powerShellCommand = buildPowerShellCommand(task, settings.ffmpegExecutable);
    return task;
  });
  const publicSettings = { ...settings };
  delete publicSettings.sourceRoot;
  delete publicSettings.outputRoot;
  delete publicSettings.ffmpegExecutable;
  return {
    schemaVersion: 1,
    kind: TRANSCODE_MANIFEST_KIND,
    manifestId,
    createdAt,
    creatorVersion: String(options.creatorVersion || "0.5.0"),
    authorization: {
      confirmed: true,
      statement: "用户确认所选文件为商家自有或已获得明确转码授权的原片。"
    },
    processing: {
      mode: "local_ffmpeg_worker",
      remoteUpload: false,
      overwrite: false,
      preserveMetadata: true,
      preserveChapters: true,
      ffmpegExecutable: settings.ffmpegExecutable,
      settings: publicSettings
    },
    tasks,
    notice: "本任务只对自有或已授权原片进行本地格式与编码转换；不会检测、定位、移除、破解或规避任何水印、来源标识或平台风控。"
  };
}

export function validateTranscodeResult(payload, manifest) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("执行结果格式无效");
  if (payload.schemaVersion !== 1 || payload.kind !== TRANSCODE_RESULT_KIND) throw new Error("执行结果版本不受支持");
  if (!manifest?.manifestId || payload.manifestId !== manifest.manifestId) throw new Error("执行结果不属于当前转码任务");
  if (!Array.isArray(payload.tasks)) throw new Error("执行结果缺少任务列表");
  const expected = new Set(manifest.tasks.map((task) => task.id));
  const allowedStatuses = new Set(["completed", "failed", "skipped"]);
  return payload.tasks.map((item) => {
    if (!expected.has(item?.id)) throw new Error("执行结果包含未知任务");
    if (!allowedStatuses.has(item.status)) throw new Error("执行结果包含无效状态");
    return {
      id: item.id,
      status: item.status,
      progress: item.status === "completed" ? 100 : 0,
      exitCode: Number.isInteger(Number(item.exitCode)) ? Number(item.exitCode) : null,
      outputPath: cleanText(item.outputPath || "", "输出路径", { maxLength: 500 }),
      failureReason: cleanText(item.failureReason || "", "失败原因", { maxLength: 1000 })
    };
  });
}

export function transcodeProgress(tasks = []) {
  const counts = { total: tasks.length, pending: 0, completed: 0, failed: 0, skipped: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(counts, task.status)) counts[task.status] += 1;
    else counts.pending += 1;
  }
  const finished = counts.completed + counts.failed + counts.skipped;
  return { ...counts, finished, percent: counts.total ? Math.round((finished / counts.total) * 100) : 0 };
}
