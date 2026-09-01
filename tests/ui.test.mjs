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
  assert.equal(manifest.version, "1.4.0");
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
  for (const id of ["workflow-progress", "workflow-progress-bar", "workflow-next-step", "workflow-next-action", "review-empty-state", "review-stale-notice", "plan-empty-state", "plan-production-readiness"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /role="tablist"/u);
  assert.match(html, /role="tabpanel"/u);
  assert.match(script, /MEANINGFUL_TASK_FIELDS/u);
  assert.match(script, /const completed = \[reviewed, planned, exported\]/u);
  assert.match(script, /markReviewPending/u);
  assert.match(script, /planExportReceipt/u);
  assert.match(script, /requested\?\.disabled[\s\S]*aria-describedby/u);
  assert.match(html, /class="actions plan-export-actions"/u);
  assert.match(html, /<details class="more-exports">\s*<summary>更多导出<\/summary>/u);
  for (const id of ["copy-run-sheet", "copy-plan", "export-plan-md", "export-plan-csv", "export-plan-json"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="copy-run-sheet"[^>]*class="primary"[^>]*>复制开拍清单</u);
  assert.match(html, /id="copy-plan"[^>]*class="secondary"[^>]*>复制完整方案</u);
  assert.match(html, /id="plan-shoot-order"/u);
  assert.match(script, /planToRunSheet\(state\.plan\)/u);
  assert.match(script, /assessPlanShootReadiness\(state\.plan\)/u);
  assert.match(script, /function renderPlanShootReadiness\(\)/u);
  assert.match(script, /buildDirectorMonitorCard\(state\.plan, \{ itemIndex: index \}\)/u);
  assert.match(script, /directorMonitorCardToText\(monitor\)/u);
  assert.match(script, /function renderDirectorMonitorReadiness\(\)/u);
  assert.match(script, /复制前三秒监看卡/u);
  assert.match(script, /首帧、口播、字幕与证据字段已齐/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorMonitorCardToText\(monitor\)\)/u);
  for (const id of ["director-blind-review", "director-blind-review-state", "director-blind-review-summary", "copy-director-blind-review", "copy-director-blind-review-key", "copy-director-blind-review-decision", "director-blind-review-feedback"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /前三秒拍前盲审/u);
  assert.match(html, /隐藏测试编号、基线身份、来源素材和历史指标/u);
  assert.match(script, /function renderDirectorBlindReview\(\)/u);
  assert.match(script, /buildDirectorBlindReview\(state\.plan\)/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorBlindReviewPackToText\(review\)\)/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorBlindReviewKeyToText\(review\)\)/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorBlindReviewDecisionSheetToText\(review\)\)/u);
  assert.match(script, /请先收齐并锁定反馈，再揭示导演映射/u);
  assert.match(script, /请先填回收事实，再在保留、单变量重写和淘汰中三选一/u);
  for (const id of ["director-batch-board", "director-batch-board-state", "director-batch-board-summary", "copy-director-batch-board", "copy-director-edit-assembly", "director-batch-board-feedback"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /批次共用镜头板/u);
  assert.match(html, /先拍并锁定 B00 全流程母版/u);
  assert.match(script, /function renderDirectorBatchBoard\(\)/u);
  assert.match(script, /buildDirectorBatchBoard\(state\.plan\)/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorBatchBoardToText\(board\)\)/u);
  assert.match(script, /navigator\.clipboard\.writeText\(directorBatchEditAssemblyToText\(board\)\)/u);
  assert.match(script, /renderDirectorBlindReview\(\);\s*renderDirectorBatchBoard\(\);/u);
  assert.match(script, /请先锁定 B00，再按场记编号拍/u);
  assert.match(script, /请先锁定 B00 时间轴，再逐个替换/u);
  assert.match(script, /当前开拍清单仍有 \$\{readiness\.missingCount\} 项待补/u);
  assert.match(script, /if \(!window\.confirm\([\s\S]*是否仍要复制给现场/u);
  assert.match(script, /先拍 \$\{firstItem\.id\} 基线，再按编号拍变体/u);
  assert.match(script, /for \(const id of \["copy-run-sheet", "copy-plan", "export-plan-md"/u);
  assert.match(script, /action\.dataset\.focusId = "copy-run-sheet"/u);
  assert.match(css, /\.plan-export-actions \.more-exports\s*\{[^}]*grid-column:\s*1 \/ -1/iu);
  assert.match(css, /\.plan-card-readiness\[data-ready="true"\]/u);
  assert.match(css, /\.director-monitor-tools\s*\{[^}]*grid-template-columns/iu);
  assert.match(css, /\.director-monitor-state\[data-ready="true"\]/u);
  assert.match(css, /\.director-blind-review-actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/iu);
  assert.match(css, /\.director-blind-review-summary/u);
  assert.match(css, /\.director-blind-review-decision\s*\{[^}]*grid-column:\s*1 \/ -1/iu);
  assert.match(css, /\.director-batch-board\s*\{[^}]*border:\s*1px solid/iu);
  assert.match(css, /\.director-batch-board-actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/iu);
  assert.match(css, /\.director-batch-board-action\s*\{[^}]*min-height:\s*34px/iu);
  assert.match(css, /\.more-export-actions/u);
});

test("keeps narrow side panels and programmatic focus usable", () => {
  assert.match(css, /body\s*\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/iu);
  assert.match(css, /@media \(max-width:\s*400px\)/u);
  assert.match(css, /section\[tabindex="-1"\]:focus-visible/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(script, /prefers-reduced-motion: reduce/u);
  assert.match(script, /function focusAndReveal\(target/u);
  assert.match(script, /target\.focus\(\);[\s\S]*target\.scrollIntoView/u);
  assert.doesNotMatch(script, /preventScroll/u);
  assert.match(css, /\.tag-editor \{ max-height: none;[\s\S]*overflow: visible;/u);
});

test("wires multi-project switching, version lineage and explicit result backfill", () => {
  for (const id of ["project-hub", "project-select", "new-project", "rename-project", "parent-version", "parent-version-recommendation", "parent-version-recommendation-title", "use-recommended-parent", "experiment-loop", "version-filter", "version-batch-filter", "version-search", "version-view-summary", "version-pagination", "version-page-prev", "version-page-state", "version-page-next", "experiment-summary", "experiment-next-action", "run-experiment-next-action", "version-timeline", "manual-result-entry", "manual-result-form", "manual-result-test-id", "manual-result-spend", "manual-result-roi", "preview-manual-result", "export-experiment-csv", "export-experiment-json", "experiment-result-file", "experiment-result-preview", "confirm-result-import", "cancel-result-import"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(script, /openProjectDatabase/u);
  assert.match(script, /requestSwitch\(targetId\)/u);
  assert.match(script, /parseExperimentResults/u);
  assert.match(script, /parseManualExperimentResult/u);
  assert.match(script, /buildExperimentNextAction/u);
  assert.match(script, /buildExperimentVersionActions/u);
  assert.match(script, /recommendExperimentParent/u);
  assert.match(script, /selectParentVersion/u);
  assert.match(script, /openManualResultForVersion/u);
  assert.match(script, /buildExperimentLedgerSnapshot/u);
  assert.match(script, /experimentLedgerToCsv/u);
  assert.match(script, /buildExperimentView/u);
  assert.match(script, /buildExperimentParentComparison/u);
  assert.match(script, /buildCreativeVersionDiff/u);
  assert.match(script, /experimentBatchOptions/u);
  assert.match(script, /state\.experimentViewPage/u);
  assert.match(script, /resetExperimentBrowse\(next\.filter\)/u);
  assert.doesNotMatch(script, /filteredTimeline\.slice\(0, 100\)/u);
  assert.match(script, /createExperimentDecision/u);
  assert.match(script, /setVersionDecision/u);
  assert.match(script, /后续证据变化时会自动提示重新确认/u);
  assert.match(script, /指标口径提醒/u);
  assert.match(script, /未匹配行不会写入/u);
  assert.match(html, /已有结果会先载入/u);
  assert.match(html, /不把单变量与结果差异自动认定为因果/u);
  assert.match(html, /只按测试编号关联/u);
  assert.match(html, /value="decision_stale"/u);
  assert.match(html, /旧决策会自动标记为“需重新确认”/u);
  assert.match(html, /只参考你已确认且证据仍有效的人工结论/u);
  assert.match(css, /\.version-decision/u);
  assert.match(css, /\.decision-form/u);
  assert.match(css, /\.experiment-next-action/u);
  assert.match(css, /\.manual-result-form/u);
  assert.match(css, /\.parent-version-recommendation/u);
  assert.match(css, /\.decision-parent-action/u);
  assert.match(css, /\.experiment-browse/u);
  assert.match(css, /\.experiment-pagination/u);
  assert.match(css, /\.version-quick-actions/u);
  assert.match(css, /\.version-comparison/u);
  assert.match(css, /\.comparison-metrics/u);
  assert.match(css, /\.version-content-diff/u);
  assert.match(css, /\.content-diff-values/u);
  assert.match(script, /预览并再次确认前不会写入/u);
});

test("uses a readable black-and-white paper layout without changing workspace ids", () => {
  assert.match(css, /color-scheme:\s*light/u);
  assert.match(css, /--bg:\s*#ffffff/u);
  assert.match(css, /\.primary\s*\{[^}]*background:\s*#111111[^}]*color:\s*#ffffff/iu);
  assert.match(css, /\.form-grid\s*\{[^}]*grid-template-columns:\s*1fr/iu);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient/iu);
  assert.doesNotMatch(css, /font-size:\s*[789]px/iu);
  assert.match(html, /id="tab-task"[^>]*><span>01<\/span>任务<\/button>/u);
  assert.match(html, /id="tab-library"[^>]*><span>04<\/span>素材<\/button>/u);
});

test("receives session handoffs without replacing a preview and only fills selected empty fields", () => {
  for (const id of ["analysis-handoff-inbox", "show-analysis-handoff-inbox", "discard-analysis-handoff-inbox", "analysis-handoff-file", "analysis-handoff-preview", "analysis-handoff-summary", "analysis-handoff-suggestions", "analysis-handoff-revision", "analysis-handoff-revision-id", "analysis-handoff-revision-parent", "analysis-handoff-revision-source", "analysis-handoff-revision-evidence", "analysis-handoff-revision-fields", "apply-analysis-handoff", "clear-analysis-handoff", "analysis-handoff-message", "analysis-handoff-error"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /只会填入选中的空白字段/u);
  assert.match(html, /不是投放效果预测/u);
  assert.match(script, /validateAnalysisHandoffFile\(\{ name: file\.name, size: file\.size, type: file\.type \}\)/u);
  assert.match(script, /validateAnalysisHandoff\(parseJsonDocument/u);
  assert.match(script, /isDuplicateAnalysisHandoff\(handoff, state\.appliedAnalysisHandoffIds\)/u);
  const importHandler = script.slice(script.indexOf('$("#analysis-handoff-file").addEventListener'), script.indexOf('$("#analysis-handoff-suggestions").addEventListener'));
  assert.doesNotMatch(importHandler, /appliedAnalysisHandoffIds\.add/u);
  assert.match(script, /state\.appliedAnalysisHandoffIds\.add\(applied\.handoffId\)/u);
  assert.match(script, /ANALYSIS_HANDOFF_INBOX_KEY/u);
  assert.match(script, /chrome\.storage\?\.onChanged\?\.addListener/u);
  assert.match(script, /await loadSessionAnalysisHandoff\(\)/u);
  assert.match(script, /previewDecision === "pending"[\s\S]*当前预览未被覆盖/u);
  assert.match(script, /removeSessionAnalysisHandoff\(applied\.handoffId\)/u);
  assert.match(script, /#clear-analysis-handoff"\)\.addEventListener\("click", async[\s\S]*removeSessionAnalysisHandoff\(handoff\.handoffId\)/u);
  assert.match(script, /\["invalid", "expired"\][\s\S]*storage\.remove\(ANALYSIS_HANDOFF_INBOX_KEY\)/u);
  assert.match(script, /会话交接预览及收件箱记录已清除/u);
  assert.match(script, /if \(!candidate\?\.canFill \|\| !field \|\| String\(field\.value\)\.trim\(\)\)/u);
  assert.match(script, /#apply-analysis-handoff"\)\.addEventListener\("click"/u);
  assert.match(script, /交接包已在本地校验并生成预览；尚未修改任何创作任务字段/u);
  assert.match(script, /function renderAnalysisHandoffRevision\(revisionDraft\)/u);
  assert.match(script, /for \(const field of CREATIVE_REVISION_EDITABLE_FIELDS\)/u);
  assert.match(script, /此处仅预览，不会写入或覆盖创作方案/u);
  const handoffPreviewBlock = script.slice(script.indexOf("function renderAnalysisHandoffRevision"), script.indexOf("function sessionStorageArea"));
  assert.doesNotMatch(handoffPreviewBlock, /state\.plan\s*=|creativePlan|chrome\.storage\.local\.set/u);
  assert.match(html, /V2 可拍草稿仅供只读预览，不会写入创作方案/u);
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

test("keeps one local video-processing implementation and routes side-panel candidates to it", () => {
  assert.match(html, /id="video-processing-entry"/u);
  assert.match(html, /视频处理已移入独立工作台/u);
  assert.match(html, /40 个文件 \/ 单文件 10 GB \/ 合计 40 GB/u);
  assert.match(html, /浏览器出于隐私保护不会把当前目录选择自动传到新标签页/u);
  for (const id of ["transcode-files", "transcode-authorization", "build-transcode-tasks", "transcode-task-list"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.doesNotMatch(script, /createTranscodeManifest|transcodeFiles|transcodeManifest/u);
  assert.match(script, /在独立工作台处理候选视频/u);
  assert.match(script, /window\.open\(chrome\.runtime\.getURL\("workbench\.html"\)/u);
  assert.match(transcodeScript, /remoteUpload: false/);
  assert.doesNotMatch(transcodeScript, /removeWatermark|detectWatermark|delogo/);
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
  assert.match(script, /parseJsonDocument/u);
  assert.match(releaseSafetyScript, /spreadsheetSafeText/u);
  assert.match(script, /导入失败 · 保留当前数据/u);
  assert.match(script, /window\.confirm\("将清空当前人工选区/u);
  assert.match(script, /window\.confirm\("将重置当前人工选区/u);
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
  const videoProcessingIndex = html.indexOf('id="video-processing-entry"');
  const maintenanceIndex = html.indexOf('id="maintenance-center"');
  const updateIndex = html.indexOf('class="maintenance-section update-center"');
  assert.ok(entryIndex > headerEndIndex && entryIndex < tabsIndex);
  assert.equal((html.match(/id="open-analysis-workbench"/gu) || []).length, 1);
  assert.equal((html.match(/href="workbench\.html"/gu) || []).length, 2);
  assert.doesNotMatch(html.slice(libraryStart), /id="open-analysis-workbench"|class="workbench-entry"/u);
  assert.match(html.slice(libraryStart), /视频处理已移入独立工作台/u);
  assert.match(html, /编导决策台/u);
  assert.ok(masterIndex > libraryStatusIndex);
  assert.ok(videoProcessingIndex > repairIndex);
  assert.ok(maintenanceIndex > videoProcessingIndex);
  assert.ok(updateIndex > maintenanceIndex);
  assert.match(html.slice(masterIndex, html.indexOf(">", masterIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(repairIndex, html.indexOf(">", repairIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(maintenanceIndex, html.indexOf(">", maintenanceIndex) + 1), /\bopen\b/u);
  assert.doesNotMatch(html.slice(updateIndex, html.indexOf(">", updateIndex) + 1), /\bopen\b/u);
  assert.match(html, /id="library-empty-actions"/u);
  assert.match(html, /先导入历史素材/u);
});

test("wires a prioritized director desk without adding storage keys or automatic actions", () => {
  for (const id of ["recent-task", "recent-task-title", "recent-task-description", "continue-recent-task", "director-desk-list", "director-desk-summary"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /id="continue-recent-task"[^>]*aria-describedby="recent-task-description"[^>]*disabled/u);
  assert.match(script, /buildRecentWorkModel/u);
  assert.match(script, /buildDirectorDesk/u);
  assert.match(script, /function renderRecentTask\(\)/u);
  assert.match(script, /#continue-recent-task"\)\.addEventListener\("click"/u);
  assert.match(script, /function runDirectorDeskAction\(item\)/u);
  assert.match(script, /runDirectorDeskAction\(item\)/u);
  assert.match(script, /openContentDiff: true/u);
  assert.match(css, /\.director-desk-list/u);
  assert.match(css, /\.director-desk-item/u);
  const storageKeys = script.match(/const STORAGE_KEYS = \[([^\]]+)\]/u)?.[1] || "";
  assert.doesNotMatch(storageKeys, /recent|workbench|director|desk/iu);
  assert.match(css, /@media\s*\(max-width:\s*400px\)[\s\S]*\.top-launcher\s*\{\s*padding:\s*9px/iu);
  assert.match(css, /@media\s*\(max-width:\s*400px\)[\s\S]*\.recent-task \.secondary\s*\{[^}]*max-width:\s*110px/iu);
});

test("keeps production progress explicit, local and director-controlled", () => {
  assert.match(html, /id="production-stage-counts"/u);
  for (const id of ["operator-batch-handoff", "operator-batch-title", "operator-batch-summary", "copy-operator-batch", "operator-batch-versions", "operator-batch-feedback"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  for (const value of ["production_untracked", "production_planned", "production_shooting", "production_editing", "production_ready", "production_launched", "production_paused"]) {
    assert.match(html, new RegExp(`value="${value}"`, "u"));
  }
  assert.match(html, /只认编导手动标记/u);
  assert.match(html, /系统不会根据方案生成、导出或结果文件推断/u);
  assert.match(script, /createProductionStatus/u);
  assert.match(script, /summarizeProductionTimeline/u);
  assert.match(script, /setVersionProductionStatus/u);
  assert.match(script, /focusProduction: true/u);
  assert.match(script, /制作状态：\$\{productionStageLabel/u);
  assert.match(script, /experimentCardActiveLayer/u);
  assert.match(script, /assessOperatorHandoffReadiness/u);
  assert.match(script, /buildOperatorSingleVariableDiff/u);
  assert.match(script, /experimentVersionToOperatorCard/u);
  assert.match(script, /buildLatestOperatorBatchHandoff/u);
  assert.match(script, /latestOperatorBatchToText/u);
  assert.match(script, /function renderOperatorHandoff\(entry, timeline\)/u);
  assert.match(script, /function renderOperatorBatchHandoff\(timeline\)/u);
  assert.match(script, /renderOperatorBatchHandoff\(timeline\)/u);
  assert.match(script, /title: "制作与投放交接"/u);
  assert.match(script, /children: \[renderProductionStatusControl\(entry\), renderOperatorHandoff\(entry, timeline\)\]/u);
  assert.match(script, /当前投放交接仍有 \$\{readiness\.missing\.length\} 项待处理/u);
  assert.match(script, /navigator\.clipboard\.writeText\(experimentVersionToOperatorCard/u);
  assert.match(script, /未创建计划、设置预算、改变制作状态或执行平台操作/u);
  assert.match(script, /function renderExperimentCardLayer/u);
  assert.match(script, /function activateExperimentCardLayer/u);
  assert.match(script, /className: "version-production-layer"[\s\S]*open: activeLayer === "production"/u);
  assert.match(script, /className: "version-result-layer"[\s\S]*open: activeLayer === "result"/u);
  assert.match(script, /renderExperimentDecisionEditor\(entry, \{ open: activeLayer === "decision" \}\)/u);
  assert.match(script, /activateExperimentCardLayer\(card, resultLayer\)[\s\S]*contentDiff\.open = true/u);
  assert.match(css, /\.production-overview/u);
  assert.match(css, /\.version-layer\s*\{[^}]*border:[^}]*background:\s*#ffffff/iu);
  assert.match(css, /\.version-layer-body\s*\{[^}]*display:\s*grid/iu);
  assert.match(css, /\.version-production/u);
  assert.match(css, /\.production-stage-select/u);
  assert.match(css, /\.operator-handoff\s*\{[^}]*grid-template-columns/iu);
  assert.match(css, /\.operator-handoff\[data-ready="true"\]/u);
  assert.match(css, /\.operator-batch-handoff\s*\{[^}]*display:\s*grid/iu);
  assert.match(css, /\.operator-batch-handoff\[data-ready="true"\]/u);
  const productionControl = script.slice(script.indexOf("function renderProductionStatusControl"), script.indexOf("function renderProductionOverview"));
  assert.match(productionControl, /select\.addEventListener\("change", async/u);
  assert.doesNotMatch(productionControl, /importResults|generateCreativePlan|chrome\.storage|createProductionStatus\([^)]*readiness/u);
  const operatorControl = script.slice(script.indexOf("function renderOperatorHandoff"), script.indexOf("function renderProductionOverview"));
  assert.match(operatorControl, /window\.confirm/u);
  assert.doesNotMatch(operatorControl, /setVersionProductionStatus|setVersionDecision|importResults|generateCreativePlan|chrome\.storage/u);
  const batchRender = script.slice(script.indexOf("function renderOperatorBatchHandoff"), script.indexOf("function currentExperimentTimeline"));
  assert.match(batchRender, /batch\.entries/u);
  assert.match(batchRender, /batch\.code === "too_large"/u);
  assert.doesNotMatch(batchRender, /setVersionProductionStatus|setVersionDecision|importResults|generateCreativePlan|chrome\.storage/u);
  const batchAction = script.slice(script.indexOf('$("#copy-operator-batch").addEventListener'), script.indexOf("function renderResultImportPreview"));
  assert.match(batchAction, /window\.confirm/u);
  assert.match(batchAction, /navigator\.clipboard\.writeText\(latestOperatorBatchToText/u);
  assert.match(batchAction, /只写入剪贴板，未创建计划、设置预算、改变状态或执行平台操作/u);
  assert.doesNotMatch(batchAction, /setVersionProductionStatus|setVersionDecision|importResults|generateCreativePlan|chrome\.storage/u);
});

test("creates a privacy-safe inspiration relay without exporting source material", () => {
  for (const id of ["inspiration-relay", "inspiration-relay-state", "inspiration-relay-summary", "inspiration-relay-cards", "copy-inspiration-relay", "inspiration-relay-feedback"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /脱敏分享 · 不复制素材/u);
  assert.match(html, /不包含项目名、测试编号、素材名、指标数值、完整脚本或具体品牌主张/u);
  assert.match(script, /buildInspirationRelay/u);
  assert.match(script, /inspirationCardToChallenge/u);
  assert.match(script, /inspirationRelayToText/u);
  assert.match(script, /function renderInspirationRelay\(timeline\)/u);
  assert.match(script, /renderInspirationRelay\(timeline\)/u);
  assert.match(css, /\.inspiration-relay\s*\{[^}]*border:[^}]*background:\s*#ffffff/iu);
  assert.match(css, /\.inspiration-relay-cards\s*\{[^}]*grid-template-columns/iu);
  const render = script.slice(script.indexOf("function renderInspirationRelay"), script.indexOf("function currentExperimentTimeline"));
  assert.match(render, /card\.mechanismLabel/u);
  assert.match(render, /card\.question/u);
  assert.match(render, /复制共创挑战/u);
  assert.match(render, /navigator\.clipboard\.writeText\(inspirationCardToChallenge\(card\)\)/u);
  assert.match(render, /完成三路原创发散后再进入方案评审/u);
  assert.doesNotMatch(render, /baselineCreative|planItem|metrics|spokenScript|state\.currentProject|chrome\.storage/u);
  const action = script.slice(script.indexOf('$("#copy-inspiration-relay").addEventListener'), script.indexOf("function renderResultImportPreview"));
  assert.match(action, /navigator\.clipboard\.writeText\(inspirationRelayToText/u);
  assert.match(action, /不含项目、版本、素材、指标数值或完整脚本/u);
  assert.doesNotMatch(action, /state\.currentProject|setVersionProductionStatus|setVersionDecision|importResults|generateCreativePlan|chrome\.storage/u);
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
  for (const id of ["match-status", "repair-status"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="status"`, "u"));
  }
  for (const id of ["match-error", "repair-error"]) {
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
  assert.match(script, /const rollbackPortfolio = await state\.projectRepository\.exportPortfolio\(\)/u);
  assert.match(script, /导入未完成，已恢复原项目集合和当前工作区/u);
  assert.match(html, /id="maintenance-center"[^>]*class="card maintenance-center"/u);
  assert.match(html, /<summary><span>维护与隐私<\/span><small>更新 · 备份 · 边界说明<\/small><\/summary>/u);
  const maintenanceBlock = html.slice(html.indexOf('id="maintenance-center"'), html.indexOf("</section>", html.indexOf('id="maintenance-center"')));
  for (const text of ["版本与更新", "导出工作区备份", "导入工作区备份", "隐私与产品边界"]) assert.match(maintenanceBlock, new RegExp(text, "u"));
  assert.match(css, /\.maintenance-center\s*\{[^}]*border-style:\s*dashed/iu);
  assert.match(css, /\.maintenance-stack\s*\{[^}]*display:\s*grid/iu);
});
