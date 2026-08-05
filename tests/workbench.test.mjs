import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, css, manifestText] = await Promise.all([
  readFile(new URL("../workbench.html", import.meta.url), "utf8"),
  readFile(new URL("../workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../workbench.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);

test("ships a separate V1.0.0 material-analysis workbench while keeping the side panel", () => {
  assert.match(html, /素材分析服务台/);
  assert.match(html, /V1\.0\.0/);
  assert.match(html, /返回侧边栏工作区/);
  for (const section of ["source", "processing", "transcription", "structure"]) {
    assert.match(html, new RegExp(`id="${section}"`));
  }
});

test("keeps every static workbench id selector connected", () => {
  const ids = [...script.matchAll(/\$\("#([a-z0-9-]+)"\)/giu)].map((match) => match[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("loads only repository-local code", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/giu)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /type="module"/u);
  assert.match(scripts[0], /src="workbench\.js"/u);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|wasm)/iu);
});

test("treats a Douyin link only as a note or explicit original-page navigation", () => {
  assert.match(html, /可选，仅作来源备注/);
  assert.match(html, /不会发起解析请求，也不会下载链接中的媒体/);
  assert.match(script, /window\.open\(note\.url, "_blank", "noopener,noreferrer"\)/u);
  assert.doesNotMatch(script, /fetch\([^\n]*(?:douyin|source-note|note\.url)|XMLHttpRequest|chrome\.downloads|yt-dlp|douyin.*download/iu);
  const fetchCalls = [...script.matchAll(/\bfetch\(([^,\n]+)/gu)].map((match) => match[1].trim());
  assert.deepEqual(fetchCalls, ["resourceUrl.href"]);
  assert.match(script, /resourceUrl\.protocol !== "chrome-extension:"/u);
});

test("does not request Douyin, page interception or download permissions", () => {
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.permissions.includes("webRequest"), false);
  assert.doesNotMatch(JSON.stringify(manifest), /douyin\.com/iu);
});

test("states authorization, local transcription and rule-analysis limitations", () => {
  assert.match(html, /我确认所选视频为团队自有或已取得明确处理授权/);
  assert.match(html, /不调用云端转写/);
  assert.match(html, /仅允许 <code>whisper-cli\(\.exe\)<\/code>/u);
  assert.match(html, /确定性关键词规则/);
  assert.match(html, /不检测或移除暗水印、隐藏指纹、版权标记或来源标识/);
});

test("shows fail-closed file selection, disabled reasons and honest execution progress", () => {
  for (const id of ["material-selection-list", "clear-material-selection", "material-readiness", "source-message", "source-error", "processing-message", "processing-error", "processing-progress", "processing-queue-status"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /最多 40 个视频、单文件 10 GB、合计 40 GB/u);
  assert.match(html, /id="create-material-tasks"[^>]*aria-describedby="material-readiness"[^>]*disabled/u);
  assert.match(html, /id="processing-progress"[^>]*role="progressbar"[^>]*aria-valuenow="0"/u);
  assert.match(script, /validateLocalVideoBatch\(nextFiles, MATERIAL_VIDEO_BATCH_LIMITS\)/u);
  assert.match(script, /本次没有加入任何文件/u);
  assert.match(script, /浏览器已生成 \$\{progress\.total\} 个待执行任务，但尚未运行 FFmpeg/u);
  assert.match(script, /progressNode\.setAttribute\("aria-valuetext"/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
});

test("keeps normal status separate from true alerts", () => {
  for (const id of ["source-message", "processing-message", "transcription-message", "structure-message"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="status"`, "u"));
  }
  for (const id of ["source-error", "processing-error", "transcription-error", "structure-error"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"`, "u"));
  }
  assert.match(script, /function setFeedback\(/u);
});

test("validates non-media imports and confirms destructive selection clearing", () => {
  assert.match(script, /validateNonMediaImport\(file, "executionResult"\)/u);
  assert.match(script, /validateNonMediaImport\(file, "transcript"\)/u);
  assert.match(script, /parseJsonDocument/u);
  assert.match(script, /window\.confirm\("将清空当前浏览器会话中的视频选择/u);
});
