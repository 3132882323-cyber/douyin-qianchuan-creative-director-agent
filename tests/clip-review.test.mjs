import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptDocument } from "../src/timed-transcript.js";
import {
  CLIP_REVIEW_LIMITS,
  clipBoardLayout,
  clipCaptureDimensions,
  clipReviewCues,
  clipReviewRange,
  clipReviewTimestamp,
  validateClipNote,
  validateClipReviewFile,
  validateClipReviewMetadata
} from "../src/clip-review.js";

const srt = "1\n00:00:01,000 --> 00:00:03,500\n先看完整过程\n\n2\n00:00:04,000 --> 00:00:05,000\n固定机位拍证据";

test("bounds local preview files and decoder metadata before retaining video", () => {
  assert.equal(validateClipReviewFile({ name: "自有原片.mp4", size: 500 }).size, 500);
  for (const file of [{ name: "clip.svg", size: 1 }, { name: "clip.mp4", size: 0 }, { name: "clip.mp4", size: CLIP_REVIEW_LIMITS.maxFileBytes + 1 }]) {
    assert.throws(() => validateClipReviewFile(file));
  }
  assert.deepEqual(validateClipReviewMetadata({ duration: 6, width: 1080, height: 1920 }), { duration: 6, width: 1080, height: 1920 });
  for (const metadata of [{ duration: Infinity, width: 1080, height: 1920 }, { duration: 22000, width: 1080, height: 1920 }, { duration: 6, width: 9000, height: 9000 }]) {
    assert.throws(() => validateClipReviewMetadata(metadata));
  }
});

test("preserves transcript timing and refuses edited or untimed text instead of guessing positions", () => {
  const document = parseTranscriptDocument(srt, { name: "copy.srt" });
  const before = structuredClone(document);
  const cues = clipReviewCues(document, document.text);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[1].text, "固定机位拍证据");
  assert.deepEqual(clipReviewCues(document, "手动改写过的正文"), []);
  const text = parseTranscriptDocument("没有时间码的手动文案", { name: "copy.txt" });
  assert.deepEqual(clipReviewCues(text, text.text), []);
  assert.deepEqual(document, before);
});

test("applies an explicit subtitle offset without clamping a mismatched video or changing the cue", () => {
  const cue = { startMs: 1000, endMs: 3500 };
  assert.deepEqual(clipReviewRange(cue, 6, "0.5"), { start: 1.5, end: 4 });
  assert.throws(() => clipReviewRange(cue, 2), /超出原片范围/u);
  assert.throws(() => clipReviewRange(cue, 6, -2), /超出原片范围/u);
  assert.throws(() => clipReviewRange(cue, 6, "not a number"), /偏移/u);
  assert.throws(() => clipReviewRange(cue, 6, 601), /偏移/u);
  assert.deepEqual(cue, { startMs: 1000, endMs: 3500 });
});

test("keeps portrait and landscape frames proportional and bounds storyboard allocations", () => {
  assert.deepEqual(clipCaptureDimensions(1920, 1080), { width: 960, height: 540 });
  assert.deepEqual(clipCaptureDimensions(1080, 1920), { width: 540, height: 960 });
  assert.deepEqual(clipCaptureDimensions(320, 180), { width: 320, height: 180 });
  const layout = clipBoardLayout(12);
  assert.equal(layout.tiles.length, 12);
  assert.ok(layout.width * layout.height < 4_000_000);
  assert.throws(() => clipBoardLayout(13));
  assert.throws(() => clipBoardLayout(0));
});

test("formats actual media time and validates manual notes", () => {
  assert.equal(clipReviewTimestamp(3661.25), "01:01:01.250");
  assert.equal(clipReviewTimestamp(59.9996), "00:01:00.000");
  assert.equal(validateClipNote("证据镜头\n补一个正面反应"), "证据镜头\n补一个正面反应");
  assert.throws(() => validateClipNote("字".repeat(161)));
  assert.throws(() => validateClipNote("备注\u0000"));
});
