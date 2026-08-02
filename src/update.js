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

export function safeUpdateSnapshot(storage = {}, extensionVersion = "") {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: parseVersion(extensionVersion).text,
    data: {
      productBrief: storage.productBrief ?? {},
      targetRoi: storage.targetRoi ?? 1.5,
      lastAnalysis: storage.lastAnalysis ?? null,
      creativePlan: storage.creativePlan ?? null,
      updateSettings: storage.updateSettings ?? { autoCheck: false },
      lastUpdateCheck: storage.lastUpdateCheck ?? null
    },
    notice: "仅包含浏览器本地工作区数据，不包含原始 CSV、视频、图片、Cookie、Token 或私钥。"
  };
}

export function validateUpdateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("备份文件格式无效");
  if (snapshot.schemaVersion !== 1) throw new Error("备份文件版本不受支持");
  parseVersion(snapshot.extensionVersion);
  const source = snapshot.data;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("备份文件缺少工作区数据");
  const objectOrNull = (value, label) => {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
    return structuredClone(value);
  };
  const targetRoi = Number(source.targetRoi ?? 1.5);
  if (!Number.isFinite(targetRoi) || targetRoi < 0 || targetRoi > 100000) throw new Error("目标 ROI 格式无效");
  return {
    productBrief: objectOrNull(source.productBrief ?? {}, "商品 Brief") ?? {},
    targetRoi,
    lastAnalysis: objectOrNull(source.lastAnalysis ?? null, "复盘数据"),
    creativePlan: objectOrNull(source.creativePlan ?? null, "拍摄方案"),
    updateSettings: objectOrNull(source.updateSettings ?? { autoCheck: false }, "更新设置") ?? { autoCheck: false },
    lastUpdateCheck: objectOrNull(source.lastUpdateCheck ?? null, "更新记录")
  };
}
