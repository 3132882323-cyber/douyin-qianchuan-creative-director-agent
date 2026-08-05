import { migrateLegacyProductBrief, normalizeCreativeTask } from "./core.js";

export const UPDATE_ORIGIN_PATTERN = "https://api.github.com/*";
export const RELEASE_API_URL = "https://api.github.com/repos/3132882323-cyber/douyin-qianchuan-creative-director-agent/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/3132882323-cyber/douyin-qianchuan-creative-director-agent/releases";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RELEASE_RESPONSE_BYTES = 512 * 1024;

export function parseVersion(value) {
  const text = String(value ?? "").trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) throw new Error(`无法识别版本号：${text || "空"}`);
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || ""
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function validatedReleaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("版本发布页地址无效");
  }
  const expectedPrefix = "/3132882323-cyber/douyin-qianchuan-creative-director-agent/releases/";
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(expectedPrefix)) {
    throw new Error("版本发布页不属于本项目的 GitHub Releases");
  }
  return url.href;
}

export function normalizeReleaseMetadata(payload, currentVersion) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("GitHub 返回的版本信息格式无效");
  if (payload.draft === true) throw new Error("最新版本仍是草稿，不能用于更新");
  if (payload.prerelease === true) throw new Error("稳定通道不会安装预发布版本");
  const current = parseVersion(currentVersion).text;
  const latest = parseVersion(payload.tag_name).text;
  const releaseUrl = validatedReleaseUrl(payload.html_url);
  return {
    checkedAt: new Date().toISOString(),
    currentVersion: current,
    latestVersion: latest,
    available: compareVersions(latest, current) > 0,
    releaseName: String(payload.name || payload.tag_name || `v${latest}`).slice(0, 120),
    releaseUrl,
    publishedAt: String(payload.published_at || ""),
    source: "github_releases",
    installMode: "manual_confirmed"
  };
}

export async function fetchLatestRelease(currentVersion, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前环境不支持版本检查");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await fetchImpl(options.apiUrl ?? RELEASE_API_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (!response?.ok) {
      if (response?.status === 404) throw new Error("项目尚未发布可安装的 Release");
      if (response?.status === 403) throw new Error("GitHub 暂时限制了版本检查，请稍后重试");
      throw new Error(`版本检查失败（HTTP ${response?.status || "未知"}）`);
    }
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_RELEASE_RESPONSE_BYTES) throw new Error("版本信息响应过大，已停止处理");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RELEASE_RESPONSE_BYTES) throw new Error("版本信息响应过大，已停止处理");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("GitHub 返回的版本信息不是有效 JSON");
    }
    return normalizeReleaseMetadata(payload, currentVersion);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("版本检查超时，当前版本保持不变");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function shouldAutoCheck(settings = {}, lastCheck = null, now = Date.now()) {
  if (settings.autoCheck !== true) return false;
  const checkedAt = Date.parse(lastCheck?.checkedAt || "");
  return !Number.isFinite(checkedAt) || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

function sanitizedCreativeTask(task = {}) {
  const normalized = normalizeCreativeTask(task);
  if (task?._migration && typeof task._migration === "object" && !Array.isArray(task._migration)) {
    normalized._migration = { source: "legacy_v05", archivedLocallyOnly: true };
  }
  return normalized;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function text(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function sanitizedTargetRoi(value) {
  const parsed = Number(value ?? 1.5);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100000 ? parsed : 1.5;
}

const SUMMARY_FIELDS = ["creativeCount", "totalSpend", "totalGmv", "blendedRoi", "targetRoi", "spendFloor", "impressionFloor", "ctrMedian", "cvrMedian"];
const COLUMN_FIELDS = ["creativeName", "spend", "impressions", "clicks", "conversions", "gmv", "roi", "audience", "hook", "sellingPoint", "scene"];
const ROW_TEXT_FIELDS = ["creativeName", "audience", "hook", "sellingPoint", "scene", "segment", "confidence", "diagnosis"];
const ROW_NUMBER_FIELDS = ["sourceIndex", "spend", "gmv", "roi", "impressions", "clicks", "conversions", "ctr", "cvr"];
const PLAN_TEXT_FIELDS = ["id", "type", "baselineCreative", "singleVariable", "variant", "audience", "hook", "coreClaim", "scene", "hypothesis", "fixedElements", "observationMetrics", "stopCondition", "successAction"];
const PRODUCTION_FIELDS = ["spokenScript", "storyboard", "shootingTask", "editingNotes", "subtitleHighlights", "complianceChecklist"];

function sanitizedSummary(value = {}) {
  const source = record(value, "复盘摘要");
  return Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, number(source[key])]));
}

export function sanitizedAnalysis(value) {
  if (value === null || value === undefined) return null;
  const source = record(value, "复盘数据");
  const columnsSource = source.columns === undefined ? {} : record(source.columns, "复盘字段映射");
  const segmentsSource = source.segments === undefined ? {} : record(source.segments, "复盘分层");
  const tagSource = source.tagInsights === undefined ? {} : record(source.tagInsights, "复盘标签洞察");
  const topCreatives = Array.isArray(source.topCreatives) ? source.topCreatives.slice(0, 10).map((entry) => {
    const row = record(entry, "优先复盘素材");
    const result = Object.fromEntries(ROW_TEXT_FIELDS.map((key) => [key, text(row[key])]));
    for (const key of ROW_NUMBER_FIELDS) result[key] = number(row[key]);
    result.cpa = row.cpa === null || row.cpa === undefined ? null : number(row.cpa);
    return result;
  }) : [];
  const tagInsights = Object.fromEntries(["audience", "hook", "sellingPoint", "scene"].map((field) => {
    const entries = Array.isArray(tagSource[field]) ? tagSource[field].slice(0, 100).map((entry) => {
      const item = record(entry, "标签洞察");
      return { value: text(item.value), creativeCount: number(item.creativeCount), spend: number(item.spend), roi: number(item.roi) };
    }) : [];
    return [field, entries];
  }));
  return {
    generatedAt: text(source.generatedAt),
    columns: Object.fromEntries(COLUMN_FIELDS.filter((key) => typeof columnsSource[key] === "string").map((key) => [key, columnsSource[key]])),
    summary: sanitizedSummary(source.summary ?? {}),
    segments: Object.fromEntries(["高消耗且达标", "起量但不达标", "低曝光待验证"].map((key) => [key, number(segmentsSource[key])])),
    topCreatives,
    tagInsights,
    caveats: Array.isArray(source.caveats) ? source.caveats.slice(0, 30).map((item) => text(item)) : []
  };
}

export function sanitizedUpdateSettings(value = {}) {
  const source = record(value, "更新设置");
  return { autoCheck: source.autoCheck === true };
}

export function sanitizedLastUpdateCheck(value) {
  if (value === null || value === undefined) return null;
  const source = record(value, "更新记录");
  const result = {};
  for (const key of ["checkedAt", "currentVersion", "latestVersion", "releaseName", "releaseUrl", "publishedAt", "source", "installMode", "error"]) {
    if (source[key] !== undefined) result[key] = text(source[key]);
  }
  if (source.available !== undefined) result.available = source.available === true;
  return result;
}

export function sanitizedCreativePlan(plan) {
  if (plan === null || plan === undefined) return null;
  const source = record(plan, "拍摄方案");
  if (!Array.isArray(source.items)) throw new Error("拍摄方案缺少任务列表");
  const items = source.items.slice(0, 100).map((entry) => {
    const item = record(entry, "拍摄方案任务");
    const production = record(item.production ?? {}, "拍摄方案生产资料");
    const result = Object.fromEntries(PLAN_TEXT_FIELDS.map((key) => [key, text(key === "coreClaim" ? item.coreClaim ?? item.sellingPoint : item[key])]));
    result.minSpend = number(item.minSpend);
    result.production = Object.fromEntries(PRODUCTION_FIELDS.map((key) => [key, text(production[key])]));
    return result;
  });
  return {
    generatedAt: text(source.generatedAt),
    version: text(source.version),
    dependencyFingerprint: text(source.dependencyFingerprint),
    creativeTask: sanitizedCreativeTask(source.creativeTask ?? migrateLegacyProductBrief(source.brief ?? {})),
    sourceSummary: sanitizedSummary(source.sourceSummary ?? {}),
    testVariable: text(source.testVariable, "hook"),
    items,
    notice: text(source.notice)
  };
}

export function safeUpdateSnapshot(storage = {}, extensionVersion = "") {
  const creativeTask = sanitizedCreativeTask(storage.creativeTask ?? migrateLegacyProductBrief(storage.productBrief ?? {}));
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    extensionVersion: parseVersion(extensionVersion).text,
    data: {
      creativeTask,
      targetRoi: sanitizedTargetRoi(storage.targetRoi),
      lastAnalysis: sanitizedAnalysis(storage.lastAnalysis ?? null),
      creativePlan: sanitizedCreativePlan(storage.creativePlan ?? null),
      updateSettings: sanitizedUpdateSettings(storage.updateSettings ?? { autoCheck: false }),
      lastUpdateCheck: sanitizedLastUpdateCheck(storage.lastUpdateCheck ?? null)
    },
    notice: "仅包含浏览器本地工作区数据，不包含原始 CSV、视频、图片、旧版本地迁移归档、Cookie、Token 或私钥。"
  };
}

export function validateUpdateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("备份文件格式无效");
  if (![1, 2].includes(snapshot.schemaVersion)) throw new Error("备份文件版本不受支持");
  parseVersion(snapshot.extensionVersion);
  const source = snapshot.data;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("备份文件缺少工作区数据");
  const targetRoi = Number(source.targetRoi ?? 1.5);
  if (!Number.isFinite(targetRoi) || targetRoi < 0 || targetRoi > 100000) throw new Error("目标 ROI 格式无效");
  const legacyBrief = snapshot.schemaVersion === 1 ? record(source.productBrief ?? {}, "旧版创作资料") : {};
  const creativeTaskSource = snapshot.schemaVersion === 1
    ? migrateLegacyProductBrief(legacyBrief)
    : record(source.creativeTask ?? {}, "创作任务");
  const restoredCreativeTask = sanitizedCreativeTask(creativeTaskSource);
  if (snapshot.schemaVersion === 1 && creativeTaskSource._migration?.archivedLegacyData) {
    restoredCreativeTask._migration = structuredClone(creativeTaskSource._migration);
  }
  return {
    creativeTask: restoredCreativeTask,
    targetRoi,
    lastAnalysis: sanitizedAnalysis(source.lastAnalysis ?? null),
    creativePlan: sanitizedCreativePlan(source.creativePlan ?? null),
    updateSettings: sanitizedUpdateSettings(source.updateSettings ?? { autoCheck: false }),
    lastUpdateCheck: sanitizedLastUpdateCheck(source.lastUpdateCheck ?? null)
  };
}
