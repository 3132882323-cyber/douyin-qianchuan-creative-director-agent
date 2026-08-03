import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, manifestText, packageText, transcodeScript] = await Promise.all([
  readFile(new URL("../sidepanel.html", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src/transcode.js", import.meta.url), "utf8")
]);

test("keeps Manifest V3 versions aligned and permissions minimal", () => {
  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.5.0");
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://api.github.com/*"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.update_url, undefined);
});

test("exposes the four director workspaces", () => {
  for (const view of ["brief", "review", "next", "library"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.match(html, /商品 Brief/);
  assert.match(html, /素材复盘/);
  assert.match(html, /下一批拍什么/);
  assert.match(html, /素材库/);
});

test("keeps every static id selector wired to the side panel", () => {
  const ids = [...script.matchAll(/\$\("#([a-z0-9-]+)"\)/gi)].map((match) => match[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("loads only the local module entry point", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="sidepanel\.js"/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.js/);
});

test("states the self-owned-master safety boundary", () => {
  assert.match(html, /不检测或移除平台水印/);
  assert.match(script, /不检测、移除、破解或规避平台水印/);
});

test("exposes an authorized local-only transcode queue", () => {
  for (const id of ["transcode-files", "transcode-authorization", "build-transcode-tasks", "transcode-task-list", "export-transcode-manifest", "download-transcode-worker", "import-transcode-result"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /自有母版转码/);
  assert.match(html, /浏览器不能直接启动本机程序/);
  assert.match(html, /-map_metadata 0/);
  assert.match(html, /不提供裁剪、模糊、清元数据或自定义滤镜/);
  assert.match(script, /createTranscodeManifest/);
  assert.match(transcodeScript, /remoteUpload: false/);
  assert.doesNotMatch(transcodeScript, /removeWatermark|detectWatermark|delogo/);
});

test("connects the authorized manual image-repair controls and owned-master shortcut", () => {
  for (const id of ["image-repair-panel", "repair-image-file", "repair-authorization", "repair-preview-canvas", "repair-mask-canvas", "repair-brush-tool", "repair-eraser-tool", "repair-undo", "repair-redo", "repair-clear-mask", "repair-feather", "run-image-repair", "repair-compare", "reset-image-repair", "export-repaired-image"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function isRepairImageCandidate\(file\)/u);
  assert.match(script, /async function loadRepairImage\(file, \{ fromOwnedCandidate = false \} = \{\}\)/u);
  assert.match(script, /if \(file\) await loadRepairImage\(file\)/u);
  assert.match(script, /await loadRepairImage\(candidateImages\[0\], \{ fromOwnedCandidate: true \}\)/u);
  assert.match(script, /请优先直接使用干净母版或从原始工程重新导出/u);
  assert.match(script, /maxSelectedPixels/u);
});

test("keeps a visible entry to the separate local material-analysis workbench", () => {
  assert.match(html, /id="open-analysis-workbench"/u);
  assert.match(html, /href="workbench\.html"/u);
  assert.match(html, /本地视频标准化 · 音频提取 · 本地转写 · 文案结构/u);
});

test("exposes an honest user-confirmed update center", () => {
  for (const id of ["check-extension-update", "open-update-page", "auto-update-check", "export-update-backup", "import-update-backup"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /加载已解压的扩展不会静默自更新/);
  assert.match(html, /安装失败与回退方法/);
});
