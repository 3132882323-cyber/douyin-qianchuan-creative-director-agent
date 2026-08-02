import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_API_URL,
  compareVersions,
  fetchLatestRelease,
  normalizeReleaseMetadata,
  parseVersion,
  safeUpdateSnapshot,
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
    productBrief: { productName: "测试商品" },
    targetRoi: 1.8,
    lastAnalysis: { summary: { creativeCount: 2 } },
    creativePlan: { items: [] },
    updateSettings: { autoCheck: true }
  }, "0.3.1");
  const restored = validateUpdateSnapshot(snapshot);
  assert.equal(restored.productBrief.productName, "测试商品");
  assert.equal(restored.targetRoi, 1.8);
  assert.equal(restored.updateSettings.autoCheck, true);
  assert.equal("unknownSecret" in restored, false);
  assert.throws(() => validateUpdateSnapshot({ schemaVersion: 2 }), /不受支持/);
});
