import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, manifestText] = await Promise.all([
  readFile(new URL("../workbench.html", import.meta.url), "utf8"),
  readFile(new URL("../workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);

test("ships a separate V0.5.0 material-analysis workbench while keeping the side panel", () => {
  assert.match(html, /素材分析服务台/);
  assert.match(html, /V0\.5\.0/);
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
  assert.match(html, /我确认所选视频为商家自有或已取得明确处理授权/);
  assert.match(html, /不调用云端转写/);
  assert.match(html, /仅允许 <code>whisper-cli\(\.exe\)<\/code>/u);
  assert.match(html, /确定性关键词规则/);
  assert.match(html, /不检测或移除暗水印、隐藏指纹、版权标记或来源标识/);
});
