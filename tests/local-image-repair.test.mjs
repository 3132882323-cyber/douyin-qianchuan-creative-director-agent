import test from "node:test";
import assert from "node:assert/strict";
import {
  clearMaskState,
  commitMaskState,
  createMaskHistory,
  currentMaskStrokes,
  redoMaskState,
  repairLocalImage,
  resolveRepairExport,
  undoMaskState,
  validateRepairFile,
  validateStaticWebpBytes
} from "../src/local-image-repair.js";

function sampleImage(width = 5, height = 5) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      rgba[index] = x * 30;
      rgba[index + 1] = y * 35;
      rgba[index + 2] = 80 + x + y;
      rgba[index + 3] = (x + y) % 2 ? 96 : 255;
    }
  }
  return rgba;
}

test("refuses repair without explicit ownership authorization", () => {
  const mask = new Uint8ClampedArray(25);
  mask[12] = 255;
  assert.throws(() => repairLocalImage({
    authorizationConfirmed: false,
    rgba: sampleImage(),
    mask,
    width: 5,
    height: 5
  }), /确认拥有该素材/);
});

test("refuses repair without a user-drawn mask", () => {
  assert.throws(() => repairLocalImage({
    authorizationConfirmed: true,
    rgba: sampleImage(),
    mask: new Uint8ClampedArray(25),
    width: 5,
    height: 5
  }), /手动圈选/);
});

test("refuses a mask above the synchronous processing pixel limit", () => {
  const width = 1000;
  const height = 1000;
  const mask = new Uint8ClampedArray(width * height);
  mask.fill(255, 0, 400_001);
  assert.throws(() => repairLocalImage({
    authorizationConfirmed: true,
    rgba: new Uint8ClampedArray(width * height * 4),
    mask,
    width,
    height
  }), /400,000 像素同步处理上限/);
});

test("keeps every pixel outside the mask unchanged", () => {
  const source = sampleImage();
  const mask = new Uint8ClampedArray(25);
  mask[12] = 255;
  const repaired = repairLocalImage({
    authorizationConfirmed: true,
    rgba: source,
    mask,
    width: 5,
    height: 5,
    featherRadius: 0,
    searchRadius: 8
  });
  for (let pixel = 0; pixel < 25; pixel += 1) {
    if (pixel === 12) continue;
    assert.deepEqual(
      [...repaired.data.slice(pixel * 4, pixel * 4 + 4)],
      [...source.slice(pixel * 4, pixel * 4 + 4)]
    );
  }
});

test("preserves the original alpha channel and defaults PNG export to alpha-safe output", () => {
  const source = sampleImage();
  const mask = new Uint8ClampedArray(25);
  mask[12] = 255;
  const repaired = repairLocalImage({
    authorizationConfirmed: true,
    rgba: source,
    mask,
    width: 5,
    height: 5,
    searchRadius: 8
  });
  for (let pixel = 0; pixel < 25; pixel += 1) {
    assert.equal(repaired.data[pixel * 4 + 3], source[pixel * 4 + 3]);
  }
  assert.deepEqual(resolveRepairExport({ sourceMime: "image/png" }), {
    mime: "image/png",
    extension: ".png",
    quality: undefined,
    preservesAlpha: true
  });
});

test("undo, redo and clear keep vector mask history consistent", () => {
  const firstStroke = { tool: "brush", size: 20, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] };
  let history = createMaskHistory();
  history = commitMaskState(history, [firstStroke]);
  history = clearMaskState(history);
  assert.deepEqual(currentMaskStrokes(history), []);
  history = undoMaskState(history);
  assert.equal(currentMaskStrokes(history).length, 1);
  history = redoMaskState(history);
  assert.deepEqual(currentMaskStrokes(history), []);
});

test("rejects unsupported image formats with a clear error", () => {
  assert.throws(() => validateRepairFile({ name: "source.gif", type: "image/gif", size: 1200 }), /仅支持 PNG、JPEG 或静态 WebP/);
});

test("rejects animated WebP data", () => {
  const bytes = new Uint8Array(22);
  bytes.set([..."RIFF"].map((value) => value.charCodeAt(0)), 0);
  bytes.set([..."WEBP"].map((value) => value.charCodeAt(0)), 8);
  bytes.set([..."VP8X"].map((value) => value.charCodeAt(0)), 12);
  bytes[16] = 1;
  bytes[20] = 0x02;
  assert.throws(() => validateStaticWebpBytes(bytes), /暂不支持动态 WebP/);
});
