import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, css, manifestText, packageText, transcodeScript, repairScript, fileGuardScript, recoveryScript, releaseSafetyScript, serviceWorkerScript] = await Promise.all([
  readFile(new URL("../sidepanel.html", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.js", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.css", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src/transcode.js", import.meta.url), "utf8"),
  readFile(new URL("../src/local-image-repair.js", import.meta.url), "utf8"),
  readFile(new URL("../src/local-file-guard.js", import.meta.url), "utf8"),
  readFile(new URL("../src/workspace-recovery.js", import.meta.url), "utf8"),
  readFile(new URL("../src/release-safety.js", import.meta.url), "utf8"),
  readFile(new URL("../service-worker.js", import.meta.url), "utf8")
]);

test("keeps Manifest V3 versions aligned and permissions minimal", () => {
  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.0.3");
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://api.github.com/*"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self'; object-src 'none';" });
});

test("exposes the four director workspaces", () => {
  for (const view of ["task", "review", "next", "library"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.match(html, /创作任务/);
  assert.match(html, /历史素材复盘/);
  assert.match(html, /下一版任务/);
  assert.match(html, /本地素材与工具/);
});

test("guides the optional-task to review, generate and export flow", () => {
  for (const id of ["workflow-progress", "workflow-progress-bar", "workflow-next-step", "workflow-next-action", "review-empty-state", "review-stale-notice", "plan-empty-state"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /role="tablist"/u);
  assert.match(html, /role="tabpanel"/u);
  assert.match(script, /MEANINGFUL_TASK_FIELDS/u);
  assert.match(script, /const completed = \[reviewed, planned, exported\]/u);
  assert.match(script, /markReviewPending/u);
  assert.match(script, /planExportReceipt/u);
  assert.match(script, /requested\?\.disabled[\s\S]*aria-describedby/u);
});

test("keeps narrow side panels and programmatic focus usable", () => {
  assert.match(css, /min-width:\s*280px/u);
  assert.match(css, /@media \(max-width:\s*400px\)/u);
  assert.match(css, /section\[tabindex="-1"\]:focus-visible/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(script, /prefers-reduced-motion: reduce/u);
  assert.match(script, /function focusAndReveal\(target/u);
  assert.match(script, /target\.focus\(\);[\s\S]*target\.scrollIntoView/u);
  assert.doesNotMatch(script, /preventScroll/u);
  assert.match(css, /\.tag-editor \{ max-height: none;[\s\S]*overflow: visible;/u);
});

test("previews a validated workbench handoff and only fills user-selected empty fields", () => {
  for (const id of ["analysis-handoff-file", "analysis-handoff-preview", "analysis-handoff-summary", "analysis-handoff-suggestions", "apply-analysis-handoff", "clear-analysis-handoff", "analysis-handoff-message", "analysis-handoff-error"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /只会填入选中的空白字段/u);
  assert.match(html, /不是投放效果预测/u);
  assert.match(script, /validateAnalysisHandoffFile\(\{ name: file\.name, size: file\.size, type: file\.type \}\)/u);
  assert.match(script, /validateAnalysisHandoff\(parseJsonDocument/u);
  assert.match(script, /isDuplicateAnalysisHandoff\(handoff, state\.appliedAnalysisHandoffIds\)/u);
  const importHandler = script.slice(script.indexOf('$("#analysis-handoff-file").addEventListener'), script.indexOf('$("#analysis-handoff-suggestions").addEventListener'));
  assert.doesNotMatch(importHandler, /appliedAnalysisHandoffIds\.add/u);
  assert.match(script, /state\.appliedAnalysisHandoffIds\.add\(state\.analysisHandoff\.handoffId\)/u);
  assert.match(script, /clearAnalysisHandoffPreview\(\);[\s\S]*已确认填入的任务内容保持不变/u);
  assert.match(script, /if \(!candidate\?\.canFill \|\| !field \|\| String\(field\.value\)\.trim\(\)\)/u);
  assert.match(script, /#apply-analysis-handoff"\)\.addEventListener\("click"/u);
  assert.match(script, /交接包已在本地校验并生成预览；尚未修改任何创作任务字段/u);
  const storageKeys = script.match(/const STORAGE_KEYS = \[([^\]]+)\]/u)?.[1] || "";
  assert.doesNotMatch(storageKeys, /handoff/iu);
});

test("removes the product workspace and wires an optional creative task", () => {
  for (const name of ["subject", "targetAudience", "creativeGoal", "audienceProblems", "coreClaim", "evidence", "shootingConstraints", "riskNotes", "duration"]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /创作任务是可选上下文/);
  assert.match(script, /chrome\.storage\.local\.set\(\{ creativeTask:/u);
  assert.match(script, /recoverStoredWorkspace/u);
  assert.match(recoveryScript, /migrateLegacyProductBrief/u);
  assert.doesNotMatch(html, /商品 Brief|商品名称|商品类目|价格与促销|到手价|库存|商品页/u);
  assert.doesNotMatch(html, /name="(?:productName|category|promotion)"/u);
  assert.doesNotMatch(script, /chrome\.storage\.local\.set\(\{ productBrief:/u);
  assert.doesNotMatch(html, /商家/u);
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
  for (const id of ["transcode-files", "transcode-authorization", "transcode-selection-list", "clear-transcode-selection", "build-transcode-tasks", "transcode-progress", "transcode-task-list", "export-transcode-manifest", "download-transcode-worker", "import-transcode-result"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /团队母版转码/);
  assert.match(html, /浏览器不会执行转码，只生成受限任务与命令/);
  assert.match(html, /-map_metadata 0/);
  assert.match(html, /不提供裁剪、模糊、清元数据或自定义滤镜/);
  assert.match(script, /createTranscodeManifest/);
  assert.match(transcodeScript, /remoteUpload: false/);
  assert.doesNotMatch(transcodeScript, /removeWatermark|detectWatermark|delogo/);
  assert.match(transcodeScript, /maxFiles:\s*100/u);
  assert.match(transcodeScript, /maxSingleFileBytes:\s*20 \* GIB/u);
  assert.match(script, /validateLocalVideoBatch\(nextFiles, LOCAL_VIDEO_BATCH_LIMITS\)/u);
  assert.match(html, /role="progressbar"[\s\S]*aria-valuenow="0"/u);
});

test("ships a dismissible and reopenable local-first onboarding guide", () => {
  for (const id of ["onboarding-guide", "onboarding-title", "onboarding-start", "dismiss-onboarding", "reopen-onboarding"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /三步完成第一轮素材任务/u);
  assert.match(html, /报表、任务和摘要默认只在当前浏览器处理与保存/u);
  assert.match(script, /onboardingDismissed/u);
  assert.match(script, /showOnboarding\(\{ focus: true, returnFocus: event\.currentTarget \}\)/u);
  assert.match(script, /focusWorkflowTarget\("review", "report-file-trigger"\)/u);
});

test("isolates startup failures and only clears explicitly listed damaged keys", () => {
  for (const id of ["workspace-recovery-notice", "workspace-recovery-message", "retry-workspace-load", "clear-corrupt-storage"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(script, /if \(!initializationPromise\) initializationPromise = initializeWorkspace\(\)/u);
  assert.match(script, /待你确认清理的损坏键/u);
  assert.match(script, /window\.confirm\(`将只清理以下损坏的浏览器本地记录/u);
  assert.match(script, /chrome\.storage\.local\.remove\(keys\)/u);
  assert.match(script, /损坏记录清理失败/u);
  assert.match(recoveryScript, /invalidKeys/u);
});

test("guards local imports, spreadsheet exports and destructive resets", () => {
  assert.match(script, /validateNonMediaImport\(reportFile, "report"\)/u);
  assert.match(script, /validateNonMediaImport\(file, "backup"\)/u);
  assert.match(script, /validateNonMediaImport\(file, "executionResult"\)/u);
  assert.match(script, /parseJsonDocument/u);
  assert.match(releaseSafetyScript, /spreadsheetSafeText/u);
  assert.match(script, /导入失败 · 保留当前数据/u);
  assert.match(script, /window\.confirm\("将清空当前人工选区/u);
  assert.match(script, /window\.confirm\("将重置当前人工选区/u);
  assert.match(script, /window\.confirm\("将清空当前浏览器会话中的转码文件/u);
});

test("fails closed on background and delayed local-storage writes", () => {
  assert.match(serviceWorkerScript, /try \{[\s\S]*setPanelBehavior[\s\S]*catch/u);
  assert.match(script, /function schedulePlanSave\(\)[\s\S]*catch \(error\)/u);
  assert.match(script, /复盘已完成，当前会话可继续使用，但未能保存到浏览器/u);
  assert.match(script, /任务已生成，当前会话可复制或导出，但未能保存到浏览器/u);
});

test("keeps one primary workbench entry above navigation and only a contextual library link", () => {
  const entryIndex = html.indexOf('id="open-analysis-workbench"');
  const headerEndIndex = html.indexOf("</header>");
  const tabsIndex = html.indexOf('class="tabs"');
  const libraryStart = html.indexOf('id="library"');
  const libraryStatusIndex = html.indexOf('class="card library-status"');
  const masterIndex = html.indexOf('class="card master-panel"');
  const repairIndex = html.indexOf('id="image-repair-panel"');
  const transcodeIndex = html.indexOf('id="transcode-panel"');
  const updateIndex = html.indexOf('class="card update-center"');
  assert.ok(entryIndex > headerEndIndex && entryIndex < tabsIndex);
  assert.equal((html.match(/id="open-analysis-workbench"/gu) || []).length, 1);
  assert.equal((html.match(/href="workbench\.html"/gu) || []).length, 2);
  assert.doesNotMatch(html.slice(libraryStart), /id="open-analysis-workbench"|class="workbench-entry"/u);
  assert.match(html.slice(libraryStart), /处理本地素材/u);
  assert.match(html, /编导决策台/u);
  assert.ok(masterIndex > libraryStatusIndex);
  assert.ok(updateIndex > transcodeIndex);
  assert.match(html.slice(masterIndex, html.indexOf(">", masterIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(repairIndex, html.indexOf(">", repairIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(transcodeIndex, html.indexOf(">", transcodeIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(updateIndex, html.indexOf(">", updateIndex) + 1), /\bopen\b/u);
  assert.match(html, /id="library-empty-actions"/u);
  assert.match(html, /先导入历史素材/u);
});

test("wires a reliable recent-task continuation without adding storage keys", () => {
  for (const id of ["recent-task", "recent-task-title", "recent-task-description", "continue-recent-task"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="continue-recent-task"[^>]*aria-describedby="recent-task-description"[^>]*disabled/u);
  assert.match(script, /buildRecentWorkModel/u);
  assert.match(script, /function renderRecentTask\(\)/u);
  assert.match(script, /#continue-recent-task"\)\.addEventListener\("click"/u);
  assert.match(script, /focusWorkflowTarget\(button\.dataset\.targetView, button\.dataset\.focusId\)/u);
  const storageKeys = script.match(/const STORAGE_KEYS = \[([^\]]+)\]/u)?.[1] || "";
  assert.doesNotMatch(storageKeys, /recent|workbench/iu);
  assert.match(css, /@media\s*\(max-width:\s*400px\)[\s\S]*\.top-launcher\s*\{\s*padding:\s*9px/iu);
  assert.match(css, /@media\s*\(max-width:\s*400px\)[\s\S]*\.recent-task \.secondary\s*\{[^}]*max-width:\s*110px/iu);
});

test("ships a keyboard-ready roving tab state before JavaScript initializes", () => {
  assert.match(html, /id="tab-task"[^>]*aria-selected="true"[^>]*tabindex="0"/u);
  for (const id of ["tab-review", "tab-next", "tab-library"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-selected="false"[^>]*tabindex="-1"`, "u"));
  }
  assert.match(html, /id="task"[^>]*role="tabpanel"[^>]*aria-hidden="false"/u);
  for (const id of ["review", "next", "library"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="tabpanel"[^>]*aria-hidden="true"`, "u"));
  }
});

test("wires accessible status, tables, pagination and fail-closed local matching", () => {
  for (const id of ["match-status", "repair-status", "transcode-status"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="status"`, "u"));
  }
  for (const id of ["match-error", "repair-error", "transcode-error"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"`, "u"));
  }
  assert.match(script, /element\("caption", "sr-only"/u);
  assert.match(script, /cell\.scope = "col"/u);
  assert.match(script, /input\.setAttribute\("aria-label", `\$\{name[\s\S]*FIELD_DEFINITIONS\[field\]\.label/u);
  assert.match(html, /id="tag-page"[^>]*role="status"/u);
  assert.match(script, /focusAndReveal\(\$\("#tag-editor input"\)\)/u);
  assert.match(fileGuardScript, /maxPlatformFiles:\s*40/u);
  assert.match(fileGuardScript, /maxMasterFiles:\s*120/u);
  assert.match(fileGuardScript, /maxSingleFileBytes:\s*256 \* MIB/u);
  assert.match(script, /state\.matchData = null;[\s\S]*不会保留可导出的半成品/u);
  assert.match(script, /if \(!plan\?\.items\?\.length \|\| !analysis\?\.summary \|\| !plan\.dependencyFingerprint\) return false/u);
  assert.match(html, /id="review-restore-notice"/u);
});

test("connects the authorized manual image-repair controls and owned-master shortcut", () => {
  for (const id of ["image-repair-panel", "repair-image-file", "repair-authorization", "repair-preview-canvas", "repair-mask-canvas", "repair-brush-tool", "repair-eraser-tool", "repair-undo", "repair-redo", "repair-clear-mask", "repair-feather", "repair-rect-x", "repair-rect-y", "repair-rect-width", "repair-rect-height", "repair-add-rectangle", "run-image-repair", "repair-compare", "reset-image-repair", "export-repaired-image"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function isRepairImageCandidate\(file\)/u);
  assert.match(script, /async function loadRepairImage\(file, \{ fromOwnedCandidate = false \} = \{\}\)/u);
  assert.match(script, /if \(file\) await loadRepairImage\(file\)/u);
  assert.match(script, /await loadRepairImage\(candidateImages\[0\], \{ fromOwnedCandidate: true \}\)/u);
  assert.match(script, /请优先直接使用干净母版或从原始工程重新导出/u);
  assert.match(script, /maxSelectedPixels/u);
  assert.match(script, /shape:\s*"rect"/u);
  assert.match(repairScript, /stroke\?\.shape === "rect"/u);
});

test("keeps a visible entry to the separate local material-analysis workbench", () => {
  assert.match(html, /id="open-analysis-workbench"/u);
  assert.match(html, /href="workbench\.html"/u);
  assert.match(html, /深度处理自有视频 · 本地转写 · 文案结构分析/u);
});

test("exposes an honest user-confirmed update center", () => {
  for (const id of ["check-extension-update", "open-update-page", "auto-update-check", "export-update-backup", "import-update-backup"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /加载已解压的扩展不会静默自更新/);
  assert.match(html, /安装失败与回退方法/);
  assert.match(script, /snapshot\.schemaVersion === 1[\s\S]*migrationNoticePending/u);
  assert.match(html, /id="task-migration-message"/u);
  assert.match(html, /id="dismiss-task-migration"/u);
  assert.match(script, /\$\("#task-migration-message"\)\.textContent/u);
});
