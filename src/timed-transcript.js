export const TIMED_TRANSCRIPT_SCHEMA_VERSION = 2;
export const TIMED_TRANSCRIPT_KIND = "qianchuan-normalized-transcript-v2";
export const LEGACY_TIMED_TRANSCRIPT_KIND = "qianchuan-timed-transcript-v1";
export const TIMED_TRANSCRIPT_PARSER_VERSION = "2.0.0";
export const MAX_TIMED_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_TIMED_TRANSCRIPT_CHARACTERS = 200_000;
export const MAX_TIMED_TRANSCRIPT_CUES = 1200;

const MAX_CUE_CHARACTERS = 4000;
const MAX_TIMELINE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CONTENT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|img)\b|javascript\s*:|\bon[a-z]+\s*=)/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TIMING_PATTERN = /^((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})(?:\s+[^\r\n]{0,300})?$/u;
const SOURCE_TYPES = new Set(["manual", "txt", "md", "srt", "vtt", "whisper_result"]);
const WARNING_CODES = new Set(["timing_overlap", "legacy_schema_upgraded"]);

function serializedBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}包含未知字段：${key}`);
  }
}

function stableFingerprint(value) {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
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

function cleanSourceName(value) {
  const name = String(value || "本地转写文本").trim();
  if (!name || name.length > 260) throw new Error("转写来源名称无效");
  if (CONTROL_PATTERN.test(name) || ACTIVE_CONTENT_PATTERN.test(name)) throw new Error("转写来源名称包含不安全内容");
  return name;
}

function cleanLanguage(value) {
  const language = String(value || "und").trim();
  if (language === "auto") return "und";
  if (!/^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/iu.test(language)) throw new Error("转写语言标签无效");
  return language.toLowerCase();
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
  let previousEnd = -1;
  let overlapCount = 0;
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
    if (previousEnd > startMs) overlapCount += 1;
    previousStart = startMs;
    previousEnd = endMs;
    const content = cleanCueContent(lines.slice(timingIndex + 1));
    cues.push({
      id: `seg-${String(cues.length + 1).padStart(4, "0")}`,
      index: cues.length + 1,
      label,
      startMs,
      endMs,
      start: formatTranscriptTimestamp(startMs),
      end: formatTranscriptTimestamp(endMs),
      text: content
    });
  }
  if (!cues.length) throw new Error("字幕文件中没有可分析的 cue");
  return { segments: cues, overlapCount };
}

function textParagraphs(source) {
  const text = source.trim();
  const parts = text.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
  if (parts.length > MAX_TIMED_TRANSCRIPT_CUES) throw new Error(`文本段落超过 ${MAX_TIMED_TRANSCRIPT_CUES} 项上限`);
  return parts.map((content, index) => ({
    id: `seg-${String(index + 1).padStart(4, "0")}`,
    index: index + 1,
    label: "",
    startMs: null,
    endMs: null,
    start: "",
    end: "",
    text: content
  }));
}

function sourceTypeFor(extension, explicitType) {
  const type = String(explicitType || extension || "manual").toLowerCase();
  if (!SOURCE_TYPES.has(type)) throw new Error("转写来源类型不受支持");
  return type;
}

function durationFor(segments) {
  const timed = segments.filter((segment) => Number.isInteger(segment.endMs));
  return timed.length ? Math.max(...timed.map((segment) => segment.endMs)) : null;
}

function fingerprintFor(text, segments) {
  return stableFingerprint({
    text,
    segments: segments.map(({ label, startMs, endMs, text: segmentText }) => ({ label, startMs, endMs, text: segmentText }))
  });
}

function normalizeWarning(value) {
  if (!isRecord(value)) throw new Error("转写警告格式无效");
  exactKeys(value, ["code", "message"], "转写警告");
  const code = String(value.code || "");
  const message = String(value.message || "").trim();
  if (!WARNING_CODES.has(code) || !message || message.length > 240 || CONTROL_PATTERN.test(message)) throw new Error("转写警告内容无效");
  return { code, message };
}

function normalizeSegment(value, index) {
  if (!isRecord(value)) throw new Error("转写分段格式无效");
  exactKeys(value, ["id", "index", "label", "startMs", "endMs", "start", "end", "text"], "转写分段");
  const segmentIndex = Number(value.index);
  if (segmentIndex !== index + 1) throw new Error("转写分段编号必须连续");
  const id = String(value.id || "");
  if (id !== `seg-${String(segmentIndex).padStart(4, "0")}`) throw new Error("转写分段标识无效");
  const label = cleanLabel(value.label);
  const text = cleanCueContent(String(value.text ?? "").split("\n"));
  const hasTiming = value.startMs !== null || value.endMs !== null;
  if (hasTiming && (!Number.isInteger(value.startMs) || !Number.isInteger(value.endMs) || value.endMs <= value.startMs)) throw new Error("转写分段时间范围无效");
  if (!hasTiming && (value.startMs !== null || value.endMs !== null)) throw new Error("转写分段时间范围不完整");
  const start = hasTiming ? formatTranscriptTimestamp(value.startMs) : "";
  const end = hasTiming ? formatTranscriptTimestamp(value.endMs) : "";
  if (String(value.start || "") !== start || String(value.end || "") !== end) throw new Error("转写分段格式化时间不一致");
  return { id, index: segmentIndex, label, startMs: hasTiming ? value.startMs : null, endMs: hasTiming ? value.endMs : null, start, end, text };
}

function normalizedDocument({ sourceType, sourceName, format, language, text, segments, warnings = [] }) {
  const safeSegments = segments.map(normalizeSegment);
  if (!safeSegments.length || safeSegments.length > MAX_TIMED_TRANSCRIPT_CUES) throw new Error("转写分段数量无效");
  const normalizedText = safeSegments.map((segment) => segment.text).join("\n").trim();
  if (normalizedText !== text) throw new Error("转写正文与分段内容不一致");
  const hasTiming = safeSegments.some((segment) => segment.startMs !== null);
  if (hasTiming && safeSegments.some((segment) => segment.startMs === null)) throw new Error("带时间转写不能混用无时间分段");
  const fingerprint = fingerprintFor(normalizedText, safeSegments);
  return {
    schemaVersion: TIMED_TRANSCRIPT_SCHEMA_VERSION,
    kind: TIMED_TRANSCRIPT_KIND,
    parserVersion: TIMED_TRANSCRIPT_PARSER_VERSION,
    source: {
      type: sourceTypeFor(format, sourceType),
      name: cleanSourceName(sourceName),
      format,
      fingerprint
    },
    language: cleanLanguage(language),
    durationMs: durationFor(safeSegments),
    hasTiming,
    text: normalizedText,
    segments: safeSegments,
    warnings: warnings.map(normalizeWarning)
  };
}

export function parseTranscriptDocument(rawText, options = {}) {
  const source = normalizeSource(rawText);
  const name = String(options.name || "本地转写文本").trim();
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] || "txt";
  if (!["txt", "md", "srt", "vtt"].includes(extension)) throw new Error("转写文件只支持 TXT、MD、SRT 或 VTT");
  const format = extension === "srt" || extension === "vtt" ? extension : "text";
  const parsed = format === "text" ? { segments: textParagraphs(source), overlapCount: 0 } : parseCaptionBlocks(source, format);
  const text = parsed.segments.map((segment) => segment.text).join("\n").trim();
  if (!text || text.length > MAX_TIMED_TRANSCRIPT_CHARACTERS || serializedBytes(text) > MAX_TIMED_TRANSCRIPT_BYTES) {
    throw new Error("转写正文为空或超过本地保护上限");
  }
  const warnings = parsed.overlapCount ? [{
    code: "timing_overlap",
    message: `检测到 ${parsed.overlapCount} 处字幕时间重叠；已保留原时间，分析前请人工核对。`
  }] : [];
  return normalizedDocument({
    sourceType: options.sourceType || (format === "text" ? extension : format),
    sourceName: name,
    format,
    language: options.language,
    text,
    segments: parsed.segments,
    warnings
  });
}

function upgradeLegacyDocument(document, options = {}) {
  exactKeys(document, ["schemaVersion", "kind", "format", "hasTiming", "text", "cues"], "旧版转写对象");
  if (document.schemaVersion !== 1 || document.kind !== LEGACY_TIMED_TRANSCRIPT_KIND || !Array.isArray(document.cues)) throw new Error("旧版转写对象格式无效");
  const format = ["text", "srt", "vtt"].includes(document.format) ? document.format : "text";
  const segments = document.cues.map((cue, index) => ({
    id: `seg-${String(index + 1).padStart(4, "0")}`,
    index: index + 1,
    label: cue?.label || "",
    startMs: cue?.startMs ?? null,
    endMs: cue?.endMs ?? null,
    start: cue?.start || "",
    end: cue?.end || "",
    text: cue?.content || ""
  }));
  return normalizedDocument({
    sourceType: options.sourceType || (format === "text" ? "txt" : format),
    sourceName: options.name || "旧版本地转写",
    format,
    language: options.language,
    text: String(document.text || "").trim(),
    segments,
    warnings: [{ code: "legacy_schema_upgraded", message: "旧版转写对象已在内存中升级为统一 Transcript v2；原对象未被覆盖。" }]
  });
}

export function normalizeTranscriptDocument(document, options = {}) {
  if (!isRecord(document)) throw new Error("转写对象格式无效");
  if (document.schemaVersion === 1 || document.kind === LEGACY_TIMED_TRANSCRIPT_KIND) return upgradeLegacyDocument(document, options);
  exactKeys(document, ["schemaVersion", "kind", "parserVersion", "source", "language", "durationMs", "hasTiming", "text", "segments", "warnings"], "转写对象");
  if (document.schemaVersion !== TIMED_TRANSCRIPT_SCHEMA_VERSION || document.kind !== TIMED_TRANSCRIPT_KIND) throw new Error("转写对象版本不受支持");
  if (document.parserVersion !== TIMED_TRANSCRIPT_PARSER_VERSION) throw new Error("转写解析器版本不受支持");
  if (!isRecord(document.source)) throw new Error("转写来源格式无效");
  exactKeys(document.source, ["type", "name", "format", "fingerprint"], "转写来源");
  if (!["text", "srt", "vtt"].includes(document.source.format) || !Array.isArray(document.segments) || !Array.isArray(document.warnings)) throw new Error("转写对象结构无效");
  const normalized = normalizedDocument({
    sourceType: document.source.type,
    sourceName: document.source.name,
    format: document.source.format,
    language: document.language,
    text: String(document.text || "").trim(),
    segments: document.segments,
    warnings: document.warnings
  });
  if (document.source.fingerprint !== normalized.source.fingerprint || document.durationMs !== normalized.durationMs || document.hasTiming !== normalized.hasTiming) {
    throw new Error("转写对象来源指纹或派生字段不一致");
  }
  return normalized;
}

export function transcriptDocumentMatchesText(document, rawText) {
  try {
    const normalized = normalizeTranscriptDocument(document);
    return String(rawText ?? "").replace(/\r\n?/gu, "\n").trim() === normalized.text;
  } catch {
    return false;
  }
}

export function assertTranscriptDocumentMatchesText(document, rawText) {
  const normalized = normalizeTranscriptDocument(document);
  if (String(rawText ?? "").replace(/\r\n?/gu, "\n").trim() !== normalized.text) {
    throw new Error("转写正文已被编辑，旧时间码或段落映射已失效；请重新导入字幕或按当前正文重新分析");
  }
  return normalized;
}
