import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, css, manifestText] = await Promise.all([
  readFile(new URL("../workbench.html", import.meta.url), "utf8"),
  readFile(new URL("../workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../workbench.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);

test("ships a separate V1.4.0 material processing and analysis workbench while keeping the side panel", () => {
  assert.match(html, /素材处理与分析工作台/);
  assert.doesNotMatch(html, /素材分析服务台/u);
  assert.match(html, /V1\.4\.0/);
  assert.match(html, /返回侧边栏工作区/);
  for (const section of ["source", "processing", "transcription", "structure"]) {
    assert.match(html, new RegExp(`id="${section}"`));
  }
});

test("centralizes advanced local video output settings in the workbench", () => {
  for (const id of [
    "material-output-settings", "material-preset", "material-resolution", "material-frame-rate",
    "material-video-bitrate", "material-audio-bitrate", "material-sample-rate", "material-output-suffix"
  ]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(html, /进阶输出设置/u);
  assert.match(html, /分析音频始终固定为 PCM 16-bit、16 kHz、单声道 WAV/u);
  assert.match(html, /id="material-video-bitrate"[^>]*disabled/u);
  assert.match(script, /function syncMaterialPreset\(/u);
  assert.match(script, /#material-video-bitrate"\)\.disabled = preset !== "custom_bitrate"/u);
  for (const selector of ["material-output-suffix", "material-preset", "material-resolution", "material-frame-rate", "material-video-bitrate", "material-audio-bitrate", "material-sample-rate"]) {
    assert.match(script, new RegExp(`#${selector.replaceAll("-", "-")}`, "u"));
  }
  assert.match(css, /\.material-output-grid\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/iu);
});

test("keeps frequent actions visible and groups secondary exports", () => {
  assert.match(html, /<details class="more-exports"><summary>更多导出<\/summary>/u);
  assert.match(html, /class="more-exports revision-more-exports"/u);
  for (const id of ["export-structure-json", "export-structure-md", "export-revision-json", "export-revision-md"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(css, /\.more-export-actions/u);
});

test("uses the expanded responsive canvas without a page-level 920px floor", () => {
  assert.match(css, /\.sidebar\s*\{[^}]*width:\s*248px/iu);
  assert.match(css, /main\s*\{[^}]*width:\s*min\(1400px,/iu);
  assert.doesNotMatch(css, /min-width:\s*920px/iu);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/iu);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/iu);
  assert.match(css, /@media\s*\(max-width:\s*400px\)/iu);
  assert.match(css, /\.source-fields\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(css, /\.segment-list\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(css, /overflow-wrap:\s*anywhere/iu);
});

test("uses a white paper workspace with one black primary action", () => {
  assert.match(css, /color-scheme:\s*light/u);
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--bg\)/iu);
  assert.match(css, /\.primary\s*\{[^}]*background:\s*#111111[^}]*color:\s*#ffffff/iu);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient/iu);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+1[0-9]px/iu);
});

test("connects one primary flow action to real state-aware operations", () => {
  for (const id of ["task-overview-title", "workbench-overview-summary", "workbench-flow-state", "workbench-next-step", "workbench-next-hint", "workbench-progress", "workbench-progress-label", "workbench-progress-bar", "workbench-delivery-state", "workbench-delivery-label", "workbench-delivery-detail", "workbench-flow-message", "workbench-flow-error", "overview-source-state", "overview-processing-state", "overview-transcription-state", "overview-structure-state"]) {
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
  assert.match(script, /deliveryNode\.dataset\.tone = model\.delivery\.tone/u);
  assert.match(script, /#workbench-delivery-label", model\.delivery\.label/u);
  assert.match(script, /#workbench-delivery-detail", model\.delivery\.detail/u);
  assert.match(script, /transcriptRecoverable/u);
  assert.match(script, /chrome\.storage\?\.onChanged\?\.addListener/u);
  assert.match(script, /ANALYSIS_HANDOFF_INBOX_KEY/u);
  assert.doesNotMatch(script, /preventScroll/u);
  assert.match(css, /\.delivery-state\[data-tone="attention"\]/u);
  assert.match(css, /\.delivery-state\[data-tone="success"\]/u);
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
  assert.ok(html.indexOf('value="transcript"') < html.indexOf('value="video"'));
  assert.match(html, /推荐 · 最快得到可拍结论/u);
  assert.match(html, /进阶 · 需要本机工具/u);
  assert.match(html, /切换入口不会清空已选视频、任务、转写正文或分析结果/u);
  assert.match(html, /直接粘贴转写/u);
  assert.match(script, /entryMode: ""/u);
  assert.match(script, /function selectEntryMode\(mode\)/u);
  assert.match(script, /input\[name="workbench-entry-mode"\]/u);
  assert.match(script, /moveToFlowTarget\("transcription", "transcript-text"\)/u);
  assert.match(script, /已保留当前/u);
  assert.match(script, /setNodeText\("#workbench-entry-note", model\.entryNotice\)/u);
  assert.match(script, /function syncWorkbenchLayout\(model\)/u);
  assert.match(script, /state\.entryMode === "transcript"/u);
  assert.match(script, /document\.getElementById\(id\)\.hidden = transcriptFastPath/u);
  assert.match(script, /#video-source-boundary"\)\.hidden = transcriptFastPath/u);
  assert.doesNotMatch(script, /storage\.(?:local|session)[^\n]*entryMode|entryMode[^\n]*storage\.(?:local|session)/iu);
  assert.match(css, /\.entry-mode\s*\{[^}]*repeat\(2,/iu);
  assert.match(css, /\.entry-mode,\s*\.overview-steps/iu);
  assert.match(css, /\.overview-steps li\.optional/u);
  assert.match(css, /\.panel\[data-flow-status="current"\]/u);
});

test("resets only the current page session after an explicit second confirmation", () => {
  for (const id of ["reset-workbench-session", "workbench-reset-note"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="reset-workbench-session"[^>]*class="overview-reset-action"/u);
  assert.match(html, /id="reset-workbench-session"[^>]*aria-describedby="workbench-overview-summary workbench-reset-note"/u);
  assert.match(html, /不删除本地原文件、侧边栏或浏览器本地工作区/u);
  assert.match(html, /刷新与关闭会触发浏览器提醒/u);
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
  assert.match(resetBlock, /state\.revisionDraft = null/u);
  assert.match(resetBlock, /#confirm-revision-draft"\)\.checked = false/u);
  assert.match(resetBlock, /state\.handoffState = "idle"/u);
  assert.match(resetBlock, /#processing-queue"\)\.hidden = true/u);
  assert.match(resetBlock, /#material-preset"\)\.value = MATERIAL_OUTPUT_DEFAULTS\.preset/u);
  assert.match(resetBlock, /syncMaterialPreset\(\{ invalidate: false \}\)/u);
  assert.match(resetBlock, /#processing-queue-status", "浏览器仅生成任务/u);
  assert.match(resetBlock, /#structure-result"\)\.hidden = true/u);
  assert.doesNotMatch(resetBlock, /chrome\.storage|download\(/u);

  const resetHandler = script.slice(resetEnd, script.indexOf("document.querySelectorAll", resetEnd));
  assert.match(resetHandler, /buildWorkbenchResetPrompt\(workbenchResetSnapshot\(\)\)/u);
  assert.match(resetHandler, /if \(!window\.confirm\(resetPlan\.message\)\) return;\s*resetWorkbenchSession\(\)/u);
  assert.match(script, /window\.addEventListener\("beforeunload", \(event\) => \{[\s\S]*hasWorkbenchUnloadRisk\(workbenchResetSnapshot\(\)\)[\s\S]*event\.preventDefault\(\)[\s\S]*event\.returnValue = ""/u);
  assert.doesNotMatch(script, /beforeunload[\s\S]{0,300}chrome\.storage/iu);
});

test("keeps section controls available but visually reserves primary emphasis for the flow action", () => {
  for (const id of ["create-material-tasks", "export-material-manifest", "analyze-transcript", "send-analysis-handoff"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="secondary`, "u"));
  }
  assert.match(html, /刷新与关闭会触发浏览器提醒，但不会伪装成可恢复任务/u);
  assert.match(css, /\.flow-state\[data-tone="attention"\]/u);
  assert.match(css, /\.overview-progress/u);
  assert.match(html, /id="processing-method"[^>]*class="instructions material-output-settings processing-method"/u);
  assert.doesNotMatch(html.match(/id="processing-method"[^>]*>/u)?.[0] || "", /\bopen\b/u);
  assert.match(html, /本机处理会做什么/u);
  assert.match(css, /\.processing-method\s*\{[^}]*margin-bottom/iu);
});

test("sends a confirmed V2 session handoff with an honest side-panel fallback and keeps JSON backup", () => {
  for (const id of ["send-analysis-handoff", "export-analysis-handoff", "structure-handoff-note"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /不含原始全文、文件名、本机路径或视频信息/u);
  assert.match(script, /function currentAnalysisHandoff\(\)/u);
  assert.match(script, /if \(!state\.revisionConfirmed\) throw new Error/u);
  assert.match(script, /analysisHandoffForAnalysis\(state\.analysisHandoffCache, state\.analysis, \{ revisionDraft \}\)/u);
  assert.match(script, /enqueueAnalysisHandoff\(chrome\.storage\?\.session, handoff\)/u);
  assert.match(script, /openAnalysisHandoffSidePanel\(chrome\.sidePanel, chrome\.windows\)/u);
  assert.match(script, /当前预览保持不变|已有另一份待确认结果/u);
  assert.match(script, /qianchuan-analysis-handoff\.json/u);
  assert.match(script, /备用 V2 JSON 交接包已导出/u);
});

test("connects timed-source analysis to a single-variable editable revision draft", () => {
  for (const id of [
    "revision-recommendations", "revision-parent-version", "generate-revision-draft", "revision-draft",
    "revision-test-id", "revision-source-analysis-id", "revision-primary-variable", "revision-evidence",
    "confirm-revision-draft", "export-revision-json", "export-revision-md"
  ]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.equal((html.match(/data-revision-field="[a-zA-Z]+"/gu) || []).length, 11);
  assert.match(html, /每份草稿只允许一个主要测试变量|所选建议就是本草稿唯一/u);
  assert.match(html, /生成逻辑是本地确定性模板，不预测投放效果/u);
  assert.match(script, /const fileText = await file\.text\(\)/u);
  assert.match(script, /parseTranscriptDocument\(fileText, \{ name: file\.name \}\)/u);
  assert.match(script, /transcriptDocumentMatchesText\(state\.transcriptDocument, event\.target\.value\)/u);
  for (const id of ["transcript-metadata", "transcript-source-type", "transcript-format-segments", "transcript-duration", "transcript-parser-version", "transcript-fingerprint", "transcript-warning-summary"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(script, /renderTranscriptMetadata\(transcriptDocument\)/u);
  assert.match(script, /Transcript v2 \/ parser/u);
  assert.match(css, /\.transcript-metadata/u);
  assert.match(script, /旧时间码或段落映射已失效/u);
  assert.match(script, /revisionRecommendationsForAnalysis\(result\)/u);
  assert.match(script, /createCreativeRevisionDraft\(state\.analysis/u);
  assert.match(script, /testVariables: \[recommendation\.variableId\]/u);
  assert.match(script, /#confirm-revision-draft"\)\.addEventListener\("change"/u);
  assert.match(script, /setRevisionConfirmation\(false\)/u);
  assert.match(script, /creativeRevisionWithEdits/u);
  assert.match(css, /\.revision-fields\s*\{[^}]*grid-template-columns:\s*1fr/iu);
  assert.match(css, /\.revision-fields\s*\{[^}]*max-width:\s*980px/iu);
});

test("drops stale asynchronous imports and handoff completions after newer work or reset", () => {
  assert.match(script, /createLatestOperationGuard/u);
  assert.match(script, /workbenchOperations\.invalidateAll\(\)/u);
  assert.match(script, /workbenchOperations\.cancel\("material-result-import"\)/u);
  assert.match(script, /workbenchOperations\.cancel\("transcript-import"\)/u);
  assert.match(script, /workbenchOperations\.begin\("material-result-import"\)/u);
  assert.match(script, /state\.processingManifest !== manifestAtStart/u);
  assert.match(script, /workbenchOperations\.begin\("transcript-import"\)/u);
  assert.match(script, /workbenchOperations\.begin\("handoff-send"\)/u);
  assert.match(script, /if \(!workbenchOperations\.isCurrent\(operation\)\) return;/u);
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
  assert.match(html, /id="open-source-note"[^>]*class="source-note-action"[^>]*>打开原页</u);
  assert.match(css, /\.source-note-action\s*\{[^}]*background:\s*transparent[^}]*font-size:\s*10px/iu);
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
