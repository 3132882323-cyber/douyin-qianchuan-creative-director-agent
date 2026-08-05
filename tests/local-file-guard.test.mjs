import test from "node:test";
import assert from "node:assert/strict";
import {
  MASTER_MATCH_LIMITS,
  formatLocalBytes,
  isSupportedMatchMedia,
  validateMasterMatchSelection
} from "../src/local-file-guard.js";

const video = (name, size) => ({ name, size, type: "video/mp4" });
const image = (name, size) => ({ name, size, type: "image/png" });

test("validates local master matching with explicit count, file and total limits", () => {
  assert.deepEqual(MASTER_MATCH_LIMITS, {
    maxPlatformFiles: 40,
    maxMasterFiles: 120,
    maxSingleFileBytes: 256 * 1024 ** 2,
    maxTotalBytes: 1024 * 1024 ** 2
  });
  const result = validateMasterMatchSelection([video("平台.mp4", 20)], [image("母版.png", 30)], {
    maxPlatformFiles: 2,
    maxMasterFiles: 2,
    maxSingleFileBytes: 100,
    maxTotalBytes: 100
  });
  assert.equal(result.totalFiles, 2);
  assert.equal(result.totalBytes, 50);
  assert.equal(formatLocalBytes(1024 ** 2), "1.0 MB");
});

test("master matching fails closed for unsupported, empty, invalid or oversized selections", () => {
  const limits = { maxPlatformFiles: 1, maxMasterFiles: 1, maxSingleFileBytes: 100, maxTotalBytes: 150 };
  assert.equal(isSupportedMatchMedia({ name: "source.MOV", type: "" }), true);
  assert.equal(isSupportedMatchMedia({ name: "notes.txt", type: "text/plain" }), false);
  assert.throws(() => validateMasterMatchSelection([], [image("母版.png", 20)], limits), /请选择平台素材/);
  assert.throws(() => validateMasterMatchSelection([video("平台.mp4", 20)], [], limits), /请选择团队母版/);
  assert.throws(() => validateMasterMatchSelection([{ name: "说明.txt", type: "text/plain", size: 10 }], [image("母版.png", 20)], limits), /不是支持的视频或图片格式/);
  assert.throws(() => validateMasterMatchSelection([video("平台.mp4", 0)], [image("母版.png", 20)], limits), /大小无效/);
  assert.throws(() => validateMasterMatchSelection([video("平台.mp4", 101)], [image("母版.png", 20)], limits), /单文件/);
  assert.throws(() => validateMasterMatchSelection([video("平台.mp4", 80)], [image("母版.png", 80)], limits), /总大小/);
  assert.throws(() => validateMasterMatchSelection([video("a.mp4", 10), video("b.mp4", 10)], [image("母版.png", 20)], limits), /最多选择 1/);
});
