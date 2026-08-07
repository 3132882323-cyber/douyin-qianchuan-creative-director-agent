import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_API_URL,
  compareVersions,
  fetchLatestRelease,
  normalizeReleaseMetadata,
  parseVersion,
  safeUpdateSnapshot,
  sanitizedCreativePlan,
  shouldAutoCheck,
  validateUpdateSnapshot
} from "../src/update.js";

function release(overrides = {}) {
  return {
    tag_name: "v0.3.2",
    name: "V0.3.2",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/3132882323-cyber/douyin-qianchuan-creative-director-agent/releases/tag/v0.3.2",
    published_at: "2026-08-02T08:00:00Z",
    ...overrides
  };
}

function response(payload, { status = 200, contentLength = "" } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? contentLength : null },
    text: async () => text
  };
}

test("compares stable semantic versions without treating remote text as code", () => {
  assert.equal(parseVersion("v0.3.1").text, "0.3.1");
  assert.ok(compareVersions("0.3.2", "0.3.1") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.throws(() => parseVersion("latest"), /无法识别版本号/);
});

test("normalizes only this repository's stable GitHub release", () => {
  const result = normalizeReleaseMetadata(release(), "0.3.1");
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "0.3.2");
  assert.equal(result.installMode, "manual_confirmed");
  assert.throws(() => normalizeReleaseMetadata(release({ prerelease: true }), "0.3.1"), /预发布/);
  assert.throws(() => normalizeReleaseMetadata(release({ html_url: "https://example.com/payload" }), "0.3.1"), /不属于本项目/);
});

test("fetches release metadata from the fixed API and never downloads an asset", async () => {
  let requested = null;
  const result = await fetchLatestRelease("0.3.1", {
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return response(release());
    }
  });
  assert.equal(requested.url, RELEASE_API_URL);
  assert.equal(requested.options.method, "GET");
  assert.equal(requested.options.credentials, "omit");
  assert.equal(requested.options.redirect, "error");
  assert.equal(result.latestVersion, "0.3.2");
  assert.equal(result.releaseUrl.endsWith("/tag/v0.3.2"), true);
});

test("fails closed on HTTP errors, invalid JSON and oversized metadata", async () => {
  await assert.rejects(() => fetchLatestRelease("0.3.1", { fetchImpl: async () => response({}, { status: 404 }) }), /尚未发布/);
  await assert.rejects(() => fetchLatestRelease("0.3.1", { fetchImpl: async () => response("not-json") }), /有效 JSON/);
  await assert.rejects(() => fetchLatestRelease("0.3.1", { fetchImpl: async () => response({}, { contentLength: String(600 * 1024) }) }), /响应过大/);
});

test("automatic checks are explicit opt-in and rate limited", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  assert.equal(shouldAutoCheck({ autoCheck: false }, null, now), false);
  assert.equal(shouldAutoCheck({ autoCheck: true }, null, now), true);
  assert.equal(shouldAutoCheck({ autoCheck: true }, { checkedAt: "2026-08-02T11:00:00Z" }, now), false);
  assert.equal(shouldAutoCheck({ autoCheck: true }, { checkedAt: "2026-08-01T10:00:00Z" }, now), true);
});

test("exports and validates a whitelisted local-workspace backup", () => {
  const snapshot = safeUpdateSnapshot({
    creativeTask: { subject: "测试主题", targetAudience: "测试受众", coreClaim: "测试主张" },
    targetRoi: 1.8,
    lastAnalysis: { summary: { creativeCount: 2 } },
    creativePlan: { items: [] },
    updateSettings: { autoCheck: true }
  }, "0.3.1");
  const restored = validateUpdateSnapshot(snapshot);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(restored.creativeTask.subject, "测试主题");
  assert.equal("productBrief" in snapshot.data, false);
  assert.equal(restored.targetRoi, 1.8);
  assert.equal(restored.updateSettings.autoCheck, true);
  assert.equal("unknownSecret" in restored, false);
  assert.throws(() => validateUpdateSnapshot({ schemaVersion: 3 }), /不受支持/);
});

test("imports a V1 productBrief backup into creativeTask without leaking retired fields into V2", () => {
  const legacySnapshot = {
    schemaVersion: 1,
    extensionVersion: "0.5.0",
    data: {
      productBrief: {
        productName: "旧素材主题",
        category: "旧类目",
        targetAudience: "旧受众",
        painPoints: "旧问题",
        sellingPoints: "旧主张",
        evidence: "旧证据",
        promotion: "旧促销",
        shootingConditions: "旧拍摄条件",
        forbiddenExpressions: "旧风险",
        duration: 30
      },
      creativePlan: {
        version: "0.5.0",
        brief: { productName: "旧素材主题", category: "旧类目", promotion: "旧促销" },
        items: [{ sellingPoint: "旧主张", production: {} }]
      }
    }
  };
  const restored = validateUpdateSnapshot(legacySnapshot);
  assert.equal(restored.creativeTask.subject, "旧素材主题");
  assert.equal(restored.creativeTask.targetAudience, "旧受众");
  assert.equal(restored.creativeTask.audienceProblems, "旧问题");
  assert.equal(restored.creativeTask.coreClaim, "旧主张");
  assert.equal(restored.creativeTask._migration.archivedLegacyData.category, "旧类目");
  assert.equal(restored.creativePlan.brief, undefined);
  assert.equal(restored.creativePlan.items[0].coreClaim, "旧主张");
  assert.equal(restored.creativePlan.items[0].sellingPoint, undefined);

  const nextSnapshot = safeUpdateSnapshot(restored, "1.0.4");
  const serialized = JSON.stringify(nextSnapshot);
  assert.equal(nextSnapshot.schemaVersion, 2);
  assert.doesNotMatch(serialized, /productName|category|promotion|productBrief|"brief"/u);
  assert.match(serialized, /旧素材主题|旧受众|旧主张/u);

  const v2WithUnknownLegacyKey = structuredClone(nextSnapshot);
  v2WithUnknownLegacyKey.data.productBrief = "ignored retired key";
  assert.equal(validateUpdateSnapshot(v2WithUnknownLegacyKey).creativeTask.subject, "旧素材主题");
});

test("schema V2 strips unknown nested fields without deleting legitimate user text", () => {
  const sentinel = "DO_NOT_EXPORT_6F31";
  const legitimateText = "台词可以包含 unknownSecret 这样的普通文字，不应按关键词删除";
  const snapshot = safeUpdateSnapshot({
    creativeTask: { subject: "白名单测试", unknownTaskField: sentinel },
    lastAnalysis: {
      generatedAt: "2026-08-05T00:00:00.000Z",
      summary: { creativeCount: 1, targetRoi: 1.5, nestedSecret: sentinel },
      topCreatives: [{ creativeName: "素材 A", spend: 100, roi: 2, unknownRowField: { value: sentinel } }],
      tagInsights: { hook: [{ value: "开场", spend: 100, roi: 2, unknownTagField: sentinel }] },
      caveats: ["正常提示"],
      unknownAnalysisField: sentinel
    },
    creativePlan: {
      generatedAt: "2026-08-05T00:00:00.000Z",
      version: "0.6.2",
      dependencyFingerprint: "fnv1a32:1234abcd",
      creativeTask: { subject: "白名单测试" },
      sourceSummary: { creativeCount: 1, targetRoi: 1.5, unknownSummaryField: sentinel },
      testVariable: "hook",
      notice: "正常说明",
      unknownPlanField: sentinel,
      items: [{
        id: "MAT-1",
        type: "基线",
        coreClaim: "正常主张",
        unknownItemField: sentinel,
        production: { spokenScript: legitimateText, unknownProductionField: sentinel }
      }]
    },
    updateSettings: { autoCheck: true, unknownSetting: sentinel },
    lastUpdateCheck: { checkedAt: "2026-08-05T00:00:00.000Z", currentVersion: "0.6.2", unknownUpdateField: sentinel }
  }, "1.0.4");
  const restored = validateUpdateSnapshot(snapshot);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, new RegExp(sentinel));
  assert.equal(restored.creativePlan.items[0].production.spokenScript, legitimateText);
  assert.equal(restored.creativePlan.dependencyFingerprint, "fnv1a32:1234abcd");
  assert.equal(restored.creativePlan.unknownPlanField, undefined);
  assert.equal(restored.creativePlan.items[0].unknownItemField, undefined);
  assert.equal(restored.lastAnalysis.topCreatives[0].unknownRowField, undefined);
  assert.deepEqual(restored.updateSettings, { autoCheck: true });
});

test("caps damaged or oversized stored plan lists before rendering", () => {
  const restored = sanitizedCreativePlan({
    items: Array.from({ length: 140 }, (_, index) => ({ id: `MAT-${index}`, production: {} }))
  });
  assert.equal(restored.items.length, 100);
  assert.equal(restored.items.at(-1).id, "MAT-99");
});
