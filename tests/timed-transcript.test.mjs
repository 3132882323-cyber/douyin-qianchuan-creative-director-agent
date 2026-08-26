import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TIMED_TRANSCRIPT_CHARACTERS,
  MAX_TIMED_TRANSCRIPT_CUES,
  TIMED_TRANSCRIPT_KIND,
  assertTranscriptDocumentMatchesText,
  normalizeTranscriptDocument,
  parseTranscriptDocument,
  transcriptDocumentMatchesText
} from "../src/timed-transcript.js";

test("parses SRT cues while retaining labels, time ranges and text", () => {
  const document = parseTranscriptDocument([
    "1",
    "00:00:00,250 --> 00:00:02,000",
    "先别划走，通勤是不是总担心闷？",
    "",
    "scene-a",
    "00:00:02,000 --> 00:00:05,500",
    "实拍轻薄透气。"
  ].join("\n"), { name: "本地字幕.srt" });

  assert.equal(document.schemaVersion, 2);
  assert.equal(document.kind, TIMED_TRANSCRIPT_KIND);
  assert.equal(document.source.format, "srt");
  assert.equal(document.source.type, "srt");
  assert.match(document.source.fingerprint, /^fnv1a32:[0-9a-f]{8}$/u);
  assert.equal(document.hasTiming, true);
  assert.equal(document.durationMs, 5500);
  assert.equal(document.text, "先别划走，通勤是不是总担心闷？\n实拍轻薄透气。");
  assert.deepEqual(document.segments[0], {
    id: "seg-0001",
    index: 1,
    label: "1",
    startMs: 250,
    endMs: 2000,
    start: "00:00:00.250",
    end: "00:00:02.000",
    text: "先别划走，通勤是不是总担心闷？"
  });
  assert.equal(document.segments[1].label, "scene-a");
});

test("parses VTT header descriptions, NOTE blocks, settings and cue markup", () => {
  const document = parseTranscriptDocument([
    "WEBVTT - locally exported captions",
    "",
    "NOTE 仅供本地编导核对",
    "不会进入正文",
    "",
    "hook",
    "00:00.000 --> 00:02.000 align:start position:10%",
    "<v 编导><b>三秒钩子</b> &amp; 事实核对",
    "",
    "hook",
    "00:02.000 --> 00:05.000",
    "重复标签也应保留"
  ].join("\n"), { name: "captions.vtt" });

  assert.equal(document.segments.length, 2);
  assert.equal(document.segments[0].text, "三秒钩子 & 事实核对");
  assert.equal(document.segments[1].label, "hook");
});

test("keeps TXT and Markdown paragraphs compatible with explicitly empty timing", () => {
  for (const name of ["brief.txt", "brief.md"]) {
    const document = parseTranscriptDocument("第一段\n\n第二段", { name });
    assert.equal(document.source.format, "text");
    assert.equal(document.source.type, name.endsWith(".md") ? "md" : "txt");
    assert.equal(document.hasTiming, false);
    assert.equal(document.durationMs, null);
    assert.deepEqual(document.segments.map(({ startMs, endMs }) => [startMs, endMs]), [[null, null], [null, null]]);
  }
});

test("reports overlapping caption timing without silently changing it", () => {
  const document = parseTranscriptDocument([
    "1", "00:00:00,000 --> 00:00:03,000", "第一段", "",
    "2", "00:00:02,000 --> 00:00:04,000", "第二段"
  ].join("\n"), { name: "overlap.srt" });
  assert.deepEqual(document.warnings.map((item) => item.code), ["timing_overlap"]);
  assert.equal(document.segments[1].startMs, 2000);
});

test("fails closed for invalid timelines, active content and input limits", () => {
  assert.throws(() => parseTranscriptDocument("1\n00:00:02,000 --> 00:00:01,000\n倒序", { name: "bad.srt" }), /晚于开始时间/u);
  assert.throws(() => parseTranscriptDocument([
    "1", "00:00:02,000 --> 00:00:03,000", "第二段", "",
    "2", "00:00:01,000 --> 00:00:02,000", "第一段"
  ].join("\n"), { name: "bad.srt" }), /开始时间排序/u);
  assert.throws(() => parseTranscriptDocument('<img src=x onerror="alert(1)">', { name: "bad.txt" }), /活动内容/u);
  assert.throws(() => parseTranscriptDocument("字".repeat(MAX_TIMED_TRANSCRIPT_CHARACTERS + 1), { name: "large.txt" }), /保护上限/u);
  assert.throws(() => parseTranscriptDocument(Array.from({ length: MAX_TIMED_TRANSCRIPT_CUES + 1 }, (_, index) => `段落${index}`).join("\n"), { name: "many.txt" }), /段落超过/u);
  assert.throws(() => parseTranscriptDocument("正文", { name: "captions.exe" }), /只支持/u);
});

test("manual text edits invalidate the old timing map honestly", () => {
  const document = parseTranscriptDocument("1\n00:00:00,000 --> 00:00:01,000\n原始正文", { name: "captions.srt" });
  assert.equal(transcriptDocumentMatchesText(document, document.text), true);
  assert.equal(transcriptDocumentMatchesText(document, "编辑后的正文"), false);
  assert.throws(() => assertTranscriptDocumentMatchesText(document, "编辑后的正文"), /旧时间码.*已失效/u);
});

test("upgrades a legacy timed transcript in memory and fails closed on tampering", () => {
  const legacy = {
    schemaVersion: 1,
    kind: "qianchuan-timed-transcript-v1",
    format: "srt",
    hasTiming: true,
    text: "旧字幕",
    cues: [{ index: 1, label: "1", startMs: 0, endMs: 1000, start: "00:00:00.000", end: "00:00:01.000", content: "旧字幕" }]
  };
  const upgraded = normalizeTranscriptDocument(legacy, { name: "legacy.srt" });
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.source.name, "legacy.srt");
  assert.equal(upgraded.segments[0].text, "旧字幕");
  assert.deepEqual(upgraded.warnings.map((item) => item.code), ["legacy_schema_upgraded"]);

  const tampered = structuredClone(upgraded);
  tampered.source.fingerprint = "fnv1a32:00000000";
  assert.throws(() => normalizeTranscriptDocument(tampered), /指纹/u);
  assert.equal(transcriptDocumentMatchesText(tampered, tampered.text), false);
});
