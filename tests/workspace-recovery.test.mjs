import test from "node:test";
import assert from "node:assert/strict";
import { recoverStoredWorkspace } from "../src/workspace-recovery.js";

function validAnalysis() {
  return {
    generatedAt: "2026-08-05T00:00:00.000Z",
    summary: { creativeCount: 1, targetRoi: 1.5 },
    topCreatives: [{ creativeName: "素材 A", spend: 100, roi: 2 }],
    tagInsights: {}
  };
}

function validPlan() {
  return {
    generatedAt: "2026-08-05T00:00:00.000Z",
    version: "0.6.2",
    dependencyFingerprint: "fnv1a32:1234abcd",
    creativeTask: { subject: "素材主题" },
    sourceSummary: { creativeCount: 1, targetRoi: 1.5 },
    testVariable: "hook",
    items: [{ id: "MAT-1", type: "基线", coreClaim: "可信主张", production: {} }]
  };
}

test("isolates damaged storage records and still returns a usable workspace", () => {
  const result = recoverStoredWorkspace({
    creativeTask: "broken",
    targetRoi: "not-a-number",
    lastAnalysis: { topCreatives: "broken" },
    creativePlan: { items: "broken" },
    updateSettings: [],
    lastUpdateCheck: [],
    planExportReceipt: "broken",
    onboardingDismissed: "yes",
    productBrief: "broken"
  });

  assert.deepEqual(result.data.creativeTask, {});
  assert.equal(result.data.targetRoi, 1.5);
  assert.equal(result.data.lastAnalysis, null);
  assert.equal(result.data.creativePlan, null);
  assert.deepEqual(result.data.updateSettings, { autoCheck: false });
  assert.equal(result.data.lastUpdateCheck, null);
  assert.equal(result.data.planExportReceipt, null);
  assert.equal(result.data.onboardingDismissed, false);
  assert.equal(result.issues.length, 9);
  assert.deepEqual(new Set(result.invalidKeys), new Set([
    "creativeTask",
    "targetRoi",
    "lastAnalysis",
    "creativePlan",
    "updateSettings",
    "lastUpdateCheck",
    "planExportReceipt",
    "onboardingDismissed",
    "productBrief"
  ]));
  assert.deepEqual(result.cleanupKeys, []);
  assert.deepEqual(result.writes, {});
});

test("restores valid V0.6 workspace data without changing the backup schema", () => {
  const result = recoverStoredWorkspace({
    creativeTask: { subject: "主题", targetAudience: "受众", duration: 30 },
    targetRoi: 2.4,
    lastAnalysis: validAnalysis(),
    creativePlan: validPlan(),
    updateSettings: { autoCheck: true },
    lastUpdateCheck: { checkedAt: "2026-08-05T00:00:00.000Z", currentVersion: "0.6.2" },
    planExportReceipt: { fingerprint: "fnv1a32:1234abcd", completedAt: "2026-08-05T01:00:00.000Z" },
    onboardingDismissed: true,
    migrationNoticePending: true
  });

  assert.equal(result.data.creativeTask.subject, "主题");
  assert.equal(result.data.creativeTask.duration, 30);
  assert.equal(result.data.targetRoi, 2.4);
  assert.equal(result.data.lastAnalysis.topCreatives[0].creativeName, "素材 A");
  assert.equal(result.data.creativePlan.items[0].id, "MAT-1");
  assert.deepEqual(result.data.updateSettings, { autoCheck: true });
  assert.equal(result.data.onboardingDismissed, true);
  assert.equal(result.data.migrationNoticePending, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.invalidKeys, []);
  assert.deepEqual(result.cleanupKeys, []);
  assert.deepEqual(result.writes, {});
  assert.equal(result.migrated, false);
});

test("migrates a valid V0.5 productBrief once and preserves the archived compatibility data", () => {
  const result = recoverStoredWorkspace({
    productBrief: {
      productName: "旧素材主题",
      category: "仅归档分类",
      targetAudience: "旧受众",
      painPoints: "旧问题",
      sellingPoints: "旧主张",
      duration: 60
    }
  });

  assert.equal(result.data.creativeTask.subject, "旧素材主题");
  assert.equal(result.data.creativeTask.coreClaim, "旧主张");
  assert.equal(result.data.creativeTask.duration, 60);
  assert.equal(result.data.creativeTask._migration.archivedLegacyData.category, "仅归档分类");
  assert.equal(result.writes.creativeTask.subject, "旧素材主题");
  assert.deepEqual(result.cleanupKeys, ["productBrief"]);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.invalidKeys, []);
});

test("uses a valid legacy record as recovery without asking to delete the replacement task", () => {
  const result = recoverStoredWorkspace({
    creativeTask: "broken",
    productBrief: { productName: "恢复主题", sellingPoints: "恢复主张" }
  });

  assert.equal(result.data.creativeTask.subject, "恢复主题");
  assert.equal(result.writes.creativeTask.subject, "恢复主题");
  assert.equal(result.invalidKeys.includes("creativeTask"), false);
  assert.deepEqual(result.cleanupKeys, ["productBrief"]);
  assert.match(result.issues[0].message, /恢复/u);
});
