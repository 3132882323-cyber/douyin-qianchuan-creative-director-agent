import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, css, manifestText] = await Promise.all([
  readFile(new URL("../workbench.html", import.meta.url), "utf8"),
  readFile(new URL("../workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../workbench.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);

test("ships a separate V1.0.7 material processing and analysis workbench while keeping the side panel", () => {
  assert.match(html, /素材处理与分析工作台/);
  assert.doesNotMatch(html, /素材分析服务台/u);
  assert.match(html, /V1\.0\.7/);
  assert.match(html, /返回侧边栏工作区/);
  for (const section of ["source", "processing", "transcription", "structure"]) {
    assert.match(html, new RegExp(`id="${section}"`));
  }
});

test("uses the expanded responsive canvas without a page-level 920px floor", () => {
  assert.match(css, /\.sidebar\s*\{[^}]*width:\s*248px/iu);
  assert.match(css, /main\s*\{[^}]*width:\s*min\(1400px,/iu);
  assert.doesNotMatch(css, /min-width:\s*920px/iu);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/iu);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/iu);
  assert.match(css, /\.source-fields\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(css, /\.segment-list\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(css, /overflow-wrap:\s*anywhere/iu);
});

test("connects one primary flow action to real state-aware operations", () => {
  for (const id of ["task-overview-title", "workbench-overview-summary", "workbench-flow-state", "workbench-next-step", "workbench-next-hint", "workbench-progress", "workbench-progress-label", "workbench-progress-bar", "workbench-flow-message", "workbench-flow-error", "overview-source-state", "overview-processing-state", "overview-transcription-state", "overview-structure-state"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.equal((html.match(/id="workbench-next-step"/gu) || []).length, 1);
  assert.equal((html.match(/class="[^"]*\bprimary\b[^"]*"/gu) || []).length, 1);
  assert.match(script, /buildWorkbenchOverview/u);
  assert.match(script, /#workbench-next-step"\)\.addEventListener\("click", async/u);
  assert.match(script, /action\.type === "focus"/u);
  assert.match(script, /action\.type === "open-sidepanel"/u);
  assert.match(script, /control\.click\(\)/u);
  assert.match(script, /scrollIntoView\(/u);
  assert.match(script, /focusTarget\?\.focus\(\)/u);
  assert.match(script, /block: focusTarget \? "center" : "start"/u);
  assert.match(script, /processingPrepared/u);
  assert.match(script, /handoffState/u);
  assert.match(script, /chrome\.storage\?\.onChanged\?\.addListener/u);
  assert.match(script, /ANALYSIS_HANDOFF_INBOX_KEY/u);
  assert.doesNotMatch(script, /preventScroll/u);
});

test("lets users choose video or existing-transcript entry without persisting the choice", () => {
  for (const id of ["workbench-entry-mode", "workbench-entry-video", "workbench-entry-transcript", "workbench-entry-note", "workbench-paste-entry"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="workbench-next-step"[^>]*disabled/u);
  assert.match(html, /id="workbench-flow-state"[^>]*>选择开始方式</u);
  assert.doesNotMatch(html, /id="overview-source"[^>]*aria-current/u);
  assert.match(html, /value="video"/u);
  assert.match(html, /value="transcript"/u);
  assert.match(html, /切换入口不会清空已选视频、任务、转写正文或分析结果/u);
  assert.match(html, /直接粘贴转写/u);
  assert.match(script, /entryMode: ""/u);
  assert.match(script, /function selectEntryMode\(mode\)/u);
  assert.match(script, /input\[name="workbench-entry-mode"\]/u);
  assert.match(script, /moveToFlowTarget\("transcription", "transcript-text"\)/u);
  assert.match(script, /已保留当前/u);
  assert.match(script, /setNodeText\("#workbench-entry-note", model\.entryNotice\)/u);
  assert.doesNotMatch(script, /storage\.(?:local|session)[^\n]*entryMode|entryMode[^\n]*storage\.(?:local|session)/iu);
  assert.match(css, /\.entry-mode\s*\{[^}]*repeat\(2,/iu);
  assert.match(css, /\.entry-mode,\s*\.overview-steps/iu);
});

test("resets only the current page session after an explicit second confirmation", () => {
  for (const id of ["reset-workbench-session", "workbench-reset-note"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="reset-workbench-session"[^>]*class="overview-reset-action"/u);
  assert.match(html, /id="reset-workbench-session"[^>]*aria-describedby="workbench-overview-summary workbench-reset-note"/u);
  assert.match(html, /不删除本地原文件、侧边栏或浏览器本地工作区/u);
  assert.match(css, /\.overview-reset-action\s*\{[^}]*background:\s*transparent/iu);

  const resetStart = script.indexOf("function resetWorkbenchSession()");
  const resetEnd = script.indexOf('$("#reset-workbench-session")', resetStart);
  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  const resetBlock = script.slice(resetStart, resetEnd);
  assert.match(resetBlock, /document\.querySelectorAll\('input\[type="file"\]'\)/u);
  assert.match(resetBlock, /state\.files = \[\]/u);
  assert.match(resetBlock, /state\.processingManifest = null/u);
  assert.match(resetBlock, /state\.transcriptionPlan = null/u);
  assert.match(resetBlock, /#transcript-text"\)\.value = ""/u);
  assert.match(resetBlock, /state\.analysis = null/u);
  assert.match(resetBlock, /state\.handoffState = "idle"/u);
  assert.match(resetBlock, /#processing-queue"\)\.hidden = true/u);
  assert.match(resetBlock, /#processing-queue-status", "浏览器仅生成任务/u);
  assert.match(resetBlock, /#structure-result"\)\.hidden = true/u);
  assert.doesNotMatch(resetBlock, /chrome\.storage|download\(/u);

  const resetHandler = script.slice(resetEnd, script.indexOf("document.querySelectorAll", resetEnd));
  assert.match(resetHandler, /buildWorkbenchResetPrompt\(workbenchResetSnapshot\(\)\)/u);
  assert.match(resetHandler, /if \(!window\.confirm\(resetPlan\.message\)\) return;\s*resetWorkbenchSession\(\)/u);
});

test("keeps section controls available but visually reserves primary emphasis for the flow action", () => {
  for (const id of ["create-material-tasks", "export-material-manifest", "analyze-transcript", "send-analysis-handoff"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="secondary`, "u"));
  }
  assert.match(html, /刷新或关闭页面后不会伪装成可恢复任务/u);
  assert.match(css, /\.flow-state\[data-tone="attention"\]/u);
  assert.match(css, /\.overview-progress/u);
});

test("sends a session handoff with an honest side-panel fallback and keeps JSON backup", () => {
  for (const id of ["send-analysis-handoff", "export-analysis-handoff", "structure-handoff-note"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /不含原始全文、文件名、本机路径或视频信息/u);
  assert.match(script, /function currentAnalysisHandoff\(\)/u);
  assert.match(script, /analysisHandoffForAnalysis\(state\.analysisHandoffCache, state\.analysis\)/u);
  assert.match(script, /enqueueAnalysisHandoff\(chrome\.storage\?\.session, handoff\)/u);
  assert.match(script, /openAnalysisHandoffSidePanel\(chrome\.sidePanel, chrome\.windows\)/u);
  assert.match(script, /当前预览保持不变|已有另一份待确认结果/u);
  assert.match(script, /qianchuan-analysis-handoff\.json/u);
  assert.match(script, /备用 JSON 交接包已导出/u);
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
