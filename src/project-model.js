import { normalizeCreativeTask } from "./core.js";
import { EXPERIMENT_QUALITY_WARNING_LABELS } from "./experiment-results.js";
import { sanitizedAnalysis, sanitizedCreativePlan, sanitizedTargetRoi } from "./update.js";

export const PROJECT_PORTFOLIO_SCHEMA_VERSION = 1;
export const PROJECT_LIMITS = Object.freeze({
  maxProjects: 20,
  maxVersionsPerProject: 500,
  maxResultsPerProject: 500,
  maxProjectNameLength: 60,
  maxPortfolioBytes: 12 * 1024 * 1024
});

const PROJECT_ID_PATTERN = /^prj_[a-z0-9-]{8,64}$/iu;
const TEST_ID_PATTERN = /^[a-z0-9._:-]{1,128}$/iu;
const RESULT_METRICS = Object.freeze(["spend", "gmv", "roi", "impressions", "clicks", "conversions", "ctr", "cvr", "threeSecondRate", "completionRate"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function exactIso(value, label, fallback = "") {
  const candidate = String(value || fallback);
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间格式无效`);
  return candidate;
}

function safeProjectId(value) {
  const id = String(value || "").trim();
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error("项目编号格式无效");
  return id;
}

function safeTestId(value, label = "测试编号") {
  const id = String(value || "").trim();
  if (!TEST_ID_PATTERN.test(id)) throw new Error(`${label}格式无效`);
  return id;
}

function boundedNumber(value, label, { min = 0, max = 1e12, nullable = true } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label}数值无效`);
  return parsed;
}

function sanitizedPlanExportReceipt(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !/^[a-z0-9:_-]{1,128}$/iu.test(value.fingerprint || "")) throw new Error("方案完成记录格式无效");
  return {
    fingerprint: String(value.fingerprint),
    completedAt: value.completedAt ? exactIso(value.completedAt, "方案完成") : ""
  };
}

export function sanitizeProjectName(value) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!name) throw new Error("项目名称不能为空");
  if (name.length > PROJECT_LIMITS.maxProjectNameLength) throw new Error(`项目名称最多 ${PROJECT_LIMITS.maxProjectNameLength} 个字符`);
  return name;
}

export function createProjectId(randomUUID = () => crypto.randomUUID()) {
  return safeProjectId(`prj_${String(randomUUID()).toLowerCase()}`);
}

export function emptyProjectWorkspace() {
  return {
    creativeTask: normalizeCreativeTask({}),
    targetRoi: 1.5,
    lastAnalysis: null,
    creativePlan: null,
    planExportReceipt: null
  };
}

export function sanitizeProjectWorkspace(value = {}) {
  if (!isRecord(value)) throw new Error("项目工作区格式无效");
  return {
    creativeTask: normalizeCreativeTask(isRecord(value.creativeTask) ? value.creativeTask : {}),
    targetRoi: sanitizedTargetRoi(value.targetRoi),
    lastAnalysis: sanitizedAnalysis(value.lastAnalysis ?? null),
    creativePlan: sanitizedCreativePlan(value.creativePlan ?? null),
    planExportReceipt: sanitizedPlanExportReceipt(value.planExportReceipt ?? null)
  };
}

export function createProjectRecord({ id = createProjectId(), name = "未命名项目", workspace = emptyProjectWorkspace(), now = new Date().toISOString() } = {}) {
  const timestamp = exactIso(now, "项目创建");
  return {
    id: safeProjectId(id),
    name: sanitizeProjectName(name),
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    workspace: sanitizeProjectWorkspace(workspace)
  };
}

export function sanitizeProjectRecord(value) {
  if (!isRecord(value)) throw new Error("项目记录格式无效");
  return {
    id: safeProjectId(value.id),
    name: sanitizeProjectName(value.name),
    createdAt: exactIso(value.createdAt, "项目创建"),
    updatedAt: exactIso(value.updatedAt, "项目更新"),
    archived: value.archived === true,
    workspace: sanitizeProjectWorkspace(value.workspace)
  };
}

function sanitizedPlanItem(value) {
  const plan = sanitizedCreativePlan({
    generatedAt: new Date(0).toISOString(),
    version: "1.2.0",
    creativeTask: {},
    sourceSummary: {},
    testVariable: "hook",
    items: [value],
    notice: ""
  });
  return plan.items[0];
}

export function versionRecordId(projectId, testId) {
  return `${safeProjectId(projectId)}:${safeTestId(testId)}`;
}

export function sanitizeVersionRecord(value) {
  if (!isRecord(value)) throw new Error("测试版本记录格式无效");
  const projectId = safeProjectId(value.projectId);
  const testId = safeTestId(value.testId);
  const parentVersionId = value.parentVersionId ? safeTestId(value.parentVersionId, "父版本编号") : null;
  if (parentVersionId === testId) throw new Error("测试版本不能引用自身为父版本");
  const planItem = sanitizedPlanItem(value.planItem);
  if (planItem.id !== testId) throw new Error("测试版本与方案编号不一致");
  return {
    id: versionRecordId(projectId, testId),
    projectId,
    testId,
    parentVersionId,
    batchId: safeTestId(value.batchId || testId.replace(/-(?:B00|A\d{2})$/u, ""), "测试批次"),
    createdAt: exactIso(value.createdAt, "版本创建"),
    updatedAt: exactIso(value.updatedAt, "版本更新"),
    sourceGeneratedAt: exactIso(value.sourceGeneratedAt, "方案生成"),
    primaryVariable: String(value.primaryVariable || planItem.singleVariable).slice(0, 80),
    baselineCreative: String(value.baselineCreative || planItem.baselineCreative).slice(0, 500),
    minSpend: boundedNumber(value.minSpend ?? planItem.minSpend, "最低测试消耗", { min: 0, max: 1e9, nullable: false }),
    planItem
  };
}

export function versionRecordsFromPlan({ projectId, plan, parentVersionId, existingVersions = [], now = new Date().toISOString() }) {
  const safeProject = safeProjectId(projectId);
  const sanitizedPlan = sanitizedCreativePlan(plan);
  if (!sanitizedPlan?.items?.length) return [];
  const timestamp = exactIso(now, "版本同步");
  const generatedAt = exactIso(sanitizedPlan.generatedAt, "方案生成");
  const existing = new Map(existingVersions
    .map(sanitizeVersionRecord)
    .filter((entry) => entry.projectId === safeProject)
    .map((entry) => [entry.testId, entry]));
  const knownIds = new Set(existing.keys());
  const explicitParent = parentVersionId === undefined ? undefined : parentVersionId ? safeTestId(parentVersionId, "父版本编号") : null;
  if (explicitParent && !knownIds.has(explicitParent)) throw new Error("所选父版本不属于当前项目或已不存在");
  const batchId = safeTestId(sanitizedPlan.batchId || sanitizedPlan.items[0].id.replace(/-(?:B00|A\d{2})$/u, ""), "测试批次");
  return sanitizedPlan.items.map((item) => {
    const testId = safeTestId(item.id);
    const previous = existing.get(testId);
    const parent = explicitParent === undefined ? previous?.parentVersionId ?? null : explicitParent;
    if (parent === testId) throw new Error("测试版本不能引用自身为父版本");
    return sanitizeVersionRecord({
      id: versionRecordId(safeProject, testId),
      projectId: safeProject,
      testId,
      parentVersionId: parent,
      batchId,
      createdAt: previous?.createdAt || generatedAt,
      updatedAt: timestamp,
      sourceGeneratedAt: generatedAt,
      primaryVariable: item.singleVariable,
      baselineCreative: item.baselineCreative,
      minSpend: item.minSpend,
      planItem: item
    });
  });
}

export function sanitizeResultRecord(value) {
  if (!isRecord(value)) throw new Error("结果记录格式无效");
  const projectId = safeProjectId(value.projectId);
  const testId = safeTestId(value.testId);
  if (!isRecord(value.metrics)) throw new Error("结果指标格式无效");
  const metrics = {};
  for (const key of RESULT_METRICS) {
    const max = ["roi"].includes(key) ? 1e6 : ["ctr", "cvr", "threeSecondRate", "completionRate"].includes(key) ? 1 : 1e12;
    metrics[key] = boundedNumber(value.metrics[key], `结果指标 ${key}`, { min: 0, max });
  }
  if (metrics.spend === null) throw new Error("结果记录缺少消耗");
  if (metrics.impressions !== null && metrics.clicks !== null && metrics.clicks > metrics.impressions) throw new Error("结果记录点击量不能大于展示量");
  if (metrics.clicks !== null && metrics.conversions !== null && metrics.conversions > metrics.clicks) throw new Error("结果记录转化量不能大于点击量");
  if (metrics.roi === null && metrics.gmv !== null && metrics.spend > 0) metrics.roi = metrics.gmv / metrics.spend;
  if (metrics.ctr === null && metrics.clicks !== null && metrics.impressions > 0) metrics.ctr = metrics.clicks / metrics.impressions;
  if (metrics.cvr === null && metrics.conversions !== null && metrics.clicks > 0) metrics.cvr = metrics.conversions / metrics.clicks;
  if (metrics.roi !== null && metrics.roi > 1e6) throw new Error("结果指标 roi 数值无效");
  if (metrics.ctr !== null && metrics.ctr > 1) throw new Error("结果指标 ctr 数值无效");
  if (metrics.cvr !== null && metrics.cvr > 1) throw new Error("结果指标 cvr 数值无效");
  const qualityWarnings = value.qualityWarnings ?? [];
  if (!Array.isArray(qualityWarnings) || qualityWarnings.length > Object.keys(EXPERIMENT_QUALITY_WARNING_LABELS).length) throw new Error("结果口径提醒格式无效");
  const safeQualityWarnings = [...new Set(qualityWarnings.map((entry) => String(entry)))];
  if (safeQualityWarnings.some((code) => !Object.hasOwn(EXPERIMENT_QUALITY_WARNING_LABELS, code))) throw new Error("结果口径提醒代码无效");
  return {
    id: versionRecordId(projectId, testId),
    projectId,
    testId,
    importedAt: exactIso(value.importedAt, "结果导入"),
    metrics,
    qualityWarnings: safeQualityWarnings
  };
}

export function createResultRecord({ projectId, testId, metrics, qualityWarnings = [], importedAt = new Date().toISOString() }) {
  return sanitizeResultRecord({ projectId, testId, metrics, qualityWarnings, importedAt });
}

export function evaluateExperimentResult(version, result, parentResult, targetRoi = 1.5) {
  if (!result) return { code: "pending", label: "待回填", detail: "尚未导入投放结果" };
  const spend = result.metrics.spend ?? 0;
  const roi = result.metrics.roi;
  if (spend < version.minSpend) return { code: "insufficient", label: "样本不足", detail: `消耗 ${spend.toFixed(2)} / 最低 ${version.minSpend.toFixed(2)}` };
  if (roi === null) return { code: "metric_missing", label: "缺少 ROI", detail: "可补充 ROI，或同时提供成交金额与消耗" };
  const safeTarget = sanitizedTargetRoi(targetRoi);
  if (roi >= safeTarget) return { code: "target_met", label: "达到目标", detail: `ROI ${roi.toFixed(2)} ≥ ${safeTarget.toFixed(2)}` };
  const parentRoi = parentResult?.metrics?.roi;
  if (Number.isFinite(parentRoi)) {
    const delta = roi - parentRoi;
    return delta >= 0
      ? { code: "above_parent", label: "高于父版本", detail: `ROI 较父版本 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}，仍未达到目标` }
      : { code: "below_parent", label: "低于父版本", detail: `ROI 较父版本 ${delta.toFixed(2)}；仅表示相关差异，不证明因果` };
  }
  return { code: "below_target", label: "未达目标", detail: `ROI ${roi.toFixed(2)} < ${safeTarget.toFixed(2)}` };
}

export function buildVersionTimeline(versions = [], results = [], targetRoi = 1.5) {
  const safeVersions = versions.map(sanitizeVersionRecord);
  const versionMap = new Map(safeVersions.map((version) => [version.id, version]));
  const resultMap = new Map(results.map((entry) => {
    const result = sanitizeResultRecord(entry);
    return [result.id, result];
  }));
  return safeVersions
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.testId.localeCompare(left.testId))
    .map((version) => {
      const result = resultMap.get(version.id) || null;
      const parentId = version.parentVersionId ? versionRecordId(version.projectId, version.parentVersionId) : null;
      const candidateParentResult = parentId ? resultMap.get(parentId) || null : null;
      const parentVersion = parentId ? versionMap.get(parentId) || null : null;
      const parentResult = candidateParentResult && parentVersion && candidateParentResult.metrics.spend >= parentVersion.minSpend ? candidateParentResult : null;
      return { version, result, evaluation: evaluateExperimentResult(version, result, parentResult, targetRoi) };
    });
}

export function validateProjectPortfolio(value) {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_PORTFOLIO_SCHEMA_VERSION) throw new Error("项目集合备份版本不受支持");
  const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (byteLength > PROJECT_LIMITS.maxPortfolioBytes) throw new Error("项目集合备份超过 12 MB 上限");
  if (!Array.isArray(value.projects) || !value.projects.length || value.projects.length > PROJECT_LIMITS.maxProjects) throw new Error("项目集合数量无效");
  if (!Array.isArray(value.versions) || !Array.isArray(value.results)) throw new Error("项目集合缺少版本或结果列表");
  const projects = value.projects.map(sanitizeProjectRecord);
  const projectIds = new Set();
  for (const project of projects) {
    if (projectIds.has(project.id)) throw new Error("项目集合包含重复项目编号");
    projectIds.add(project.id);
  }
  const currentProjectId = safeProjectId(value.currentProjectId);
  if (!projectIds.has(currentProjectId)) throw new Error("当前项目不在项目集合中");
  const versions = value.versions.map(sanitizeVersionRecord);
  const versionIds = new Set();
  const versionCounts = new Map();
  for (const version of versions) {
    if (!projectIds.has(version.projectId) || versionIds.has(version.id)) throw new Error("项目集合包含无效或重复的测试版本");
    versionIds.add(version.id);
    versionCounts.set(version.projectId, (versionCounts.get(version.projectId) || 0) + 1);
    if (versionCounts.get(version.projectId) > PROJECT_LIMITS.maxVersionsPerProject) throw new Error("单项目测试版本超过 500 条上限");
  }
  for (const version of versions) {
    if (version.parentVersionId && !versionIds.has(versionRecordId(version.projectId, version.parentVersionId))) throw new Error("测试版本引用了不存在的父版本");
  }
  const versionMap = new Map(versions.map((version) => [version.id, version]));
  for (const version of versions) {
    const visited = new Set([version.id]);
    let cursor = version;
    while (cursor.parentVersionId) {
      const parentId = versionRecordId(cursor.projectId, cursor.parentVersionId);
      if (visited.has(parentId)) throw new Error("测试版本父版本关系包含循环引用");
      visited.add(parentId);
      cursor = versionMap.get(parentId);
    }
  }
  const results = value.results.map(sanitizeResultRecord);
  const resultIds = new Set();
  const resultCounts = new Map();
  for (const result of results) {
    if (!versionIds.has(result.id) || resultIds.has(result.id)) throw new Error("项目集合包含无效或重复的结果记录");
    resultIds.add(result.id);
    resultCounts.set(result.projectId, (resultCounts.get(result.projectId) || 0) + 1);
    if (resultCounts.get(result.projectId) > PROJECT_LIMITS.maxResultsPerProject) throw new Error("单项目结果记录超过 500 条上限");
  }
  return { schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION, currentProjectId, projects, versions, results };
}

export function projectWorkspaceStorageWrite(workspace) {
  const safe = sanitizeProjectWorkspace(workspace);
  return clone(safe);
}
