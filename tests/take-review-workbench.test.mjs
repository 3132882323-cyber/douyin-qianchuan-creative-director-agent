import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, script, sidepanelHtml, sidepanelScript, manifest] = await Promise.all([
  readFile(new URL("../take-review-workbench.html", import.meta.url), "utf8"),
  readFile(new URL("../take-review-workbench.css", import.meta.url), "utf8"),
  readFile(new URL("../take-review-workbench.js", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.html", import.meta.url), "utf8"),
  readFile(new URL("../sidepanel.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8").then(JSON.parse)
]);

function eventHandlerSource(id) {
  const marker = `$("#${id}").addEventListener`;
  const start = script.indexOf(marker);
  assert.notEqual(start, -1, `${id} handler should exist`);
  const tail = script.slice(start + marker.length);
  const next = tail.search(/\n\$\("#[^"]+"\)\.addEventListener/u);
  return script.slice(start, next < 0 ? script.length : start + marker.length + next);
}

test("ships an explicit sidepanel summary and opens an extension-owned full-page workbench", () => {
  for (const id of [
    "take-review-workbench-entry",
    "take-review-workbench-title",
    "take-review-workbench-state",
    "take-review-workbench-summary",
    "take-review-reviewed-count",
    "take-review-primary-count",
    "take-review-issue-count",
    "open-take-review-workbench",
    "take-review-workbench-feedback"
  ]) assert.match(sidepanelHtml, new RegExp(`id="${id}"`, "u"));
  assert.match(sidepanelHtml, /新标签页打开 · 记录仅保存在当前浏览器 · 不读取视频/u);
  assert.match(sidepanelScript, /summarizeTakeReviewBatch/u);
  assert.match(sidepanelScript, /deriveTakeReviewFollowUps/u);
  assert.match(sidepanelScript, /button\.dataset\.testId = firstFollowUp\?\.testId/u);
  assert.match(sidepanelScript, /#take-review-issue-count", model\.followUps\.length/u);
  assert.match(sidepanelScript, /openTakeReviewWorkbench\(event\.currentTarget\.dataset\.testId \|\| ""\)/u);
  assert.match(sidepanelScript, /persistCurrentProject\(\{ syncPlan: true/u);
  assert.match(sidepanelScript, /chrome\.runtime\.getURL\("take-review-workbench\.html"\)/u);
  assert.match(sidepanelScript, /opened\.opener = null/u);
  assert.match(sidepanelScript, /window\.addEventListener\("focus"[\s\S]*refreshTakeReviewWorkbenchEntry/u);
});

test("wires the complete manual take workflow without an automatic verdict", () => {
  for (const id of [
    "batch-status", "metric-versions", "metric-reviewed", "metric-primary", "metric-issues", "metric-stale",
    "follow-up-panel", "follow-up-title", "follow-up-count", "follow-up-summary", "follow-up-list",
    "jump-next-follow-up", "copy-follow-up-sheet",
    "version-list", "take-review-form", "material-code", "take-number", "check-list", "review-outcome",
    "handoff-role", "issue-timecode", "next-correction", "owner-role", "save-take-review", "save-and-next-take-review", "reset-take-review",
    "current-review-list", "stale-review-list", "copy-take-handoff", "export-take-reviews", "clear-take-reviews",
    "take-history-archive", "history-capacity", "history-group-count", "history-archive-summary", "history-capacity-warning", "history-batch-list"
  ]) assert.match(html, new RegExp(`id="${id}"`, "u"));
  assert.match(html, /请选择，不自动判断/u);
  assert.match(html, /系统不会根据勾选自动下结论/u);
  assert.match(html, /只有五项均通过且人工选择“保留”时可指定/u);
  assert.match(script, /TAKE_REVIEW_CHECKS\.forEach/u);
  assert.match(script, /input\.type = "radio"/u);
  assert.match(script, /\[\["pass", "通过"\], \["issue", "有问题"\]\]/u);
  assert.match(script, /saveTakeReview\(state\.project\.id, context\.version\.testId, draft/u);
  assert.match(script, /replaceHandoffRole/u);
  assert.match(script, /expectedRoleConflict: conflict \? \{ id: conflict\.id, revision: conflict\.revision \} : null/u);
  assert.match(script, /deleteTakeReview/u);
  assert.match(script, /deleteTakeReview[\s\S]*expectedPlanFingerprint: takeReviewPlanFingerprint\(state\.plan\)/u);
  assert.match(script, /deleteTakeReview[\s\S]*expectedContentSnapshot: takeReviewRecordSnapshot\(record\)/u);
  assert.match(script, /clearTakeReviewBatch[\s\S]*expectedRecords: expectedRecordSet\(batchRecords\)/u);
  assert.match(script, /takeReviewBatchHandoffToText/u);
  assert.match(script, /takeReviewFollowUpsToText/u);
  assert.match(script, /deriveTakeReviewFollowUps/u);
  assert.match(script, /仍为“\$\{currentFollowUp\.statusLabel\}”；已留在本版本/u);
  assert.match(script, /const shouldAdvance = event\.submitter\?\.id === "save-and-next-take-review"/u);
  assert.doesNotMatch(script, /advanceAfterSave|requestSubmit\(\)/u);
  assert.match(html, /id="save-and-next-take-review" type="submit"/u);
});

test("preserves unsaved input and exposes stale source records as read-only", () => {
  assert.match(script, /window\.addEventListener\("beforeunload"/u);
  assert.match(script, /if \(state\.dirty && !window\.confirm/u);
  assert.match(script, /assessment\.current \? current : stale/u);
  assert.match(script, /reviewCard\(entry, \{ stale: true \}\)/u);
  assert.match(script, /if \(stale\)[\s\S]*return card/u);
  assert.match(script, /未保存 · 可重试/u);
  assert.match(script, /当前输入仍保留/u);
  assert.match(script, /expectedPlanFingerprint: takeReviewPlanFingerprint\(state\.plan\)/u);
  assert.match(script, /expectedRevision: draft\.expectedRevision/u);
  assert.match(script, /state\.dirty \|\| state\.saving \|\| state\.outputBusy \|\| state\.refreshRequired/u);
  assert.match(script, /记录已经保存，但列表未能刷新/u);
  assert.match(script, /state\.mutationRevision \+= 1/u);
  assert.match(script, /\.inert = state\.saving \|\| state\.outputBusy/u);
});

test("revalidates one consistent local snapshot before save, export and handoff", () => {
  const followUpHandler = eventHandlerSource("copy-follow-up-sheet");
  const handoffHandler = eventHandlerSource("copy-take-handoff");
  const exportHandler = eventHandlerSource("export-take-reviews");
  assert.match(script, /getTakeReviewSnapshot/u);
  assert.match(script, /takeReviewPlanMatchesWorkspace\(plan, project\.workspace\)/u);
  assert.match(script, /takeReviewVersionMatchesPlan\(matches\[0\], plan\)/u);
  for (const handler of [followUpHandler, handoffHandler, exportHandler]) {
    assert.match(handler, /readFreshContext\(state\.project\.id\)/u);
    assert.match(handler, /takeReviewPlanFingerprint\(fresh\.plan\) !== expectedPlanFingerprint/u);
    assert.match(handler, /takeReviewRecordsSnapshot\(fresh\.records\) !== expectedRecordSnapshot/u);
    assert.match(handler, /state\.dirty \|\| mutationRevision !== state\.mutationRevision/u);
    assert.match(handler, /state\.outputBusy = false;\s+renderAll\(\)/u);
  }
  assert.match(script, /function takeReviewRecordsSnapshot\(records = \[\]\)[\s\S]*\.map\(takeReviewRecordSnapshot\)/u);
  assert.match(followUpHandler, /state\.refreshRequired = true;[\s\S]*生成现场追拍单/u);
  assert.match(handoffHandler, /if \(!fresh\.summary\.ready\)/u);
  assert.match(exportHandler, /downloadJson/u);
  assert.match(exportHandler, /kind: "qianchuan-take-review-current-source"/u);
  assert.match(exportHandler, /source: \{ batchId: summary\.batchId, planFingerprint: currentPlanFingerprint \}/u);
  assert.match(script, /if \(revision !== state\.loadRevision\) return;/u);
  assert.match(script, /state\.dirty \|\| state\.saving \|\| state\.outputBusy \|\| mutationRevision !== state\.mutationRevision/u);
  assert.match(script, /window\.addEventListener\("focus"/u);
  assert.match(script, /right\.record\.createdOrder \|\| 0/u);
  assert.match(script, /right\.record\.createdAt\.localeCompare\(left\.record\.createdAt\)/u);
  assert.match(script, /function expectedRecordSet\(records = \[\]\)[\s\S]*createdOrder: record\.createdOrder \|\| 0,[\s\S]*contentSnapshot: takeReviewRecordSnapshot\(record\)/u);
  assert.match(script, /const expectedVersionRecords = expectedRecordSet/u);
  assert.match(script, /#metric-issues", deriveTakeReviewFollowUps\(summary\)\.length/u);
  assert.match(script, /shouldStartNewRecord = \["order_ambiguous", "hold", "reshoot", "unreviewed"\]/u);
  const statusStart = script.indexOf("const status = entry.orderingAmbiguous");
  const statusEnd = script.indexOf("button.append", statusStart);
  const statusSource = script.slice(statusStart, statusEnd);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  assert.ok(statusSource.indexOf("旧记录待核对") < statusSource.indexOf("停机核实"));
  assert.ok(statusSource.indexOf("停机核实") < statusSource.indexOf("需补拍"));
  assert.ok(statusSource.indexOf("需补拍") < statusSource.indexOf("首选已定"));
});

test("manages exact historical source groups without weakening the current batch", () => {
  assert.match(script, /summarizeTakeReviewHistory/u);
  assert.match(script, /deleteHistoricalTakeReviewGroup/u);
  assert.match(script, /data-history-action/u);
  assert.match(script, /exportButton\.dataset\.historyAction = "export"/u);
  assert.match(script, /deleteButton\.dataset\.historyAction = "delete"/u);
  assert.match(script, /recordsForSource\(fresh\.records, group\.batchId, group\.planFingerprint\)/u);
  assert.match(script, /takeReviewRecordsSnapshot\(freshRecords\) !== expectedRecordSnapshot/u);
  assert.match(script, /expectedRecords: expectedRecordSet\(records\)/u);
  assert.match(script, /当前方案来源不能从历史记录入口删除|目标来源不再属于历史记录/u);
  assert.match(script, /再次确认：永久删除/u);
  assert.match(script, /currentSourceRecords\(\)/u);
  assert.match(script, /renderOverview\(currentSummary\(\)\);\s+renderHistoryArchive\(\);/u);
  assert.match(script, /function renderAll\(\)[\s\S]*renderHistoryArchive\(\);\s*\}/u);
  assert.match(script, /archive\.setAttribute\("aria-busy"[\s\S]*if \(!archive\.open\) return;/u);
  assert.match(script, /#take-history-archive"\)\.addEventListener\("toggle"[\s\S]*event\.currentTarget\.open\)[\s\S]*renderHistoryArchive\(\);[\s\S]*#history-batch-list"\)\.replaceChildren\(\)/u);
  assert.match(script, /#history-batch-list"\)\.addEventListener\("click"[\s\S]*historyAction === "export"\) void exportHistoricalGroup\(group\);[\s\S]*historyAction === "delete"\) void deleteHistoricalGroup\(group\);/u);
  assert.match(script, /entry\.dataset\.historyBatchId === group\.batchId[\s\S]*data-history-action="export"/u);
  assert.match(css, /\.history-batch-list[^{]*\{[^}]*grid-template-columns/isu);
  assert.match(css, /\.history-capacity-warning/iu);
});

test("unlocks rebuilt navigation and history controls after every completed write", () => {
  const unlockBeforeRender = [...script.matchAll(/state\.saving = false;\s+renderAll\(\);/gu)];
  assert.ok(unlockBeforeRender.length >= 6, "every save, delete and clear completion branch should unlock before rebuilding controls");
});

test("keeps the take workbench local-only and inside the existing MV3 permission boundary", () => {
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  const executable = `${script}\n${sidepanelScript}`;
  assert.doesNotMatch(script, /fetch\s*\(|XMLHttpRequest|WebSocket|MediaRecorder|getUserMedia|captureStream|FileReader|webkitRequestFileSystem/iu);
  assert.doesNotMatch(script, /productionStatus|setVersionProductionStatus/u);
  assert.doesNotMatch(executable, /take-review-workbench[^\n]*(?:https?:\/\/)/iu);
  assert.doesNotMatch(`${html}\n${css}`, /<script[^>]+src=["']https?:|@import\s+url\(["']?https?:/iu);
  assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(|new Function\s*\(/u);
});

test("keeps page controls explicit, ids unique and layout responsive", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const buttons = [...html.matchAll(/<button\b([^>]*)>/giu)].map((match) => match[1]);
  assert.ok(buttons.length >= 6);
  assert.ok(buttons.every((attributes) => /\btype="(?:button|submit)"/iu.test(attributes)));
  assert.match(css, /grid-template-columns: minmax\(210px, \.7fr\) minmax\(440px, 1\.65fr\) minmax\(280px, 1fr\)/u);
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /@media \(max-width: 480px\)/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /\.follow-up-list[^{]*\{[^}]*max-height:[^}]*overflow: auto/isu);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/u);
});
