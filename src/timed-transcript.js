export const TIMED_TRANSCRIPT_KIND = "qianchuan-timed-transcript-v1";
export const MAX_TIMED_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_TIMED_TRANSCRIPT_CHARACTERS = 200_000;
export const MAX_TIMED_TRANSCRIPT_CUES = 1200;

const MAX_CUE_CHARACTERS = 4000;
const MAX_TIMELINE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CONTENT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|img)\b|javascript\s*:|\bon[a-z]+\s*=)/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TIMING_PATTERN = /^((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})(?:\s+[^\r\n]{0,300})?$/u;

function serializedBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeSource(rawText) {
  const source = String(rawText ?? "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!source.trim()) throw new Error("转写文本为空");
  if (source.length > MAX_TIMED_TRANSCRIPT_CHARACTERS || serializedBytes(source) > MAX_TIMED_TRANSCRIPT_BYTES) {
    throw new Error("转写文本超过 4 MB 或 20 万字符保护上限");
  }
  if (CONTROL_PATTERN.test(source)) throw new Error("转写文本包含不允许的控制字符");
  if (ACTIVE_CONTENT_PATTERN.test(source)) throw new Error("转写文本包含不安全的活动内容");
  return source;
}

function cleanLabel(value) {
  const label = String(value ?? "").trim();
  if (label.length > 120) throw new Error("字幕 cue 标签超过 120 字符上限");
  if (CONTROL_PATTERN.test(label) || ACTIVE_CONTENT_PATTERN.test(label)) throw new Error("字幕 cue 标签包含不安全内容");
  return label;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function cleanCueContent(lines) {
  const source = lines.join("\n").trim();
  if (!source) throw new Error("字幕 cue 缺少正文");
  if (source.length > MAX_CUE_CHARACTERS) throw new Error(`单个字幕 cue 超过 ${MAX_CUE_CHARACTERS} 字符上限`);
  if (ACTIVE_CONTENT_PATTERN.test(source) || CONTROL_PATTERN.test(source)) throw new Error("字幕 cue 包含不安全内容");
  const text = decodeEntities(source.replace(/<[^>]{1,200}>/gu, ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("字幕 cue 中没有可分析的正文");
  return text;
}

function timestampMs(value) {
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":");
  const secondsPart = parts.pop();
  const minutesPart = parts.pop();
  const hoursPart = parts.pop() || "0";
  const [secondsText, millisecondsText] = secondsPart.split(".");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);
  if (![hours, minutes, seconds, milliseconds].every(Number.isInteger) || minutes > 59 || seconds > 59 || milliseconds > 999) {
    throw new Error(`字幕时间码无效：${value}`);
  }
  const result = ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  if (result < 0 || result > MAX_TIMELINE_MS) throw new Error("字幕时间码超过 24 小时保护上限");
  return result;
}

export function formatTranscriptTimestamp(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMELINE_MS) return "";
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function captionBody(source, format) {
  if (format !== "vtt") return source.trim();
  const lines = source.split("\n");
  if (!/^WEBVTT(?:\s|$)/iu.test(lines[0].trim())) throw new Error("VTT 文件缺少 WEBVTT 文件头");
  let index = 1;
  while (index < lines.length && lines[index].trim()) index += 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  return lines.slice(index).join("\n").trim();
}

function parseCaptionBlocks(source, format) {
  const body = captionBody(source, format);
  if (!body) throw new Error("字幕文件中没有 cue");
  const blocks = body.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
  if (blocks.length > MAX_TIMED_TRANSCRIPT_CUES) throw new Error(`字幕 cue 超过 ${MAX_TIMED_TRANSCRIPT_CUES} 项上限`);
  const cues = [];
  let previousStart = -1;
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    if (format === "vtt" && /^(?:NOTE|STYLE|REGION)(?:\s|$)/iu.test(lines[0].trim())) {
      if (/^(?:STYLE|REGION)(?:\s|$)/iu.test(lines[0].trim())) throw new Error("VTT STYLE/REGION 块不受支持");
      continue;
    }
    const timingIndex = lines.findIndex((line, index) => index <= 1 && TIMING_PATTERN.test(line.trim()));
    if (timingIndex < 0) throw new Error(`字幕 cue 缺少有效时间行：${lines[0].slice(0, 80)}`);
    const label = cleanLabel(timingIndex === 1 ? lines[0] : "");
    const timing = lines[timingIndex].trim().match(TIMING_PATTERN);
    const startMs = timestampMs(timing[1]);
    const endMs = timestampMs(timing[2]);
    if (endMs <= startMs) throw new Error("字幕 cue 结束时间必须晚于开始时间");
    if (startMs < previousStart) throw new Error("字幕 cue 必须按开始时间排序");
    previousStart = startMs;
    const content = cleanCueContent(lines.slice(timingIndex + 1));
    cues.push({
      index: cues.length + 1,
      label,
      startMs,
      endMs,
      start: formatTranscriptTimestamp(startMs),
      end: formatTranscriptTimestamp(endMs),
      content
    });
  }
  if (!cues.length) throw new Error("字幕文件中没有可分析的 cue");
  return cues;
}

function textParagraphs(source) {
  const text = source.trim();
  const parts = text.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
  if (parts.length > MAX_TIMED_TRANSCRIPT_CUES) throw new Error(`文本段落超过 ${MAX_TIMED_TRANSCRIPT_CUES} 项上限`);
  return parts.map((content, index) => ({
    index: index + 1,
    label: "",
    startMs: null,
    endMs: null,
    start: "",
    end: "",
    content
  }));
}

export function parseTranscriptDocument(rawText, options = {}) {
  const source = normalizeSource(rawText);
  const name = String(options.name || "本地转写文本").trim();
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] || "txt";
  if (!["txt", "md", "srt", "vtt"].includes(extension)) throw new Error("转写文件只支持 TXT、MD、SRT 或 VTT");
  const format = extension === "srt" || extension === "vtt" ? extension : "text";
  const cues = format === "text" ? textParagraphs(source) : parseCaptionBlocks(source, format);
  const text = cues.map((cue) => cue.content).join("\n").trim();
  if (!text || text.length > MAX_TIMED_TRANSCRIPT_CHARACTERS || serializedBytes(text) > MAX_TIMED_TRANSCRIPT_BYTES) {
    throw new Error("转写正文为空或超过本地保护上限");
  }
  return {
    schemaVersion: 1,
    kind: TIMED_TRANSCRIPT_KIND,
    format,
    hasTiming: format !== "text",
    text,
    cues
  };
}

export function transcriptDocumentMatchesText(document, rawText) {
  if (!document || document.kind !== TIMED_TRANSCRIPT_KIND) return false;
  return String(rawText ?? "").replace(/\r\n?/gu, "\n").trim() === document.text;
}

export function assertTranscriptDocumentMatchesText(document, rawText) {
  if (!transcriptDocumentMatchesText(document, rawText)) {
    throw new Error("转写正文已被编辑，旧时间码或段落映射已失效；请重新导入字幕或按当前正文重新分析");
  }
  return document;
}
