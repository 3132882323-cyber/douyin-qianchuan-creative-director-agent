import test from "node:test";
import assert from "node:assert/strict";
import { buildRecentWorkModel } from "../src/recent-work.js";

test("shows an honest empty state without pretending workbench media is recoverable", () => {
  const model = buildRecentWorkModel();
  assert.equal(model.kind, "empty");
  assert.equal(model.targetView, "review");
  assert.equal(model.focusId, "report-file-trigger");
  assert.match(model.description, /不会在这里伪装成可恢复任务/u);
});

test("continues from the strongest reliable local director state", () => {
  const task = buildRecentWorkModel({ hasCreativeTask: true });
  assert.equal(task.kind, "task-ready");
  assert.equal(task.action, "导入历史素材");

  const review = buildRecentWorkModel({ hasCreativeTask: true, analysisCount: 18 });
  assert.equal(review.kind, "review-ready");
  assert.equal(review.targetView, "next");
  assert.equal(review.focusId, "generate-plan");

  const plan = buildRecentWorkModel({ analysisCount: 18, planCount: 3 });
  assert.equal(plan.kind, "plan-ready");
  assert.equal(plan.focusId, "copy-run-sheet");
  assert.equal(plan.action, "查看开拍清单");
  assert.match(plan.description, /基线和变体顺序/u);
  assert.match(plan.description, /3 个/u);

  const recoveredReview = buildRecentWorkModel({ hasAnalysis: true, analysisCount: 0 });
  assert.equal(recoveredReview.kind, "review-ready");
  assert.equal(recoveredReview.focusId, "generate-plan");
});

test("does not present stale or unfinished work as ready", () => {
  const stale = buildRecentWorkModel({ analysisCount: 18, planCount: 3, planStale: true });
  assert.equal(stale.kind, "plan-stale");
  assert.equal(stale.action, "重新生成任务");

  const pending = buildRecentWorkModel({ analysisCount: 18, reviewPending: true, planCount: 3, planStale: true });
  assert.equal(pending.kind, "review-pending");
  assert.equal(pending.targetView, "review");
  assert.equal(pending.focusId, "analyze-button");

  const missingReview = buildRecentWorkModel({ hasAnalysis: false, planCount: 3, planStale: true });
  assert.equal(missingReview.kind, "review-missing");
  assert.equal(missingReview.action, "重新导入历史素材");
  assert.equal(missingReview.focusId, "report-file-trigger");
});

test("starts a new review after the current round was exported", () => {
  const model = buildRecentWorkModel({ analysisCount: 18, planCount: 3, planExported: true });
  assert.equal(model.kind, "round-complete");
  assert.equal(model.action, "开始下一轮复盘");
  assert.equal(model.focusId, "report-file-trigger");
});
