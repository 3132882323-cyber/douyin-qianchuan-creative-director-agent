import { normalizeTranscriptDocument, transcriptDocumentMatchesText } from "./timed-transcript.js";

export const CLIP_REVIEW_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 ** 3,
  maxDurationSeconds: 6 * 60 * 60,
  maxVideoPixels: 34_000_000,
  maxCaptureEdge: 960,
  maxCaptures: 12,
  maxCaptureBytes: 2 * 1024 ** 2,
  maxNoteLength: 160,
  pageSize: 20
});

export function validateClipReviewFile(file) {
  if (!file || typeof file.name !== "string" || !/\.(mp4|m4v|mov|webm)$/iu.test(file.name)) {
    throw new Error("看片只支持 MP4、M4V、MOV 或 WebM；其他格式请先在本机转成 MP4。");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > CLIP_REVIEW_LIMITS.maxFileBytes) {
    throw new Error("请使用非空且不超过 2 GB 的本地视频。");
  }
  return file;
}

export function validateClipReviewMetadata({ duration, width, height }) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > CLIP_REVIEW_LIMITS.maxDurationSeconds) {
    throw new Error("无法读取有效视频时长，或时长超过 6 小时；请换用本机标准化后的 MP4。");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > CLIP_REVIEW_LIMITS.maxVideoPixels) {
    throw new Error("视频画面尺寸无法读取或过大；请先在本机缩小到 1080p 再看片。");
  }
  return { duration, width, height };
}

export function clipReviewCues(document, text) {
  if (!document || !transcriptDocumentMatchesText(document, text)) return [];
  const safe = normalizeTranscriptDocument(document);
  if (!safe.hasTiming) return [];
  return safe.segments.map(({ id, index, startMs, endMs, text: caption }) => ({ id, index, startMs, endMs, text: caption }));
}

export function clipReviewRange(cue, duration, offsetSeconds = 0) {
  if (!cue || !Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs) {
    throw new Error("这一段没有有效时间码；请重新导入 SRT / VTT。");
  }
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset) || Math.abs(offset) > 600) throw new Error("字幕时间偏移必须在 -600 到 600 秒之间。");
  const start = cue.startMs / 1000 + offset;
  const end = cue.endMs / 1000 + offset;
  if (!Number.isFinite(duration) || duration <= 0 || start < 0 || end > duration + 0.001) {
    throw new Error("这一段时间码超出原片范围；请核对视频与字幕，或调整时间偏移。");
  }
  return { start, end: Math.min(end, duration) };
}

export function clipReviewTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("画面时间码无效。");
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}.${pad(milliseconds % 1000, 3)}`;
}

export function clipCaptureDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > CLIP_REVIEW_LIMITS.maxVideoPixels) {
    throw new Error("没有可截图的有效视频画面。");
  }
  const scale = Math.min(1, CLIP_REVIEW_LIMITS.maxCaptureEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function validateClipNote(value) {
  const note = String(value ?? "");
  if (note.length > CLIP_REVIEW_LIMITS.maxNoteLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)) {
    throw new Error("分镜备注最多 160 字，不能包含控制字符。");
  }
  return note;
}

export function clipBoardLayout(count) {
  if (!Number.isInteger(count) || count < 1 || count > CLIP_REVIEW_LIMITS.maxCaptures) throw new Error("分镜图需要 1–12 张人工截图。");
  const columns = Math.min(count, 3);
  const gap = 20;
  const tileWidth = 440;
  const tileHeight = 550;
  const header = 90;
  return {
    width: gap + columns * (tileWidth + gap),
    height: header + Math.ceil(count / columns) * (tileHeight + gap),
    tiles: Array.from({ length: count }, (_, index) => ({
      x: gap + index % columns * (tileWidth + gap),
      y: header + Math.floor(index / columns) * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight
    }))
  };
}
