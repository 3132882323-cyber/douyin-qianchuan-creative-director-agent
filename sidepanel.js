import {
  CREATIVE_TASK_TEMPLATES,
  FIELD_DEFINITIONS,
  TAG_FIELDS,
  analyzeReport,
  creativePlanDependencyFingerprint,
  formatMoney,
  generateCreativePlan,
  inspectColumnMapping,
  normalizedStem,
  normalizeCreativeTask,
  parseCsvDocument,
  planToCsv,
  planToMarkdown,
  toMarkdown
} from "./src/core.js";
import {
  RELEASES_PAGE_URL,
  UPDATE_ORIGIN_PATTERN,
  compareVersions,
  fetchLatestRelease,
  safeUpdateSnapshot,
  sanitizedCreativePlan,
  shouldAutoCheck,
  validateUpdateSnapshot
} from "./src/update.js";
import {
  LOCAL_VIDEO_BATCH_LIMITS,
  createTranscodeManifest,
  isSupportedVideoFile,
  transcodeProgress,
  validateLocalVideoBatch,
  validateTranscodeResult
} from "./src/transcode.js";
import { MASTER_MATCH_LIMITS, formatLocalBytes, validateMasterMatchSelection } from "./src/local-file-guard.js";
import {
  IMAGE_REPAIR_LIMITS,
  clearMaskState,
  commitMaskState,
  createMaskHistory,
  currentMaskStrokes,
  maskSelectionStats,
  redoMaskState,
  repairLocalImage,
  repairOutputName,
  resolveRepairExport,
  undoMaskState,
  validateRepairDimensions,
  validateRepairFile,
  validateStaticWebpBytes
} from "./src/local-image-repair.js";
import { parseJsonDocument, validateNonMediaImport } from "./src/release-safety.js";
import { recoverStoredWorkspace } from "./src/workspace-recovery.js";
import { buildRecentWorkModel } from "./src/recent-work.js";
import {
  analysisHandoffFillCandidates,
  isDuplicateAnalysisHandoff,
  validateAnalysisHandoff,
  validateAnalysisHandoffFile
} from "./src/analysis-handoff.js";
import { CREATIVE_REVISION_EDITABLE_FIELDS } from "./src/creative-revision.js";
import {
  ANALYSIS_HANDOFF_INBOX_KEY,
  decideAnalysisHandoffPreview,
  inspectAnalysisHandoffInbox
} from "./src/analysis-handoff-inbox.js";
import { createProjectRepository, openProjectDatabase } from "./src/project-store.js";
import {
  buildVersionTimeline,
  projectWorkspaceStorageWrite,
  sanitizeProjectWorkspace,
  validateProjectPortfolio
} from "./src/project-model.js";
import { experimentQualityWarningLabel, parseExperimentResults } from "./src/experiment-results.js";
import {
  buildExperimentLedgerSnapshot,
  experimentLedgerToCsv,
  filterExperimentTimeline,
  summarizeExperimentTimeline
} from "./src/experiment-ledger.js";

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEYS = ["creativeTask", "productBrief", "targetRoi", "lastAnalysis", "creativePlan", "planExportReceipt", "updateSettings", "lastUpdateCheck", "migrationNoticePending", "onboardingDismissed"];
const CURRENT_VERSION = chrome.runtime.getManifest().version;
const state = {
  creativeTask: {},
  document: null,
  mapping: {},
  tagValues: [],
  tagPage: 0,
  analysis: null,
  analysisRestored: false,
  plan: null,
  reviewPending: false,
  planStale: false,
  planExported: false,
  planExportReceipt: null,
  analysisHandoff: null,
  analysisHandoffSource: "",
  pendingAnalysisHandoffEnvelope: null,
  appliedAnalysisHandoffIds: new Set(),
  onboardingDismissed: false,
  recoveryIssues: [],
  recoveryInvalidKeys: [],
  updateSettings: { autoCheck: false },
  lastUpdateCheck: null,
  projectRepository: null,
  currentProject: null,
  projects: [],
  versions: [],
  experimentResults: [],
  pendingResultImport: null,
  projectSwitching: false,
  matchData: null,
  matchOperation: { runId: 0, running: false, cancelRequested: false },
  masterFileIndex: new Map(),
  imageRepair: {
    file: null,
    sourceMime: "",
    sourcePixels: null,
    resultPixels: null,
    history: createMaskHistory(),
    activeStroke: null,
    tool: "brush",
    loadSequence: 0
  },
  transcodeFiles: [],
  transcodeManifest: null
};
let taskSaveTimer = null;
let planSaveTimer = null;
let onboardingReturnFocus = null;
let initializationPromise = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(selector, text, good = false) {
  const node = $(selector);
  if (node.textContent !== text) node.textContent = text;
  node.classList.toggle("good", good);
}

function setNodeText(selector, value) {
  const node = $(selector);
  const text = String(value ?? "");
  if (node.textContent !== text) node.textContent = text;
}

function setFeedback(statusSelector, errorSelector, { status = "", error = "" } = {}) {
  setNodeText(statusSelector, status);
  setNodeText(errorSelector, error);
}

function showRecoveryIssues(issues = [], invalidKeys = []) {
  const normalizedIssues = issues
    .map((entry) => typeof entry === "string" ? { key: "", message: entry } : entry)
    .filter((entry) => entry?.message);
  for (const entry of normalizedIssues) {
    if (!state.recoveryIssues.some((current) => current.key === entry.key && current.message === entry.message)) {
      state.recoveryIssues.push({ key: entry.key || "", message: String(entry.message) });
    }
  }
  state.recoveryInvalidKeys = [...new Set([...state.recoveryInvalidKeys, ...invalidKeys.filter(Boolean)])];
  const notice = $("#workspace-recovery-notice");
  notice.hidden = state.recoveryIssues.length === 0;
  if (notice.hidden) return;
  const cleanupSummary = state.recoveryInvalidKeys.length ? ` 待你确认清理的损坏键：${state.recoveryInvalidKeys.join("、")}。` : "";
  setNodeText("#workspace-recovery-message", `${state.recoveryIssues.map((entry) => entry.message).join("；")}。${cleanupSummary}`);
  $("#clear-corrupt-storage").hidden = state.recoveryInvalidKeys.length === 0;
}

async function persistOnboardingDismissal() {
  state.onboardingDismissed = true;
  try {
    await chrome.storage.local.set({ onboardingDismissed: true });
  } catch (error) {
    showRecoveryIssues([{ key: "onboardingDismissed", message: `引导收起状态未能保存：${error.message || "本地存储不可用"}` }]);
  }
}

function showOnboarding({ focus = false, returnFocus = null } = {}) {
  onboardingReturnFocus = returnFocus;
  const guide = $("#onboarding-guide");
  guide.hidden = false;
  if (focus) focusAndReveal(guide, { block: "start" });
}

async function dismissOnboarding({ moveToReview = false } = {}) {
  $("#onboarding-guide").hidden = true;
  await persistOnboardingDismissal();
  if (moveToReview) {
    focusWorkflowTarget("review", "report-file-trigger");
    return;
  }
  const target = onboardingReturnFocus?.isConnected ? onboardingReturnFocus : $("#workflow-next-action");
  onboardingReturnFocus = null;
  requestAnimationFrame(() => target?.focus());
}

function preferredScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true ? "auto" : "smooth";
}

function focusAndReveal(target, { block = "center" } = {}) {
  if (!target) return;
  requestAnimationFrame(() => {
    target.focus();
    target.scrollIntoView({ behavior: preferredScrollBehavior(), block, inline: "nearest" });
  });
}

function switchView(viewId, { focusHeading = false, scrollTop = !focusHeading } = {}) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.view === viewId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === viewId;
    view.classList.toggle("active", active);
    view.setAttribute("aria-hidden", String(!active));
  });
  if (scrollTop) window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
  if (focusHeading) {
    const heading = $(`#${viewId} h2`);
    if (heading) {
      heading.tabIndex = -1;
      focusAndReveal(heading, { block: "start" });
    }
  }
}

const workspaceTabs = [...document.querySelectorAll(".tab")];
workspaceTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? workspaceTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + workspaceTabs.length) % workspaceTabs.length;
    workspaceTabs[nextIndex].focus();
    switchView(workspaceTabs[nextIndex].dataset.view);
  });
});
document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.nav, { focusHeading: true })));

document.querySelectorAll("label.file-drop[for]").forEach((trigger) => {
  trigger.tabIndex = 0;
  trigger.setAttribute("role", "button");
  trigger.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    document.getElementById(trigger.htmlFor)?.click();
  });
});

const MEANINGFUL_TASK_FIELDS = ["subject", "targetAudience", "creativeGoal", "audienceProblems", "coreClaim", "evidence", "shootingConstraints", "riskNotes"];

function creativeTaskHasContent(task = null) {
  const source = task ?? (document.getElementById("creative-task-form") ? readCreativeTaskForm() : state.creativeTask);
  return MEANINGFUL_TASK_FIELDS.some((key) => String(source?.[key] ?? "").trim());
}

function currentProjectWorkspace() {
  return {
    creativeTask: state.creativeTask,
    targetRoi: Number($("#target-roi")?.value || 1.5),
    lastAnalysis: state.analysis,
    creativePlan: state.plan,
    planExportReceipt: state.planExportReceipt
  };
}

function setProjectFeedback({ status = "", error = "" } = {}) {
  setFeedback("#project-status", "#project-error", { status, error });
}

function renderProjectHub() {
  const select = $("#project-select");
  const currentId = state.currentProject?.id || "";
  select.replaceChildren();
  for (const project of state.projects) {
    const option = element("option", "", project.name);
    option.value = project.id;
    select.append(option);
  }
  select.value = currentId;
  select.disabled = !state.projectRepository || state.projects.length < 2 || state.projectSwitching;
  $("#new-project").disabled = !state.projectRepository || state.projectSwitching;
  $("#rename-project").disabled = !state.currentProject || state.projectSwitching;
  setNodeText("#project-local-meta", state.currentProject
    ? `${state.versions.length} 个测试版本 · ${state.experimentResults.length} 条结果 · 仅当前浏览器`
    : "项目集合不可用；当前单项目工作区仍可继续使用");
  setNodeText("#recent-task-label", state.currentProject ? `${state.currentProject.name} · 最近任务` : "最近任务 · 仅本地");
}

function metricText(result) {
  if (!result) return "尚未回填结果";
  const metrics = result.metrics;
  const parts = [`消耗 ¥${formatMoney(metrics.spend)}`];
  if (Number.isFinite(metrics.roi)) parts.push(`ROI ${metrics.roi.toFixed(2)}`);
  if (Number.isFinite(metrics.ctr)) parts.push(`CTR ${(metrics.ctr * 100).toFixed(2)}%`);
  if (Number.isFinite(metrics.cvr)) parts.push(`CVR ${(metrics.cvr * 100).toFixed(2)}%`);
  if (result.qualityWarnings?.length) parts.push(`口径提醒 ${result.qualityWarnings.length}`);
  return parts.join(" · ");
}

function renderExperimentLoop() {
  const timeline = buildVersionTimeline(state.versions, state.experimentResults, Number($("#target-roi").value || 1.5));
  const summary = summarizeExperimentTimeline(timeline);
  const selectedFilter = $("#version-filter").value || "all";
  const filteredTimeline = filterExperimentTimeline(timeline, selectedFilter);
  setNodeText("#version-count", `${timeline.length} 个版本`);
  setNodeText("#result-count", `${state.experimentResults.length} 条结果`);
  setNodeText("#experiment-summary", timeline.length
    ? `待回填 ${summary.pending} · 样本不足 ${summary.insufficient} · 达标 ${summary.targetMet} · 需复核 ${summary.needsReview} · 口径提醒 ${summary.qualityWarnings} · 已回填消耗 ¥${formatMoney(summary.totalSpend)}`
    : "尚无测试版本；生成下一版任务后会自动建立实验台账。");
  $("#version-filter").disabled = !timeline.length;
  $("#export-experiment-csv").disabled = !timeline.length;
  $("#export-experiment-json").disabled = !timeline.length;
  const parentSelect = $("#parent-version");
  const selectedParent = parentSelect.value;
  parentSelect.replaceChildren();
  const rootOption = element("option", "", "无（新测试起点）");
  rootOption.value = "";
  parentSelect.append(rootOption);
  for (const entry of timeline) {
    const option = element("option", "", `${entry.version.testId} · ${entry.evaluation.label}`);
    option.value = entry.version.testId;
    parentSelect.append(option);
  }
  parentSelect.value = timeline.some((entry) => entry.version.testId === selectedParent) ? selectedParent : "";
  parentSelect.disabled = !state.projectRepository || !state.currentProject;

  const container = $("#version-timeline");
  container.replaceChildren();
  if (!timeline.length) {
    container.append(element("p", "empty-inline", "生成下一版任务后，这里会保留测试编号、父版本与结果状态。"));
  } else if (!filteredTimeline.length) {
    container.append(element("p", "empty-inline", "当前筛选条件下没有测试版本。"));
  } else {
    for (const entry of filteredTimeline.slice(0, 100)) {
      const card = element("article", "version-item");
      const head = element("div", "version-item-head");
      const title = element("span");
      title.append(element("strong", "", entry.version.testId), element("small", "", entry.version.parentVersionId ? `父版本 ${entry.version.parentVersionId}` : "新测试起点"));
      const badge = element("b", "version-result-badge", entry.evaluation.label);
      badge.dataset.resultState = entry.evaluation.code;
      head.append(title, badge);
      card.append(
        head,
        element("p", "", `${entry.version.primaryVariable} · 基线 ${entry.version.baselineCreative || "未填写"}`),
        element("p", "", metricText(entry.result)),
        ...(entry.result?.qualityWarnings?.length ? [element("small", "version-quality-warning", `需核对：${entry.result.qualityWarnings.map(experimentQualityWarningLabel).join("；")}`)] : []),
        element("small", "", entry.evaluation.detail)
      );
      container.append(card);
    }
  }
  $("#experiment-result-file-trigger").classList.toggle("disabled", !timeline.length);
  $("#experiment-result-file").disabled = !timeline.length;
  renderProjectHub();
}

function renderResultImportPreview() {
  const preview = $("#experiment-result-preview");
  const value = state.pendingResultImport;
  preview.hidden = !value;
  if (!value) {
    $("#confirm-result-import").disabled = true;
    return;
  }
  setNodeText("#result-preview-summary", `可匹配 ${value.matched.length} / ${value.totalRows} 行${value.warnings.length ? ` · ${value.warnings.length} 条口径提醒` : ""}`);
  const detail = [];
  if (value.unmatched.length) detail.push(`未匹配编号：${value.unmatched.slice(0, 5).map((entry) => entry.testId).join("、")}${value.unmatched.length > 5 ? ` 等 ${value.unmatched.length} 条` : ""}。未匹配行不会写入。`);
  if (value.warnings.length) detail.push(`${value.warnings.slice(0, 2).map((entry) => entry.message).join("；")}${value.warnings.length > 2 ? `；另有 ${value.warnings.length - 2} 条` : ""}。这些行可继续写入，但必须人工核对口径。`);
  if (!detail.length) detail.push("全部测试编号均属于当前项目；确认后写入本地版本记录。");
  setNodeText("#result-preview-detail", detail.join(" "));
  $("#confirm-result-import").disabled = value.matched.length === 0;
}

$("#version-filter").addEventListener("change", renderExperimentLoop);

function currentExperimentLedgerSnapshot() {
  if (!state.currentProject || !state.versions.length) throw new Error("当前项目还没有可导出的测试版本");
  return buildExperimentLedgerSnapshot({
    project: state.currentProject,
    versions: state.versions,
    results: state.experimentResults,
    targetRoi: Number($("#target-roi").value || 1.5)
  });
}

function experimentLedgerFileName(extension) {
  return `qianchuan-experiment-ledger-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

$("#export-experiment-csv").addEventListener("click", () => {
  try {
    download(experimentLedgerFileName("csv"), experimentLedgerToCsv(currentExperimentLedgerSnapshot()), "text/csv;charset=utf-8");
    setFeedback("#experiment-result-status", "#experiment-result-error", { status: "当前项目完整实验台账已导出为 CSV；筛选只影响页面显示，不会漏掉其他版本。" });
  } catch (error) {
    setFeedback("#experiment-result-status", "#experiment-result-error", { error: error.message || "实验台账无法导出" });
  }
});

$("#export-experiment-json").addEventListener("click", () => {
  try {
    download(experimentLedgerFileName("json"), JSON.stringify(currentExperimentLedgerSnapshot(), null, 2), "application/json;charset=utf-8");
    setFeedback("#experiment-result-status", "#experiment-result-error", { status: "当前项目完整实验台账已导出为 JSON；不包含原始报表或素材文件。" });
  } catch (error) {
    setFeedback("#experiment-result-status", "#experiment-result-error", { error: error.message || "实验台账无法导出" });
  }
});

async function refreshExperimentLoop({ syncPlan = false, parentVersionId } = {}) {
  if (!state.projectRepository || !state.currentProject) {
    state.versions = [];
    state.experimentResults = [];
    renderExperimentLoop();
    return;
  }
  if (syncPlan && state.plan?.items?.length) {
    await state.projectRepository.syncPlan(state.currentProject.id, state.plan, parentVersionId);
  }
  [state.versions, state.experimentResults] = await Promise.all([
    state.projectRepository.listVersions(state.currentProject.id),
    state.projectRepository.listResults(state.currentProject.id)
  ]);
  renderExperimentLoop();
}

async function persistCurrentProject({ syncPlan = false, parentVersionId, quiet = false } = {}) {
  if (!state.projectRepository || !state.currentProject || state.projectSwitching) return false;
  try {
    const saved = await state.projectRepository.saveWorkspace(state.currentProject.id, currentProjectWorkspace());
    state.currentProject = saved;
    state.projects = [saved, ...state.projects.filter((project) => project.id !== saved.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (syncPlan && state.plan?.items?.length) await refreshExperimentLoop({ syncPlan: true, parentVersionId });
    else renderProjectHub();
    if (!quiet) setProjectFeedback({ status: "当前项目已保存到本地项目集合。" });
    return true;
  } catch (error) {
    setProjectFeedback({ error: `项目集合未能同步：${error.message || "IndexedDB 不可用"}。当前工作区仍保留在浏览器本地。` });
    return false;
  }
}

function hasTransientProjectWork() {
  return Boolean(
    (state.document && state.reviewPending)
    || state.matchOperation.running
    || state.imageRepair.file
    || state.transcodeFiles.length
  );
}

async function prepareProjectTransition() {
  if (hasTransientProjectWork() && !window.confirm("切换项目会刷新侧边栏。未完成的报表标签编辑、素材匹配、图片修复或转码队列只存在于当前页面，会被清空；已完成复盘、创作任务和方案会保留。是否继续？")) return false;
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer);
    taskSaveTimer = null;
    await saveCreativeTask({ quiet: true });
  }
  if (planSaveTimer) {
    clearTimeout(planSaveTimer);
    planSaveTimer = null;
    await savePlanNow();
  }
  await persistCurrentProject({ quiet: true });
  return true;
}

async function initializeProjectLayer(stored) {
  try {
    const database = await openProjectDatabase();
    state.projectRepository = createProjectRepository(database);
    const recovered = recoverStoredWorkspace(stored).data;
    const context = await state.projectRepository.initialize(sanitizeProjectWorkspace(recovered));
    state.currentProject = context.current;
    state.projects = context.projects;
    if (context.pendingWorkspace) {
      const write = projectWorkspaceStorageWrite(context.pendingWorkspace);
      await chrome.storage.local.set(write);
      await chrome.storage.local.remove("productBrief");
      stored = { ...stored, ...write };
      delete stored.productBrief;
    }
    renderProjectHub();
  } catch (error) {
    state.projectRepository = null;
    state.currentProject = null;
    state.projects = [];
    setProjectFeedback({ error: `多项目功能已安全降级：${error.message || "IndexedDB 不可用"}。当前单项目工作区仍可继续使用。` });
    renderProjectHub();
  }
  return stored;
}

$("#project-select").addEventListener("change", async (event) => {
  const select = event.currentTarget;
  const targetId = select.value;
  if (!targetId || targetId === state.currentProject?.id) return;
  select.disabled = true;
  if (!await prepareProjectTransition()) {
    select.value = state.currentProject?.id || "";
    renderProjectHub();
    return;
  }
  try {
    state.projectSwitching = true;
    await state.projectRepository.requestSwitch(targetId);
    window.location.reload();
  } catch (error) {
    state.projectSwitching = false;
    select.value = state.currentProject?.id || "";
    setProjectFeedback({ error: `无法切换项目：${error.message || "本地项目不可用"}` });
    renderProjectHub();
  }
});

$("#new-project").addEventListener("click", async () => {
  const name = window.prompt("新项目名称", `新项目 ${state.projects.length + 1}`);
  if (name === null || !String(name).trim()) return;
  if (!await prepareProjectTransition()) return;
  try {
    state.projectSwitching = true;
    await state.projectRepository.createProject(name);
    window.location.reload();
  } catch (error) {
    state.projectSwitching = false;
    setProjectFeedback({ error: `无法创建项目：${error.message || "本地项目不可用"}` });
    renderProjectHub();
  }
});

$("#rename-project").addEventListener("click", async () => {
  if (!state.currentProject) return;
  const name = window.prompt("修改项目名称", state.currentProject.name);
  if (name === null || !String(name).trim()) return;
  try {
    const renamed = await state.projectRepository.renameProject(state.currentProject.id, name);
    state.currentProject = renamed;
    state.projects = state.projects.map((project) => project.id === renamed.id ? renamed : project);
    renderProjectHub();
    setProjectFeedback({ status: "项目名称已更新。" });
  } catch (error) {
    setProjectFeedback({ error: `无法重命名项目：${error.message || "本地项目不可用"}` });
  }
});

$("#experiment-result-file").addEventListener("change", async (event) => {
  const file = event.target.files[0] || null;
  event.target.value = "";
  state.pendingResultImport = null;
  renderResultImportPreview();
  if (!file) return;
  try {
    validateNonMediaImport(file, "experimentResult");
    state.pendingResultImport = parseExperimentResults(await file.text(), state.versions.map((version) => version.testId));
    renderResultImportPreview();
    setFeedback("#experiment-result-status", "#experiment-result-error", { status: state.pendingResultImport.notice });
  } catch (error) {
    setFeedback("#experiment-result-status", "#experiment-result-error", { error: error.message || "测试结果无法读取" });
  }
});

$("#cancel-result-import").addEventListener("click", () => {
  state.pendingResultImport = null;
  renderResultImportPreview();
  setFeedback("#experiment-result-status", "#experiment-result-error", { status: "已取消结果回填；现有版本和结果保持不变。" });
});

$("#confirm-result-import").addEventListener("click", async () => {
  const pending = state.pendingResultImport;
  if (!pending?.matched?.length || !state.projectRepository || !state.currentProject) return;
  const partial = pending.unmatched.length ? `\n\n另有 ${pending.unmatched.length} 行测试编号不属于当前项目，将跳过。` : "";
  const warnings = pending.warnings.length ? `\n\n发现 ${pending.warnings.length} 条指标口径提醒；继续表示你已人工核对并接受这些口径差异。` : "";
  if (!window.confirm(`将把 ${pending.matched.length} 行结果写入当前项目；相同测试编号的旧结果会被替换。${partial}${warnings}\n\n是否继续？`)) return;
  try {
    await state.projectRepository.importResults(state.currentProject.id, pending.matched);
    state.pendingResultImport = null;
    renderResultImportPreview();
    await refreshExperimentLoop();
    setFeedback("#experiment-result-status", "#experiment-result-error", { status: pending.warnings.length
      ? `结果已回填；请继续人工复核 ${pending.warnings.length} 条指标口径提醒。版本状态不会被解释为因果结论。`
      : "结果已回填；版本状态已按最低消耗、目标 ROI 和父版本对照重新计算。" });
  } catch (error) {
    setFeedback("#experiment-result-status", "#experiment-result-error", { error: error.message || "测试结果未能写入" });
  }
});

function planFingerprint(plan) {
  const source = JSON.stringify(sanitizedCreativePlan(plan));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function clearPlanExportReceipt() {
  state.planExported = false;
  state.planExportReceipt = null;
  void chrome.storage.local.remove("planExportReceipt").catch(() => {});
}

async function markPlanCompleted() {
  if (!state.plan || state.planStale) return;
  state.planExported = true;
  state.planExportReceipt = { fingerprint: planFingerprint(state.plan), completedAt: new Date().toISOString() };
  try {
    await chrome.storage.local.set({ planExportReceipt: state.planExportReceipt });
  } catch {
    // 当前会话仍可显示完成；持久化失败不会把已成功的复制或导出误报为失败。
  }
  await persistCurrentProject({ quiet: true });
}

function setPlanExportControls(disabled, reason = "") {
  for (const id of ["copy-plan", "export-plan-md", "export-plan-csv", "export-plan-json"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = disabled;
    button.title = disabled ? reason : "";
  }
}

function updatePlanEmptyState() {
  const empty = $("#plan-empty-state");
  if (!state.plan?.items?.length) {
    empty.hidden = false;
    empty.querySelector("strong").textContent = "还没有下一版任务";
    empty.querySelector("p").textContent = "完成历史素材复盘后即可生成；上方创作任务只用于补充上下文，不是必填项。";
  } else if (state.planStale) {
    empty.hidden = false;
    empty.querySelector("strong").textContent = "当前方案需要重新生成";
    empty.querySelector("p").textContent = "复盘数据、创作任务或测试参数已经变化。旧方案仍保留供对照，但请重新生成后再导出。";
  } else {
    empty.hidden = true;
  }
}

function markPlanStale(reason) {
  if (!state.plan?.items?.length) return;
  state.planStale = true;
  clearPlanExportReceipt();
  setStatus("#plan-state", "需重新生成");
  $("#copy-state").textContent = reason || "上下文已变化，请重新生成后再导出。";
  setPlanExportControls(true, "上下文已变化，请先重新生成下一版任务");
  updatePlanEmptyState();
  updateWorkflowGuide();
}

function planMatchesCurrentContext(plan, task, analysis) {
  if (!plan?.items?.length || !analysis?.summary || !plan.dependencyFingerprint) return false;
  const expected = creativePlanDependencyFingerprint(task, analysis, {
    testVariable: plan.testVariable,
    minSpend: plan.items[0]?.minSpend
  });
  return plan.dependencyFingerprint === expected;
}

function focusWorkflowTarget(viewId, elementId) {
  switchView(viewId, { focusHeading: !elementId, scrollTop: false });
  if (elementId) {
    const requested = document.getElementById(elementId);
    const describedBy = requested?.disabled ? requested.getAttribute("aria-describedby")?.split(/\s+/)[0] : "";
    const target = describedBy ? document.getElementById(describedBy) : requested;
    focusAndReveal(target);
  }
}

function renderRecentTask() {
  const model = buildRecentWorkModel({
    hasCreativeTask: creativeTaskHasContent(state.creativeTask),
    hasAnalysis: Boolean(state.analysis?.topCreatives?.length),
    analysisCount: state.analysis?.summary?.creativeCount,
    reviewPending: state.reviewPending,
    planCount: state.plan?.items?.length,
    planStale: state.planStale,
    planExported: state.planExported
  });
  const card = $("#recent-task");
  card.dataset.state = model.kind;
  setNodeText("#recent-task-title", model.title);
  setNodeText("#recent-task-description", model.description);
  const action = $("#continue-recent-task");
  action.textContent = model.action;
  action.dataset.targetView = model.targetView;
  action.dataset.focusId = model.focusId;
  action.disabled = false;
}

function updateWorkflowGuide() {
  const reviewed = Boolean(state.analysis?.topCreatives?.length) && !state.reviewPending;
  const planned = Boolean(state.plan?.items?.length) && !state.planStale;
  const exported = planned && state.planExported;
  const completed = [reviewed, planned, exported].filter(Boolean).length;
  const progress = $("#workflow-progress");
  setNodeText("#workflow-progress-label", `核心流程 ${completed} / 3`);
  setNodeText("#workflow-task-state", creativeTaskHasContent() ? "创作任务已补充" : "创作任务可跳过");
  $("#workflow-progress-bar").style.width = `${(completed / 3) * 100}%`;
  progress.setAttribute("aria-valuenow", String(completed));
  const action = $("#workflow-next-action");
  if (!reviewed) {
    setNodeText("#workflow-next-step", state.reviewPending ? "下一步：完成当前报表复盘，才能用于下一版任务。" : "下一步：导入历史素材并完成复盘。");
    action.textContent = state.reviewPending ? "继续完成复盘" : "去导入历史素材";
    action.dataset.targetView = "review";
    action.dataset.focusId = state.reviewPending ? "analyze-button" : "report-file-trigger";
  } else if (!planned) {
    setNodeText("#workflow-next-step", "下一步：选择一个测试变量，生成下一版任务。");
    action.textContent = "去生成下一版任务";
    action.dataset.targetView = "next";
    action.dataset.focusId = "generate-plan";
  } else if (!exported) {
    setNodeText("#workflow-next-step", "下一步：检查生成内容，并复制或导出生产资料。");
    action.textContent = "查看并导出任务";
    action.dataset.targetView = "next";
    action.dataset.focusId = "copy-plan";
  } else {
    setNodeText("#workflow-next-step", "本轮已完成。上线后可导入新结果，开始下一轮复盘。");
    action.textContent = "开始下一轮复盘";
    action.dataset.targetView = "review";
    action.dataset.focusId = "report-file-trigger";
  }
  renderRecentTask();
}

$("#workflow-next-action").addEventListener("click", (event) => {
  const button = event.currentTarget;
  focusWorkflowTarget(button.dataset.targetView, button.dataset.focusId);
});

$("#continue-recent-task").addEventListener("click", (event) => {
  const button = event.currentTarget;
  focusWorkflowTarget(button.dataset.targetView, button.dataset.focusId);
});

$("#retry-workspace-load").addEventListener("click", () => window.location.reload());

$("#clear-corrupt-storage").addEventListener("click", async () => {
  const keys = [...state.recoveryInvalidKeys];
  if (!keys.length) return;
  const confirmed = window.confirm(`将只清理以下损坏的浏览器本地记录：\n\n${keys.join("、")}\n\n正常工作区记录和本地文件不会被删除。是否继续？`);
  if (!confirmed) return;
  try {
    await chrome.storage.local.remove(keys);
    window.location.reload();
  } catch (error) {
    showRecoveryIssues([{ key: "", message: `损坏记录清理失败：${error.message || "本地存储不可用"}` }]);
  }
});

$("#onboarding-start").addEventListener("click", () => void dismissOnboarding({ moveToReview: true }));
$("#dismiss-onboarding").addEventListener("click", () => void dismissOnboarding());
$("#reopen-onboarding").addEventListener("click", (event) => showOnboarding({ focus: true, returnFocus: event.currentTarget }));

function readCreativeTaskForm() {
  return Object.fromEntries(new FormData($("#creative-task-form")).entries());
}

function fillCreativeTaskForm(task = {}) {
  for (const [key, value] of Object.entries(task)) {
    const field = $(`#creative-task-form [name="${key}"]`);
    if (field) field.value = value ?? "";
  }
}

const HANDOFF_FIELD_LABELS = Object.freeze({
  targetAudience: "目标受众",
  audienceProblems: "受众问题",
  coreClaim: "核心主张",
  evidence: "可用证据"
});

const HANDOFF_REVISION_FIELD_LABELS = Object.freeze({
  problemSummary: "问题摘要",
  testHypothesis: "测试假设",
  fixedElements: "保持不变项",
  hook: "前三秒钩子",
  spokenScript: "口播稿",
  storyboard: "分镜",
  supplementalShots: "补拍镜头",
  subtitleHighlights: "字幕重点",
  editingRhythm: "剪辑节奏",
  successMetrics: "成功指标",
  stopCondition: "停止条件"
});

function updateAnalysisHandoffApplyState() {
  const selected = [...document.querySelectorAll("#analysis-handoff-suggestions input[data-handoff-field]:checked:not(:disabled)")];
  $("#apply-analysis-handoff").disabled = selected.length === 0;
}

function renderAnalysisHandoffInboxNotice() {
  const envelope = state.pendingAnalysisHandoffEnvelope;
  const panel = $("#analysis-handoff-inbox");
  if (!envelope) {
    panel.hidden = true;
    return;
  }
  const viewing = state.analysisHandoffSource === "session" && state.analysisHandoff?.handoffId === envelope.handoff.handoffId;
  const blockedByOtherPreview = Boolean(state.analysisHandoff) && !viewing;
  const revisionDraft = envelope.handoff.revisionDraft || null;
  setNodeText("#analysis-handoff-inbox-title", blockedByOtherPreview ? "另有待确认结果" : revisionDraft ? "工作台可拍草稿已收到" : "工作台分析已收到");
  setNodeText("#analysis-handoff-inbox-meta", revisionDraft
    ? `${revisionDraft.testId} · 当前会话`
    : `覆盖 ${envelope.handoff.summary.coveredStructures}/${envelope.handoff.summary.totalStructures} · 当前会话`);
  setNodeText("#analysis-handoff-inbox-description", blockedByOtherPreview
    ? "当前预览保持不变；需要时请主动切换到工作台刚发送的结果。"
    : revisionDraft
      ? "可拍任务将以只读方式显示；尚未修改任何任务字段或创作方案。"
      : "只显示受限建议，尚未修改任何创作任务字段。");
  const showButton = $("#show-analysis-handoff-inbox");
  showButton.disabled = viewing;
  showButton.textContent = viewing ? "正在预览" : "切换到此结果";
  panel.hidden = false;
}

function renderAnalysisHandoffRevision(revisionDraft) {
  const panel = $("#analysis-handoff-revision");
  if (!revisionDraft) {
    panel.hidden = true;
    $("#analysis-handoff-revision-evidence").replaceChildren();
    $("#analysis-handoff-revision-fields").replaceChildren();
    setNodeText("#analysis-handoff-revision-id", "—");
    setNodeText("#analysis-handoff-revision-parent", "—");
    setNodeText("#analysis-handoff-revision-source", "—");
    setNodeText("#analysis-handoff-revision-variable", "单变量");
    setNodeText("#analysis-handoff-revision-notice", "");
    return;
  }
  setNodeText("#analysis-handoff-revision-id", revisionDraft.testId);
  setNodeText("#analysis-handoff-revision-parent", revisionDraft.parentVersionId || "无（首版）");
  setNodeText("#analysis-handoff-revision-source", revisionDraft.sourceAnalysisId);
  setNodeText("#analysis-handoff-revision-variable", `唯一变量 · ${revisionDraft.primaryVariable.label}`);
  setNodeText("#analysis-handoff-revision-notice", `${revisionDraft.notice} 此处仅预览，不会写入或覆盖创作方案。`);
  const evidence = $("#analysis-handoff-revision-evidence");
  evidence.replaceChildren();
  for (const item of revisionDraft.evidence) {
    const card = element("article");
    card.append(element("strong", "", item.sourceLabel), element("p", "", item.excerpt));
    evidence.append(card);
  }
  const fields = $("#analysis-handoff-revision-fields");
  fields.replaceChildren();
  for (const field of CREATIVE_REVISION_EDITABLE_FIELDS) {
    const card = element("article");
    card.append(element("strong", "", HANDOFF_REVISION_FIELD_LABELS[field]), element("p", "", revisionDraft[field]));
    fields.append(card);
  }
  panel.hidden = false;
}

function renderAnalysisHandoffPreview(handoff, { source = "file" } = {}) {
  const candidates = analysisHandoffFillCandidates(handoff, readCreativeTaskForm());
  state.analysisHandoff = handoff;
  state.analysisHandoffSource = source;
  setNodeText("#analysis-handoff-summary", handoff.revisionDraft
    ? `V2 可拍草稿 · ${handoff.revisionDraft.testId}`
    : `确定性规则 · 覆盖 ${handoff.summary.coveredStructures}/${handoff.summary.totalStructures}`);
  const container = $("#analysis-handoff-suggestions");
  container.replaceChildren();
  for (const candidate of candidates) {
    const occupied = Boolean(String(readCreativeTaskForm()[candidate.field] ?? "").trim());
    const row = element("label", `handoff-suggestion${candidate.canFill ? "" : " blocked"}`);
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.dataset.handoffField = candidate.field;
    checkbox.checked = candidate.canFill;
    checkbox.disabled = !candidate.canFill;
    checkbox.addEventListener("change", updateAnalysisHandoffApplyState);
    const copy = element("span", "handoff-suggestion-copy");
    copy.append(
      element("strong", "", HANDOFF_FIELD_LABELS[candidate.field]),
      element("small", "", !candidate.value ? "分析未形成此项建议" : occupied ? "当前字段已有内容，将跳过" : "可填入空白字段"),
      element("p", "", candidate.value || "—")
    );
    row.append(checkbox, copy);
    container.append(row);
  }
  renderAnalysisHandoffRevision(handoff.revisionDraft || null);
  $("#analysis-handoff-preview").hidden = false;
  updateAnalysisHandoffApplyState();
  renderAnalysisHandoffInboxNotice();
}

function clearAnalysisHandoffPreview() {
  state.analysisHandoff = null;
  state.analysisHandoffSource = "";
  $("#analysis-handoff-file").value = "";
  $("#analysis-handoff-preview").hidden = true;
  $("#analysis-handoff-suggestions").replaceChildren();
  renderAnalysisHandoffRevision(null);
  $("#apply-analysis-handoff").disabled = true;
  setNodeText("#analysis-handoff-summary", "");
  renderAnalysisHandoffInboxNotice();
}

function sessionStorageArea() {
  return chrome.storage?.session || null;
}

async function removeSessionAnalysisHandoff(expectedHandoffId = "") {
  const storage = sessionStorageArea();
  if (!storage || typeof storage.get !== "function" || typeof storage.remove !== "function") {
    throw new Error("浏览器会话存储不可用，无法清除待确认结果");
  }
  const stored = await storage.get(ANALYSIS_HANDOFF_INBOX_KEY);
  const inspected = inspectAnalysisHandoffInbox(stored?.[ANALYSIS_HANDOFF_INBOX_KEY]);
  if (inspected.status === "empty") return true;
  if (inspected.status === "ready" && expectedHandoffId && inspected.envelope.handoff.handoffId !== expectedHandoffId) return false;
  await storage.remove(ANALYSIS_HANDOFF_INBOX_KEY);
  return true;
}

function showPendingAnalysisHandoff() {
  const envelope = state.pendingAnalysisHandoffEnvelope;
  if (!envelope) return false;
  renderAnalysisHandoffPreview(envelope.handoff, { source: "session" });
  switchView("task", { scrollTop: false });
  focusAndReveal($("#analysis-handoff-preview"), { block: "center" });
  return true;
}

async function handleSessionAnalysisHandoff(raw, { announce = true } = {}) {
  const inspected = inspectAnalysisHandoffInbox(raw);
  if (inspected.status === "empty") {
    state.pendingAnalysisHandoffEnvelope = null;
    if (state.analysisHandoffSource === "session") clearAnalysisHandoffPreview();
    renderAnalysisHandoffInboxNotice();
    return;
  }
  if (["invalid", "expired"].includes(inspected.status)) {
    state.pendingAnalysisHandoffEnvelope = null;
    if (state.analysisHandoffSource === "session") clearAnalysisHandoffPreview();
    try {
      const storage = sessionStorageArea();
      if (!storage || typeof storage.remove !== "function") throw new Error("会话存储不可用");
      await storage.remove(ANALYSIS_HANDOFF_INBOX_KEY);
      setFeedback("#analysis-handoff-message", "#analysis-handoff-error", inspected.status === "expired"
        ? { status: "工作台会话交接已过期并清理，请在工作台重新发送。" }
        : { error: `损坏的工作台会话交接已清理：${inspected.error?.message || "格式无效"}` });
    } catch {
      setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: "工作台会话交接无效，且浏览器未能清理；可继续使用 JSON 交接包。" });
    }
    renderAnalysisHandoffInboxNotice();
    return;
  }
  const envelope = inspected.envelope;
  if (isDuplicateAnalysisHandoff(envelope.handoff, state.appliedAnalysisHandoffIds)) {
    await removeSessionAnalysisHandoff(envelope.handoff.handoffId);
    if (announce) setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: "重复的已应用会话交接已清理。" });
    return;
  }
  state.pendingAnalysisHandoffEnvelope = envelope;
  const previewDecision = decideAnalysisHandoffPreview(state.analysisHandoff, envelope);
  if (previewDecision === "show") {
    renderAnalysisHandoffPreview(envelope.handoff, { source: "session" });
    if (announce) setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: "工作台分析已收到并生成预览；尚未修改任何创作任务字段。" });
  } else if (previewDecision === "pending") {
    if (announce) setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: "另有一份工作台分析待确认；当前预览未被覆盖。" });
  }
  renderAnalysisHandoffInboxNotice();
}

async function loadSessionAnalysisHandoff() {
  const storage = sessionStorageArea();
  if (!storage || typeof storage.get !== "function") {
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: "当前浏览器不支持会话交接，请使用 JSON 交接包。" });
    return;
  }
  try {
    const stored = await storage.get(ANALYSIS_HANDOFF_INBOX_KEY);
    await handleSessionAnalysisHandoff(stored?.[ANALYSIS_HANDOFF_INBOX_KEY], { announce: true });
  } catch (error) {
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: `无法读取工作台会话交接：${error.message || "会话存储不可用"}；可继续使用 JSON 交接包。` });
  }
}

$("#analysis-handoff-file").addEventListener("change", async (event) => {
  const file = event.target.files[0] ?? null;
  event.target.value = "";
  if (!file) return;
  setFeedback("#analysis-handoff-message", "#analysis-handoff-error");
  try {
    validateAnalysisHandoffFile({ name: file.name, size: file.size, type: file.type });
    const handoff = validateAnalysisHandoff(parseJsonDocument(await file.text(), "分析交接包"));
    if (isDuplicateAnalysisHandoff(handoff, state.appliedAnalysisHandoffIds)) {
      throw new Error("这个交接包已在本次浏览器会话中成功应用；为避免重复填入，请导出新的分析结果");
    }
    renderAnalysisHandoffPreview(handoff, { source: "file" });
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", {
      status: "交接包已在本地校验并生成预览；尚未修改任何创作任务字段。"
    });
  } catch (error) {
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: error.message || "无法导入分析交接包" });
  }
});

$("#analysis-handoff-suggestions").addEventListener("change", updateAnalysisHandoffApplyState);

$("#show-analysis-handoff-inbox").addEventListener("click", () => {
  if (!showPendingAnalysisHandoff()) return;
  setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: "已切换到工作台会话结果；尚未修改任何创作任务字段。" });
});

$("#discard-analysis-handoff-inbox").addEventListener("click", async () => {
  const envelope = state.pendingAnalysisHandoffEnvelope;
  if (!envelope) return;
  if (!window.confirm("将清除当前浏览器会话中的待确认工作台结果，不会修改创作任务。是否继续？")) return;
  try {
    const removed = await removeSessionAnalysisHandoff(envelope.handoff.handoffId);
    if (!removed) throw new Error("收件箱已出现另一份结果，未执行清除");
    if (state.analysisHandoffSource === "session" && state.analysisHandoff?.handoffId === envelope.handoff.handoffId) clearAnalysisHandoffPreview();
    state.pendingAnalysisHandoffEnvelope = null;
    renderAnalysisHandoffInboxNotice();
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: "会话交接结果已清除；创作任务保持不变。" });
  } catch (error) {
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: error.message || "无法清除会话交接结果" });
  }
});

$("#apply-analysis-handoff").addEventListener("click", async () => {
  if (!state.analysisHandoff) return;
  const selected = [...document.querySelectorAll("#analysis-handoff-suggestions input[data-handoff-field]:checked:not(:disabled)")];
  if (!selected.length) {
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: "请至少选择一个仍为空白的建议字段" });
    return;
  }
  const candidates = new Map(analysisHandoffFillCandidates(state.analysisHandoff, readCreativeTaskForm()).map((item) => [item.field, item]));
  let filled = 0;
  let skipped = 0;
  for (const checkbox of selected) {
    const candidate = candidates.get(checkbox.dataset.handoffField);
    const field = $("#creative-task-form").elements.namedItem(checkbox.dataset.handoffField);
    if (!candidate?.canFill || !field || String(field.value).trim()) {
      skipped += 1;
      continue;
    }
    field.value = candidate.value;
    filled += 1;
  }
  if (!filled) {
    renderAnalysisHandoffPreview(state.analysisHandoff, { source: state.analysisHandoffSource || "file" });
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: "所选字段当前均已有内容，未进行覆盖" });
    return;
  }
  const saved = await saveCreativeTask({ quiet: true });
  if (!saved) {
    renderAnalysisHandoffPreview(state.analysisHandoff, { source: state.analysisHandoffSource || "file" });
    setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: "建议仅保留在当前表单，会话交接尚未消费；请恢复浏览器存储后编辑任一任务字段触发保存，确认保存成功后再清除交接。" });
    return;
  }
  const applied = state.analysisHandoff;
  const appliedSource = state.analysisHandoffSource;
  state.appliedAnalysisHandoffIds.add(applied.handoffId);
  const pendingMatches = state.pendingAnalysisHandoffEnvelope?.handoff.handoffId === applied.handoffId;
  if (appliedSource === "session" || pendingMatches) {
    try {
      const removed = await removeSessionAnalysisHandoff(applied.handoffId);
      if (!removed) throw new Error("收件箱已出现另一份结果，未清除新结果");
      state.pendingAnalysisHandoffEnvelope = null;
      clearAnalysisHandoffPreview();
      setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: `已确认填入 ${filled} 个空白字段${skipped ? `，跳过 ${skipped} 个已有内容的字段` : ""}；会话交接已消费，请继续人工核对。` });
    } catch (error) {
      renderAnalysisHandoffPreview(applied, { source: appliedSource || "file" });
      setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: `建议已保存，但会话收件箱清理失败：${error.message || "会话存储不可用"}` });
    }
    return;
  }
  renderAnalysisHandoffPreview(applied, { source: appliedSource || "file" });
  setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: `已确认填入 ${filled} 个空白字段${skipped ? `，跳过 ${skipped} 个已有内容的字段` : ""}；请继续人工核对。` });
});

$("#clear-analysis-handoff").addEventListener("click", async () => {
  const handoff = state.analysisHandoff;
  const source = state.analysisHandoffSource;
  if (source === "session" && handoff) {
    try {
      const removed = await removeSessionAnalysisHandoff(handoff.handoffId);
      if (!removed) throw new Error("收件箱已出现另一份结果，未执行清除");
      state.pendingAnalysisHandoffEnvelope = null;
    } catch (error) {
      setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: error.message || "无法清除会话交接结果" });
      return;
    }
  }
  clearAnalysisHandoffPreview();
  const revealedPending = source === "file" && state.pendingAnalysisHandoffEnvelope && showPendingAnalysisHandoff();
  setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { status: source === "session"
    ? "会话交接预览及收件箱记录已清除；创作任务保持不变。"
    : revealedPending
    ? "JSON 交接包预览已清除，现已切换到工作台会话结果；创作任务保持不变。"
    : "JSON 交接包预览已清除；已确认填入的任务内容保持不变。" });
});

function taskSuggestions() {
  const task = readCreativeTaskForm();
  const useful = { targetAudience: "目标受众", creativeGoal: "创作目标", coreClaim: "核心主张", evidence: "可用证据" };
  return Object.entries(useful).filter(([key]) => !String(task[key] ?? "").trim()).map(([, label]) => label);
}

function markReviewPending(reason = "当前数据已变化，请重新完成复盘。") {
  state.reviewPending = true;
  setStatus("#report-state", "需重新复盘");
  const staleNotice = $("#review-stale-notice");
  if (state.analysis) {
    $("#results").hidden = false;
    staleNotice.hidden = false;
    staleNotice.textContent = `以下为上一次复盘结果。${reason}`;
  }
}

async function saveCreativeTask({ quiet = false } = {}) {
  try {
    const previous = normalizeCreativeTask(state.creativeTask);
    const migration = state.creativeTask?._migration;
    state.creativeTask = { ...readCreativeTaskForm(), ...(migration ? { _migration: migration } : {}) };
    if (JSON.stringify(previous) !== JSON.stringify(normalizeCreativeTask(state.creativeTask))) {
      markPlanStale("创作任务已变化，请重新生成后再导出。");
    }
    await chrome.storage.local.set({ creativeTask: state.creativeTask });
    await persistCurrentProject({ quiet: true });
    const suggestions = taskSuggestions();
    setStatus("#task-save-state", suggestions.length ? "草稿已保存" : "已保存", true);
    $("#task-error").textContent = "";
    $("#task-save-hint").textContent = suggestions.length ? `草稿已保存；还可补充 ${suggestions.join("、")}，也可直接继续。` : "创作任务已保存，可以继续历史素材复盘。";
    updateReadiness();
    updateLibraryCounts();
    updateWorkflowGuide();
    return true;
  } catch (error) {
    setStatus("#task-save-state", "保存失败");
    $("#task-error").textContent = `无法保存创作任务：${error.message || "本地存储不可用"}`;
    return false;
  }
}

$("#creative-task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveCreativeTask();
});

$("#creative-task-form").addEventListener("input", () => {
  setStatus("#task-save-state", "保存中…");
  $("#task-save-hint").textContent = "创作任务为可选内容；正在保存当前草稿。";
  markPlanStale("创作任务已变化，请重新生成后再导出。");
  updateWorkflowGuide();
  clearTimeout(taskSaveTimer);
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null;
    void saveCreativeTask({ quiet: true });
  }, 500);
});

$("#task-template").addEventListener("change", async (event) => {
  const template = CREATIVE_TASK_TEMPLATES[event.target.value];
  if (!template) return;
  const form = $("#creative-task-form");
  for (const [key, value] of Object.entries(template)) {
    if (key === "label") continue;
    const field = form.elements.namedItem(key);
    if (field && !String(field.value).trim()) field.value = value;
  }
  await saveCreativeTask({ quiet: true });
});

function renderMapping() {
  const grid = $("#mapping-grid");
  grid.replaceChildren();
  for (const [key, definition] of Object.entries(FIELD_DEFINITIONS)) {
    const label = element("label", `mapping-field${definition.required ? " required" : ""}`);
    label.append(element("span", "", definition.label));
    const select = element("select");
    select.dataset.field = key;
    select.append(new Option("不映射", ""));
    for (const header of state.document.headers) select.append(new Option(header, header));
    select.value = state.mapping[key] ?? "";
    select.addEventListener("change", () => {
      if (select.value) state.mapping[key] = select.value;
      else delete state.mapping[key];
      if (TAG_FIELDS.includes(key)) {
        state.document.rows.forEach((row, index) => {
          state.tagValues[index][key] = select.value ? (row[select.value] ?? "") : "";
        });
        state.tagPage = 0;
      }
      initializeTags();
      renderTagEditor();
      markReviewPending("字段映射已变化，请重新完成复盘后再生成。");
      markPlanStale("字段映射已变化，请完成复盘并重新生成。");
      updateMappingState();
      updateReadiness();
      updateWorkflowGuide();
    });
    label.append(select);
    grid.append(label);
  }
  updateMappingState();
}

function updateMappingState() {
  if (!state.document) return;
  const { missingRequired, missingRecommended } = inspectColumnMapping(state.document.headers, state.mapping);
  const actuallyMissing = missingRequired.filter((key) => !state.mapping[key]);
  const missingOptional = missingRecommended.filter((key) => !state.mapping[key]);
  if (actuallyMissing.length) {
    $("#mapping-status").textContent = `缺少：${actuallyMissing.map((key) => FIELD_DEFINITIONS[key].label).join("、")}`;
    $("#mapping-status").className = "bad-text";
  } else if (missingOptional.length) {
    $("#mapping-status").textContent = `可分析 · ${missingOptional.length} 个指标未映射`;
    $("#mapping-status").className = "warn-text";
  } else {
    $("#mapping-status").textContent = "字段完整";
    $("#mapping-status").className = "good-text";
  }
  const analyzeButton = $("#analyze-button");
  const disabledReason = actuallyMissing.length ? `仍需映射：${actuallyMissing.map((key) => FIELD_DEFINITIONS[key].label).join("、")}` : "";
  analyzeButton.disabled = actuallyMissing.length > 0;
  analyzeButton.title = disabledReason;
  $("#analysis-button-help").textContent = disabledReason || "字段已满足最低要求。补齐标签后即可完成复盘。";
}

function renderPreview() {
  const container = $("#csv-preview");
  container.replaceChildren();
  const table = element("table", "preview-table");
  const caption = element("caption", "sr-only", `导入报表前 ${Math.min(5, state.document.rows.length)} 行预览`);
  const thead = element("thead");
  const headerRow = element("tr");
  state.document.headers.forEach((header) => {
    const cell = element("th", "", header);
    cell.scope = "col";
    headerRow.append(cell);
  });
  thead.append(headerRow);
  const tbody = element("tbody");
  state.document.rows.slice(0, 5).forEach((row) => {
    const tr = element("tr");
    state.document.headers.forEach((header) => tr.append(element("td", "", row[header] || "—")));
    tbody.append(tr);
  });
  table.append(caption, thead, tbody);
  container.append(table);
}

function initializeTags() {
  if (!state.document) return;
  state.tagValues = state.document.rows.map((row, index) => {
    const previous = state.tagValues[index] ?? {};
    return Object.fromEntries(TAG_FIELDS.map((field) => [field, previous[field] ?? (state.mapping[field] ? row[state.mapping[field]] : "") ?? ""]));
  });
}

function renderTagEditor() {
  const container = $("#tag-editor");
  container.replaceChildren();
  if (!state.document) return;
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(state.document.rows.length / pageSize));
  state.tagPage = Math.min(state.tagPage, pageCount - 1);
  const start = state.tagPage * pageSize;
  const end = Math.min(start + pageSize, state.document.rows.length);
  $("#tag-progress").textContent = `${state.document.rows.length} 条素材`;
  $("#tag-page").textContent = `${state.tagPage + 1} / ${pageCount}`;
  $("#tag-prev").disabled = state.tagPage === 0;
  $("#tag-next").disabled = state.tagPage >= pageCount - 1;
  for (let index = start; index < end; index += 1) {
    const row = state.document.rows[index];
    const name = state.mapping.creativeName ? row[state.mapping.creativeName] : `第 ${index + 1} 行`;
    const card = element("article", "tag-row");
    card.append(element("strong", "tag-name", name || `未命名素材 ${index + 1}`));
    const fields = element("div", "tag-grid");
    TAG_FIELDS.forEach((field) => {
      const label = element("label");
      label.append(element("span", "", FIELD_DEFINITIONS[field].label));
      const input = element("input");
      input.type = "text";
      input.value = state.tagValues[index]?.[field] ?? "";
      input.placeholder = "待补充";
      input.setAttribute("aria-label", `${name || `未命名素材 ${index + 1}`}：${FIELD_DEFINITIONS[field].label}`);
      input.addEventListener("input", () => {
        state.tagValues[index][field] = input.value;
        markReviewPending("素材标签已变化，请重新完成复盘后再生成。");
        markPlanStale("素材标签已变化，请完成复盘并重新生成。");
        updateReadiness();
        updateWorkflowGuide();
      });
      label.append(input);
      fields.append(label);
    });
    card.append(fields);
    container.append(card);
  }
}

$("#tag-prev").addEventListener("click", () => {
  if (state.tagPage > 0) state.tagPage -= 1;
  renderTagEditor();
  focusAndReveal($("#tag-editor input"));
});

$("#tag-next").addEventListener("click", () => {
  const pageCount = Math.ceil((state.document?.rows.length ?? 0) / 25);
  if (state.tagPage < pageCount - 1) state.tagPage += 1;
  renderTagEditor();
  focusAndReveal($("#tag-editor input"));
});

$("#report-file").addEventListener("change", async (event) => {
  const reportFile = event.target.files[0] ?? null;
  event.target.value = "";
  if (!reportFile) return;
  let nextDocument;
  let nextMapping;
  let nextTagValues;
  try {
    validateNonMediaImport(reportFile, "report");
    nextDocument = parseCsvDocument(await reportFile.text());
    nextMapping = inspectColumnMapping(nextDocument.headers).mapping;
    nextTagValues = nextDocument.rows.map((row) => Object.fromEntries(TAG_FIELDS.map((field) => [field, nextMapping[field] ? row[nextMapping[field]] ?? "" : ""])));
  } catch (error) {
    $("#analysis-error").textContent = `${error.message || "无法读取 CSV，请检查编码与格式"}；当前报表与上一次成功复盘均保持不变。`;
    setStatus("#report-state", "导入失败 · 保留当前数据", Boolean(state.analysis || state.document));
    updateReadiness();
    updateWorkflowGuide();
    return;
  }

  state.document = nextDocument;
  state.mapping = nextMapping;
  state.tagValues = nextTagValues;
  state.tagPage = 0;
  $("#review-restore-notice").hidden = true;
  $("#analysis-error").textContent = "";
  markReviewPending("已选择新的历史报表，请完成复盘后再生成。");
  clearPlanExportReceipt();
  $("#review-empty-state").hidden = true;
  markPlanStale("已选择新的历史报表，请完成复盘并重新生成。");
  initializeTags();
  $("#report-file-name").textContent = `${reportFile.name} · ${formatMoney(reportFile.size / 1024)} KB · ${state.document.rows.length} 行`;
  $("#import-workspace").hidden = false;
  renderMapping();
  renderPreview();
  renderTagEditor();
  setStatus("#report-state", "需重新复盘");
  updateReadiness();
  updateWorkflowGuide();
});

$("#dismiss-task-migration").addEventListener("click", () => {
  $("#task-migration-notice").hidden = true;
});

$("#target-roi").addEventListener("input", () => {
  if (state.versions.length) renderExperimentLoop();
  if (!state.document) return;
  markReviewPending("目标 ROI 已变化，请重新完成复盘后再生成。");
  markPlanStale("目标 ROI 已变化，请完成复盘并重新生成。");
  updateReadiness();
  updateWorkflowGuide();
});

function taggedRowsAndMapping() {
  const rows = state.document.rows.map((row, index) => {
    const copy = { ...row };
    TAG_FIELDS.forEach((field) => { copy[`__tag_${field}`] = state.tagValues[index]?.[field] ?? ""; });
    return copy;
  });
  const mapping = { ...state.mapping };
  TAG_FIELDS.forEach((field) => { mapping[field] = `__tag_${field}`; });
  return { rows, mapping };
}

$("#analyze-button").addEventListener("click", async () => {
  try {
    const targetRoi = Number($("#target-roi").value || 0);
    const { rows, mapping } = taggedRowsAndMapping();
    const nextAnalysis = analyzeReport(rows, targetRoi, mapping);
    const storedAnalysis = {
      ...nextAnalysis,
      tagInsights: Object.fromEntries(Object.entries(nextAnalysis.tagInsights).map(([field, items]) => [field, items.slice(0, 50)]))
    };
    delete storedAnalysis.rows;

    state.analysis = nextAnalysis;
    state.analysisRestored = false;
    state.reviewPending = false;
    markPlanStale("历史复盘已更新，请重新生成下一版任务。");
    renderAnalysis(state.analysis);
    $("#review-stale-notice").hidden = true;
    let persistenceError = null;
    try {
      await chrome.storage.local.set({ targetRoi, lastAnalysis: storedAnalysis });
    } catch (error) {
      persistenceError = error;
    }
    await persistCurrentProject({ quiet: true });
    $("#analysis-error").textContent = persistenceError ? `复盘已完成，当前会话可继续使用，但未能保存到浏览器：${persistenceError.message || "本地存储不可用"}` : "";
    setStatus("#report-state", persistenceError ? "复盘完成 · 未保存" : "复盘完成", !persistenceError);
    updateReadiness();
    updateLibraryCounts();
    $("#review-empty-state").hidden = true;
    updateWorkflowGuide();
    focusAndReveal($("#results"), { block: "start" });
  } catch (error) {
    $("#analysis-error").textContent = error.message || "分析失败，请检查字段映射与 CSV 内容";
    markReviewPending("本次复盘未成功；以下仍是上一次成功结果。");
    updateWorkflowGuide();
  }
});

function renderAnalysis(result) {
  $("#review-empty-state").hidden = true;
  $("#review-stale-notice").hidden = !state.reviewPending;
  $("#metric-count").textContent = result.summary.creativeCount;
  $("#metric-spend").textContent = `¥${formatMoney(result.summary.totalSpend)}`;
  $("#metric-roi").textContent = result.summary.blendedRoi.toFixed(2);
  const segments = $("#segments");
  segments.replaceChildren();
  for (const [name, count] of Object.entries(result.segments)) {
    const card = element("div", "segment");
    card.append(element("strong", "", count), element("span", "", name));
    segments.append(card);
  }
  const top = $("#top-creatives");
  top.replaceChildren();
  result.topCreatives.slice(0, 6).forEach((row) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", row.creativeName || "未命名素材"), element("span", `badge${row.segment === "高消耗且达标" ? "" : " warn"}`, row.segment));
    card.append(head, element("p", "metric-line", `消耗 ¥${formatMoney(row.spend)} · ROI ${row.roi.toFixed(2)} · CTR ${(row.ctr * 100).toFixed(2)}% · CVR ${(row.cvr * 100).toFixed(2)}%`));
    card.append(element("p", "diagnosis", `${row.confidence}置信度｜${row.diagnosis}`));
    top.append(card);
  });
  if (!top.children.length) top.append(element("p", "empty-inline", "没有可展示的优先素材，请检查报表内容后重新复盘。"));
  const insights = $("#tag-insights");
  insights.replaceChildren();
  const labels = { audience: "受众", hook: "钩子", sellingPoint: "核心主张", scene: "场景" };
  TAG_FIELDS.forEach((field) => {
    const item = result.tagInsights[field]?.[0];
    const card = element("div", "insight");
    card.append(element("span", "", labels[field]), element("strong", "", item?.value || "尚未补齐"), element("small", "", item ? `消耗 ¥${formatMoney(item.spend)} · ROI ${item.roi.toFixed(2)}` : "补齐标签后可分析"));
    insights.append(card);
  });
  $("#results").hidden = false;
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function download(name, content, type) {
  downloadBlob(name, new Blob([content], { type }));
}

$("#export-analysis-json").addEventListener("click", () => state.analysis && download("qianchuan-review.json", JSON.stringify(state.analysis, null, 2), "application/json"));
$("#export-analysis-md").addEventListener("click", () => state.analysis && download("qianchuan-review.md", toMarkdown(state.analysis), "text/markdown;charset=utf-8"));

function updateReadiness() {
  const hasAnalysis = Boolean(state.analysis?.topCreatives?.length);
  const ready = hasAnalysis && !state.reviewPending;
  const generateButton = $("#generate-plan");
  generateButton.disabled = !ready;
  generateButton.title = ready ? "" : state.reviewPending ? "新报表或标签尚未完成复盘" : "请先完成一次历史素材复盘";
  if (ready) {
    const task = readCreativeTaskForm();
    const subject = String(task.subject ?? "").trim();
    const suggestions = taskSuggestions();
    $("#plan-readiness").textContent = `已就绪：${subject || "未填写素材主题"} · ${state.analysis.summary.creativeCount} 条历史素材。${suggestions.length ? `可继续补充 ${suggestions.join("、")}，也可直接生成。` : ""}`;
    $("#plan-readiness").className = "notice ready";
  } else if (state.reviewPending) {
    $("#plan-readiness").textContent = "已读取新的报表或编辑内容。请先点击“完成复盘”，再生成下一版任务。";
    $("#plan-readiness").className = "notice";
  } else {
    $("#plan-readiness").textContent = "完成一次历史素材复盘即可生成；创作任务可以留空并稍后补充。";
    $("#plan-readiness").className = "notice";
  }
}

$("#test-variable").addEventListener("change", () => markPlanStale("测试变量已变化，请重新生成后再导出。"));
$("#min-spend").addEventListener("input", () => markPlanStale("最低测试消耗已变化，请重新生成后再导出。"));

$("#generate-plan").addEventListener("click", async () => {
  try {
    const parentVersionId = $("#parent-version").value || null;
    await saveCreativeTask({ quiet: true });
    const nextPlan = generateCreativePlan(state.creativeTask, state.analysis, {
      testVariable: $("#test-variable").value,
      minSpend: $("#min-spend").value
    });
    state.plan = nextPlan;
    state.planStale = false;
    clearPlanExportReceipt();
    renderPlan(state.plan);
    let persistenceError = null;
    try {
      await chrome.storage.local.set({ creativePlan: state.plan });
    } catch (error) {
      persistenceError = error;
    }
    await persistCurrentProject({ syncPlan: true, parentVersionId, quiet: true });
    $("#plan-error").textContent = persistenceError ? `任务已生成，当前会话可复制或导出，但未能保存到浏览器：${persistenceError.message || "本地存储不可用"}` : "";
    setStatus("#plan-state", persistenceError ? "已生成 · 未保存" : "已生成", !persistenceError);
    setPlanExportControls(false);
    $("#copy-state").textContent = "下一步：检查内容，然后复制或导出。";
    updateLibraryCounts();
    updatePlanEmptyState();
    updateWorkflowGuide();
    focusAndReveal($("#plan-results"), { block: "start" });
  } catch (error) {
    $("#plan-error").textContent = error.message || "生成失败，请检查复盘数据";
  }
});

function editorField(labelText, value, index, path, rows = 2) {
  const label = element("label", "editor-field");
  label.append(element("span", "", labelText));
  const input = rows === 1 ? element("input") : element("textarea");
  if (rows === 1) input.type = path.endsWith("minSpend") ? "number" : "text";
  else input.rows = rows;
  input.value = value ?? "";
  input.dataset.index = index;
  input.dataset.path = path;
  input.setAttribute("aria-label", `${state.plan?.items?.[index]?.id || `任务 ${index + 1}`}：${labelText}`);
  input.addEventListener("input", () => {
    setPlanValue(Number(input.dataset.index), input.dataset.path, input.value);
    clearPlanExportReceipt();
    $("#copy-state").textContent = "方案有未导出的修改；保存后可重新复制或导出。";
    updateWorkflowGuide();
    schedulePlanSave();
  });
  label.append(input);
  return label;
}

function setPlanValue(index, path, value) {
  const parts = path.split(".");
  let target = state.plan.items[index];
  while (parts.length > 1) target = target[parts.shift()];
  const key = parts[0];
  target[key] = key === "minSpend" ? Number(value || 0) : value;
}

async function savePlanNow() {
  try {
    await chrome.storage.local.set({ creativePlan: state.plan });
    await persistCurrentProject({ syncPlan: true, quiet: true });
    $("#plan-error").textContent = "";
    setStatus("#plan-state", "已保存", true);
    return true;
  } catch (error) {
    setStatus("#plan-state", "保存失败");
    $("#plan-error").textContent = `当前编辑仍保留在本次会话，但未能保存：${error.message || "本地存储不可用"}`;
    return false;
  }
}

function schedulePlanSave() {
  setStatus("#plan-state", "保存中…");
  clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(async () => {
    planSaveTimer = null;
    await savePlanNow();
  }, 450);
}

function renderPlan(plan) {
  $("#plan-batch").textContent = plan.batchId || plan.items[0]?.id.replace(/-(?:B00|A\d{2})$/u, "") || "—";
  $("#plan-baseline").textContent = plan.items[0]?.baselineCreative || "—";
  const list = $("#plan-list");
  list.replaceChildren();
  if (!plan.items.length) list.append(element("p", "empty-inline", "当前方案没有可编辑任务，请重新完成复盘并生成。"));
  plan.items.forEach((item, index) => {
    const card = element("details", "card plan-card");
    if (index === 0) card.open = true;
    const summary = element("summary");
    const title = element("span");
    title.append(element("strong", "", item.id), element("small", "", `${item.type} · 只改 ${item.singleVariable}`));
    summary.append(title, element("span", `badge${index === 0 ? "" : " warn"}`, item.type));
    card.append(summary);
    const body = element("div", "plan-editor");
    body.append(
      editorField("测试假设", item.hypothesis, index, "hypothesis", 3),
      editorField("基线素材", item.baselineCreative, index, "baselineCreative", 1),
      editorField("变量值", item.variant, index, "variant", 2)
    );
    const creativeGrid = element("div", "mini-grid");
    creativeGrid.append(
      editorField("目标受众", item.audience, index, "audience", 2),
      editorField("前三秒钩子", item.hook, index, "hook", 2),
      editorField("核心主张", item.coreClaim ?? item.sellingPoint, index, item.coreClaim !== undefined ? "coreClaim" : "sellingPoint", 2),
      editorField("拍摄场景", item.scene, index, "scene", 2)
    );
    body.append(creativeGrid,
      editorField("保持不变", item.fixedElements, index, "fixedElements", 2),
      editorField("观察指标", item.observationMetrics, index, "observationMetrics", 2),
      editorField("最低测试消耗", item.minSpend, index, "minSpend", 1),
      editorField("停止条件", item.stopCondition, index, "stopCondition", 3),
      editorField("成功后动作", item.successAction, index, "successAction", 3),
      element("h4", "editor-section", "生产资料"),
      editorField("口播稿", item.production.spokenScript, index, "production.spokenScript", 7),
      editorField("分镜", item.production.storyboard, index, "production.storyboard", 7),
      editorField("拍摄任务单", item.production.shootingTask, index, "production.shootingTask", 6),
      editorField("剪辑要求", item.production.editingNotes, index, "production.editingNotes", 4),
      editorField("字幕重点", item.production.subtitleHighlights, index, "production.subtitleHighlights", 5),
      editorField("合规检查", item.production.complianceChecklist, index, "production.complianceChecklist", 6)
    );
    card.append(body);
    list.append(card);
  });
  $("#plan-results").hidden = false;
  updatePlanEmptyState();
}

$("#copy-plan").addEventListener("click", async () => {
  if (!state.plan || state.planStale) return;
  try {
    await navigator.clipboard.writeText(planToMarkdown(state.plan));
    $("#copy-state").textContent = "已复制完整策略、脚本、分镜与任务单。";
    await markPlanCompleted();
    updateWorkflowGuide();
  } catch {
    $("#copy-state").textContent = "复制失败，请改用 Markdown 导出。";
  }
});

async function exportPlan(name, createContent, type, label) {
  if (!state.plan || state.planStale) return;
  download(name, createContent(), type);
  await markPlanCompleted();
  $("#copy-state").textContent = `已导出 ${label}；本轮核心流程完成。`;
  updateWorkflowGuide();
}

$("#export-plan-md").addEventListener("click", () => exportPlan("next-creative-plan.md", () => planToMarkdown(state.plan), "text/markdown;charset=utf-8", "Markdown"));
$("#export-plan-csv").addEventListener("click", () => exportPlan("next-creative-plan.csv", () => planToCsv(state.plan), "text/csv;charset=utf-8", "CSV"));
$("#export-plan-json").addEventListener("click", () => exportPlan("next-creative-plan.json", () => JSON.stringify(state.plan, null, 2), "application/json", "JSON"));

function updateLibraryCounts() {
  const taskCount = creativeTaskHasContent(state.creativeTask) ? 1 : 0;
  const reportCount = Number(state.analysis?.summary?.creativeCount || 0);
  const planCount = Number(state.plan?.items?.length || 0);
  $("#asset-task").textContent = String(taskCount);
  $("#asset-report").textContent = String(reportCount);
  $("#asset-plan").textContent = String(planCount);
  $("#library-empty-actions").hidden = reportCount > 0 || planCount > 0;
}

function checkedAtLabel(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "尚未检查" : date.toLocaleString("zh-CN", { hour12: false });
}

function safeStoredReleaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const prefix = "/3132882323-cyber/douyin-qianchuan-creative-director-agent/releases/";
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(prefix) ? url.href : RELEASES_PAGE_URL;
  } catch {
    return RELEASES_PAGE_URL;
  }
}

function renderUpdateState(record = state.lastUpdateCheck) {
  $("#update-current-version").textContent = `v${CURRENT_VERSION}`;
  $("#auto-update-check").checked = state.updateSettings.autoCheck === true;
  const status = $("#update-status");
  const openButton = $("#open-update-page");
  setUpdateMessage(status, "", "");
  openButton.disabled = true;
  if (!record) {
    $("#update-latest-version").textContent = "尚未检查";
    $("#update-checked-at").textContent = "尚未连接 GitHub 检查版本。";
    $("#update-summary").textContent = "本地安装 · 用户确认";
    setUpdateMessage(status, "加载已解压的扩展不会静默自更新。你可以安全检查新版本，再确认是否打开官方下载页。");
    return;
  }
  $("#update-checked-at").textContent = `上次检查：${checkedAtLabel(record.checkedAt)} · 来源：GitHub Releases`;
  if (record.error) {
    $("#update-latest-version").textContent = "检查失败";
    $("#update-summary").textContent = "当前版本保持不变";
    setUpdateMessage(status, `${record.error}。没有下载或替换任何文件，当前版本仍可继续使用。`, "error");
    return;
  }
  let available = false;
  try {
    available = compareVersions(record.latestVersion, CURRENT_VERSION) > 0;
  } catch {
    $("#update-latest-version").textContent = "记录无效";
    $("#update-summary").textContent = "请重新检查";
    setUpdateMessage(status, "已保存的版本记录无效，请重新检查。当前文件未发生变化。", "error");
    return;
  }
  $("#update-latest-version").textContent = record.latestVersion ? `v${record.latestVersion}` : "未知";
  if (available) {
    $("#update-summary").textContent = `发现 v${record.latestVersion}`;
    setUpdateMessage(status, `发现新版本 v${record.latestVersion}。扩展不会自行安装；请先导出备份，再由你确认打开 GitHub Release。`);
    openButton.disabled = false;
  } else {
    $("#update-summary").textContent = "当前已是最新";
    setUpdateMessage(status, "当前版本不低于最新稳定 Release，无需替换文件。", "ready");
  }
}

function setUpdateMessage(node, message, kind = "") {
  node.className = `notice compact${kind ? ` ${kind}` : ""}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  if (node.textContent !== message) node.textContent = message;
}

function showUpdateMessage(message, kind = "") {
  setUpdateMessage($("#update-status"), message, kind);
}

async function runUpdateCheck() {
  const button = $("#check-extension-update");
  button.disabled = true;
  $("#open-update-page").disabled = true;
  showUpdateMessage("正在读取本项目最新 GitHub Release，只处理版本元数据…");
  try {
    try {
      state.lastUpdateCheck = await fetchLatestRelease(CURRENT_VERSION);
    } catch (error) {
      state.lastUpdateCheck = {
        checkedAt: new Date().toISOString(),
        currentVersion: CURRENT_VERSION,
        error: error.message || "版本检查失败"
      };
    }
    await chrome.storage.local.set({ lastUpdateCheck: state.lastUpdateCheck });
    renderUpdateState();
  } catch (error) {
    showUpdateMessage(`版本状态无法保存：${error.message || "未知错误"}。当前版本保持不变。`, "error");
  } finally {
    button.disabled = false;
  }
}

async function requestUpdatePermission() {
  try {
    return await chrome.permissions.request({ origins: [UPDATE_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}

$("#check-extension-update").addEventListener("click", async () => {
  const granted = await requestUpdatePermission();
  if (!granted) {
    showUpdateMessage("未获得 GitHub 版本信息访问权限，因此没有发起网络请求。当前版本保持不变。", "error");
    return;
  }
  await runUpdateCheck();
});

$("#auto-update-check").addEventListener("change", async (event) => {
  const checkbox = event.currentTarget;
  const previous = { ...state.updateSettings };
  if (checkbox.checked) {
    const granted = await requestUpdatePermission();
    if (!granted) {
      checkbox.checked = false;
      state.updateSettings = { autoCheck: false };
      try {
        await chrome.storage.local.set({ updateSettings: state.updateSettings });
      } catch (error) {
        showUpdateMessage(`未获得 GitHub 权限，且关闭状态未能保存：${error.message || "本地存储不可用"}`, "error");
        return;
      }
      showUpdateMessage("未获得 GitHub 访问权限，自动检查没有开启。", "error");
      return;
    }
  }
  state.updateSettings = { autoCheck: checkbox.checked };
  try {
    await chrome.storage.local.set({ updateSettings: state.updateSettings });
  } catch (error) {
    state.updateSettings = previous;
    checkbox.checked = previous.autoCheck === true;
    showUpdateMessage(`自动检查设置未能保存：${error.message || "本地存储不可用"}`, "error");
    return;
  }
  if (checkbox.checked) await runUpdateCheck();
  else renderUpdateState();
});

$("#open-update-page").addEventListener("click", () => {
  const record = state.lastUpdateCheck;
  try {
    if (!record?.latestVersion || compareVersions(record.latestVersion, CURRENT_VERSION) <= 0) return;
  } catch {
    showUpdateMessage("版本记录无效，请重新检查后再打开下载页。", "error");
    return;
  }
  const confirmed = window.confirm(`当前版本 v${CURRENT_VERSION}，发现 v${record.latestVersion}。\n\n将打开本项目 GitHub Release。加载已解压的扩展不会自动安装，下载后仍需你手动备份、替换并重新加载。是否继续？`);
  if (!confirmed) {
    showUpdateMessage("已取消打开下载页，没有修改任何文件。", "ready");
    return;
  }
  window.open(safeStoredReleaseUrl(record.releaseUrl), "_blank", "noopener,noreferrer");
});

$("#export-update-backup").addEventListener("click", async () => {
  try {
    await persistCurrentProject({ quiet: true });
    const snapshot = safeUpdateSnapshot({
      creativeTask: state.creativeTask,
      targetRoi: Number($("#target-roi").value || 1.5),
      lastAnalysis: state.analysis,
      creativePlan: state.plan,
      updateSettings: state.updateSettings,
      lastUpdateCheck: state.lastUpdateCheck
    }, CURRENT_VERSION);
    if (state.projectRepository) {
      snapshot.schemaVersion = 3;
      snapshot.portfolio = await state.projectRepository.exportPortfolio();
      snapshot.notice = "包含当前浏览器中的本地项目集合、测试版本、结果记录和当前工作区；不包含原始 CSV、视频、图片、路径、Cookie、Token 或私钥。";
    }
    download(`qianchuan-director-workspace-v${CURRENT_VERSION}.json`, JSON.stringify(snapshot, null, 2), "application/json;charset=utf-8");
    showUpdateMessage(state.projectRepository
      ? "全部本地项目、测试版本、结果记录和当前工作区已导出；不包含原始 CSV、素材文件、账号凭据或私钥。"
      : "当前工作区备份已导出；多项目数据库不可用，因此本次不包含项目集合。", "ready");
  } catch (error) {
    showUpdateMessage(`当前工作区无法导出：${error.message || "数据格式无效"}`, "error");
  }
});

$("#import-update-backup").addEventListener("click", () => $("#update-backup-file").click());
$("#update-backup-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    validateNonMediaImport(file, "backup");
    const snapshot = parseJsonDocument(await file.text(), "工作区备份");
    const restored = validateUpdateSnapshot(snapshot);
    const portfolio = snapshot.schemaVersion === 3 ? validateProjectPortfolio(snapshot.portfolio) : null;
    if (portfolio && !state.projectRepository) throw new Error("当前浏览器的多项目数据库不可用，不能安全导入项目集合");
    const scope = portfolio ? `${portfolio.projects.length} 个项目、${portfolio.versions.length} 个测试版本、${portfolio.results.length} 条结果以及当前工作区` : "当前项目中的创作任务、复盘摘要和拍摄方案";
    if (!window.confirm(`导入会覆盖${scope}。此操作不会删除原始素材文件，但无法在页面内撤销。是否继续？`)) {
      showUpdateMessage("已取消导入，当前工作区没有变化。", "ready");
      return;
    }
    if (portfolio) {
      const rollbackPortfolio = await state.projectRepository.exportPortfolio();
      const rollbackStorage = {
        ...projectWorkspaceStorageWrite(currentProjectWorkspace()),
        updateSettings: state.updateSettings,
        lastUpdateCheck: state.lastUpdateCheck
      };
      try {
        await state.projectRepository.replacePortfolio(portfolio);
        await chrome.storage.local.set({ updateSettings: restored.updateSettings, lastUpdateCheck: restored.lastUpdateCheck });
        await chrome.storage.local.remove(["productBrief", "planExportReceipt"]);
      } catch (error) {
        const rollbackFailures = [];
        try {
          await state.projectRepository.replacePortfolio(rollbackPortfolio);
        } catch (rollbackError) {
          rollbackFailures.push(`项目集合回滚失败：${rollbackError.message || "IndexedDB 不可用"}`);
        }
        try {
          await chrome.storage.local.set(rollbackStorage);
        } catch (rollbackError) {
          rollbackFailures.push(`当前工作区回滚失败：${rollbackError.message || "本地存储不可用"}`);
        }
        if (rollbackFailures.length) throw new Error(`导入未完成，且无法完整恢复原状态。${rollbackFailures.join("；")}`);
        throw new Error(`导入未完成，已恢复原项目集合和当前工作区：${error.message || "本地存储不可用"}`);
      }
    } else {
      await chrome.storage.local.set({ ...restored, ...(snapshot.schemaVersion === 1 ? { migrationNoticePending: true } : {}) });
      await chrome.storage.local.remove(["productBrief", "planExportReceipt"]);
    }
    window.location.reload();
  } catch (error) {
    showUpdateMessage(error.message || "备份文件无法导入", "error");
  }
});

async function maybeRunAutomaticUpdateCheck() {
  if (!shouldAutoCheck(state.updateSettings, state.lastUpdateCheck)) return;
  const granted = await chrome.permissions.contains({ origins: [UPDATE_ORIGIN_PATTERN] });
  if (granted) await runUpdateCheck();
  else showUpdateMessage("自动检查已开启，但 GitHub 访问权限尚未授予；请点击“检查新版本”确认授权。", "error");
}

const platformInput = $("#platform-files");
const masterInput = $("#master-files");
function refreshMatchButton() {
  $("#platform-count").textContent = platformInput.files.length ? `已选择 ${platformInput.files.length} 个素材` : "可多选视频或图片";
  $("#master-count").textContent = masterInput.files.length ? `已选择 ${masterInput.files.length} 个团队文件` : "请选择团队自有或已授权的原片目录";
  const missing = [!platformInput.files.length ? "平台素材" : "", !masterInput.files.length ? "团队母版文件夹" : ""].filter(Boolean);
  let validationError = "";
  if (!missing.length) {
    try {
      validateMasterMatchSelection(platformInput.files, masterInput.files, MASTER_MATCH_LIMITS);
    } catch (error) {
      validationError = error.message || "所选文件超过本地处理保护上限";
    }
  }
  $("#match-button").disabled = state.matchOperation.running || missing.length > 0 || Boolean(validationError);
  if (!state.matchOperation.running) {
    $("#match-button-help").textContent = validationError || (missing.length ? `还需选择：${missing.join("、")}。` : "文件已就绪；点击后仅在浏览器本地计算指纹与名称候选。");
    if (validationError) setFeedback("#match-status", "#match-error", { error: validationError });
  }
}

function invalidateMatchSelection() {
  state.matchData = null;
  $("#match-results").hidden = true;
  $("#match-file-status").replaceChildren();
  $("#match-file-status").hidden = true;
  setFeedback("#match-status", "#match-error");
  refreshMatchButton();
}

platformInput.addEventListener("change", invalidateMatchSelection);
masterInput.addEventListener("change", () => {
  state.masterFileIndex = new Map([...masterInput.files].map((file) => [file.webkitRelativePath || file.name, file]));
  invalidateMatchSelection();
});

class MatchCancelledError extends Error {
  constructor() {
    super("本轮匹配已取消");
    this.name = "MatchCancelledError";
  }
}

function ensureMatchActive(runId) {
  if (state.matchOperation.runId !== runId || state.matchOperation.cancelRequested) throw new MatchCancelledError();
}

async function digest(file, runId) {
  ensureMatchActive(runId);
  const buffer = await file.arrayBuffer();
  ensureMatchActive(runId);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  ensureMatchActive(runId);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function beginMatchFileStatuses(platformFiles, masterFiles) {
  const container = $("#match-file-status");
  container.replaceChildren();
  const nodes = new Map();
  const entries = [
    ...masterFiles.map((file, index) => ({ key: `master:${index}`, file, kind: "团队母版", waiting: "等待建立索引" })),
    ...platformFiles.map((file, index) => ({ key: `platform:${index}`, file, kind: "平台素材", waiting: "等待匹配" }))
  ];
  for (const entry of entries) {
    const row = element("div", "operation-item");
    const label = element("span", "", `${entry.kind} · ${entry.file.name} · ${formatLocalBytes(entry.file.size)}`);
    const status = element("strong", "", entry.waiting);
    row.append(label, status);
    container.append(row);
    nodes.set(entry.key, status);
  }
  container.hidden = false;
  return nodes;
}

function setMatchRunning(running) {
  state.matchOperation.running = running;
  platformInput.disabled = running;
  masterInput.disabled = running;
  $("#cancel-match").hidden = !running;
  $("#cancel-match").disabled = false;
  $("#match-progress").hidden = !running;
  $("#match-progress").setAttribute("aria-busy", String(running));
  $("#match-button").textContent = running ? "正在本地匹配…" : "开始匹配";
  refreshMatchButton();
}

$("#cancel-match").addEventListener("click", () => {
  if (!state.matchOperation.running) return;
  state.matchOperation.cancelRequested = true;
  state.matchData = null;
  $("#match-results").hidden = true;
  $("#match-file-status").replaceChildren();
  $("#match-file-status").hidden = true;
  $("#cancel-match").disabled = true;
  setFeedback("#match-status", "#match-error", { status: "正在安全停止本轮匹配；当前读取结束后不会继续，也不会保留可导出的半成品。" });
});

$("#match-button").addEventListener("click", async () => {
  if (state.matchOperation.running) return;
  state.matchOperation.runId += 1;
  state.matchOperation.cancelRequested = false;
  const runId = state.matchOperation.runId;
  state.matchData = null;
  $("#match-results").hidden = true;
  setFeedback("#match-status", "#match-error");
  try {
    const selection = validateMasterMatchSelection(platformInput.files, masterInput.files, MASTER_MATCH_LIMITS);
    const masters = selection.masterFiles;
    const platformFiles = selection.platformFiles;
    const statusNodes = beginMatchFileStatuses(platformFiles, masters);
    setMatchRunning(true);
    $("#match-button-help").textContent = `正在本地处理 ${selection.totalFiles} 个文件（${formatLocalBytes(selection.totalBytes)}）；可随时取消。`;
    const hashIndex = new Map();
    const nameIndex = new Map();
    for (const [index, file] of masters.entries()) {
      ensureMatchActive(runId);
      statusNodes.get(`master:${index}`).textContent = "正在读取与计算指纹";
      const hash = await digest(file, runId);
      const byHash = hashIndex.get(hash) ?? [];
      byHash.push(file);
      hashIndex.set(hash, byHash);
      const stem = normalizedStem(file.name);
      const byName = nameIndex.get(stem) ?? [];
      byName.push(file);
      nameIndex.set(stem, byName);
      statusNodes.get(`master:${index}`).textContent = "已建立本地索引";
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const matches = [];
    for (const [index, file] of platformFiles.entries()) {
      ensureMatchActive(runId);
      statusNodes.get(`platform:${index}`).textContent = "正在读取与匹配";
      const exact = hashIndex.get(await digest(file, runId)) ?? [];
      const candidates = nameIndex.get(normalizedStem(file.name)) ?? [];
      const sameSize = candidates.filter((candidate) => candidate.size === file.size);
      let status = "no_match";
      let selected = [];
      if (exact.length) [status, selected] = ["exact_hash", exact];
      else if (sameSize.length) [status, selected] = ["name_and_size", sameSize];
      else if (candidates.length) [status, selected] = ["name_candidate", candidates];
      matches.push({ platformAsset: file.name, status, ownedMasterCandidates: selected.map((candidate) => candidate.webkitRelativePath || candidate.name), requiresHumanReview: status !== "exact_hash" });
      statusNodes.get(`platform:${index}`).textContent = status === "exact_hash" ? "指纹完全一致" : selected.length ? "找到待人工核对候选" : "未找到候选";
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    ensureMatchActive(runId);
    state.matchData = { generatedAt: new Date().toISOString(), platformAssetCount: platformFiles.length, ownedMasterCount: masters.length, matches, notice: "仅进行本地指纹和名称匹配，不检测、移除、破解或规避平台水印。" };
    renderMatches(state.matchData);
    setFeedback("#match-status", "#match-error", { status: `本轮匹配完成：${platformFiles.length} 个平台素材已处理；结果仅在当前页面会话中保留。` });
  } catch (error) {
    state.matchData = null;
    $("#match-results").hidden = true;
    if (error instanceof MatchCancelledError) {
      setFeedback("#match-status", "#match-error", { status: "本轮匹配已取消；未保留或导出任何半成品结果。" });
    } else {
      setFeedback("#match-status", "#match-error", { error: error.message || "匹配失败" });
    }
  } finally {
    if (state.matchOperation.runId === runId) setMatchRunning(false);
  }
});

function renderMatches(data) {
  const labels = { exact_hash: "指纹完全一致", name_and_size: "名称与大小候选", name_candidate: "仅名称候选", no_match: "未找到" };
  const exactCount = data.matches.filter((item) => item.status === "exact_hash").length;
  const candidateCount = data.matches.filter((item) => item.ownedMasterCandidates.length).length;
  $("#match-summary").textContent = `${exactCount}/${data.matches.length} 个确定匹配`;
  $("#repair-master-priority").textContent = candidateCount
    ? `已为 ${candidateCount} 个素材找到团队自有或已授权母版候选。请先人工核对并优先直接使用母版或从原始工程重新导出；只有母版本身仍有普通瑕疵时才使用下方局部修复。`
    : "尚未找到团队母版候选。请优先补充自有或已授权母版或原始工程；局部修复仅用于已授权图片的小范围普通瑕疵。";
  const list = $("#match-list");
  list.replaceChildren();
  data.matches.forEach((match) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", match.platformAsset), element("span", `badge${match.status === "exact_hash" ? "" : " warn"}`, labels[match.status]));
    card.append(head, element("p", "", match.ownedMasterCandidates.length ? match.ownedMasterCandidates.join("；") : "请补充团队自有或已授权母版或原始工程"));
    const candidateFiles = match.ownedMasterCandidates.map((path) => state.masterFileIndex.get(path)).filter(Boolean);
    const candidateVideos = candidateFiles.filter(isSupportedVideoFile);
    const candidateImages = candidateFiles.filter(isRepairImageCandidate);
    if (candidateVideos.length) {
      const addButton = element("button", "secondary full", "将候选团队母版加入转码队列");
      addButton.type = "button";
      addButton.addEventListener("click", () => {
        addTranscodeFiles(candidateVideos);
        $("#transcode-panel").open = true;
        $("#transcode-panel").scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
      });
      card.append(addButton);
    }
    if (candidateImages.length) {
      const inspectButton = element("button", "secondary full", "优先检查候选团队母版图片");
      inspectButton.type = "button";
      inspectButton.addEventListener("click", async () => {
        $("#image-repair-panel").open = true;
        await loadRepairImage(candidateImages[0], { fromOwnedCandidate: true });
        $("#image-repair-panel").scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
      });
      card.append(inspectButton);
    }
    list.append(card);
  });
  if (!list.children.length) list.append(element("p", "empty-inline", "当前没有可展示的匹配结果。"));
  $("#match-results").hidden = false;
}

$("#export-matches").addEventListener("click", () => state.matchData && download("owned-master-matches.json", JSON.stringify(state.matchData, null, 2), "application/json"));

const repairPreviewCanvas = $("#repair-preview-canvas");
const repairMaskCanvas = $("#repair-mask-canvas");
const repairPreviewContext = repairPreviewCanvas.getContext("2d", { willReadFrequently: true });
const repairMaskContext = repairMaskCanvas.getContext("2d", { willReadFrequently: true });

function renderRepairPreview() {
  const repair = state.imageRepair;
  if (!repair.sourcePixels) return;
  repairPreviewContext.putImageData(repair.sourcePixels, 0, 0);
  if (repair.resultPixels) {
    const split = Math.round((Number($("#repair-compare").value) / 100) * repairPreviewCanvas.width);
    if (split < repairPreviewCanvas.width) {
      repairPreviewContext.putImageData(repair.resultPixels, 0, 0, split, 0, repairPreviewCanvas.width - split, repairPreviewCanvas.height);
    }
    repairPreviewContext.save();
    repairPreviewContext.fillStyle = "rgba(255,255,255,.9)";
    repairPreviewContext.fillRect(Math.max(0, split - 1), 0, 2, repairPreviewCanvas.height);
    repairPreviewContext.restore();
  }
  repairMaskCanvas.classList.toggle("mask-hidden", Boolean(repair.resultPixels));
}

function drawRepairStroke(stroke) {
  if (!stroke) return;
  const context = repairMaskContext;
  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = "rgba(255, 35, 35, 1)";
  context.fillStyle = "rgba(255, 35, 35, 1)";
  if (stroke.shape === "rect") {
    context.fillRect(stroke.x, stroke.y, stroke.width, stroke.height);
    context.restore();
    return;
  }
  if (!stroke.points?.length) {
    context.restore();
    return;
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.size;
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.restore();
}

function renderRepairMask() {
  repairMaskContext.clearRect(0, 0, repairMaskCanvas.width, repairMaskCanvas.height);
  currentMaskStrokes(state.imageRepair.history).forEach(drawRepairStroke);
  drawRepairStroke(state.imageRepair.activeStroke);
}

function repairMaskBytes() {
  const { width, height } = repairMaskCanvas;
  const rgba = repairMaskContext.getImageData(0, 0, width, height).data;
  const mask = new Uint8ClampedArray(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = rgba[index * 4 + 3];
  return mask;
}

function invalidateRepairResult() {
  const hadResult = Boolean(state.imageRepair.resultPixels);
  state.imageRepair.resultPixels = null;
  $("#repair-result").hidden = true;
  renderRepairPreview();
  if (hadResult) setFeedback("#repair-status", "#repair-error", { status: "选区或羽化参数已改变，旧预览已失效；请重新预览后再导出。" });
}

function updateRepairControls() {
  const repair = state.imageRepair;
  const history = repair.history;
  const mask = repair.sourcePixels ? repairMaskBytes() : new Uint8ClampedArray();
  const stats = maskSelectionStats(mask);
  const maskTooLarge = stats.selected > IMAGE_REPAIR_LIMITS.maxSelectedPixels || stats.coverage > IMAGE_REPAIR_LIMITS.maxMaskCoverage;
  $("#repair-undo").disabled = history.index <= 0;
  $("#repair-redo").disabled = history.index >= history.states.length - 1;
  $("#repair-clear-mask").disabled = !stats.selected;
  $("#repair-add-rectangle").disabled = !repair.sourcePixels;
  $("#run-image-repair").disabled = !repair.sourcePixels || !stats.selected || maskTooLarge || !$("#repair-authorization").checked;
  $("#export-repaired-image").disabled = !repair.resultPixels || !$("#repair-authorization").checked;
  $("#repair-mask-status").textContent = !repair.sourcePixels
    ? "请先选择一张自有或已授权图片。"
    : maskTooLarge
    ? `选区 ${stats.selected.toLocaleString("zh-CN")} 像素（${(stats.coverage * 100).toFixed(2)}%）超过局部同步处理上限；请缩小或分区圈选。`
    : stats.selected
    ? `人工选区 ${stats.selected.toLocaleString("zh-CN")} 像素（${(stats.coverage * 100).toFixed(2)}%）；${$("#repair-authorization").checked ? "可以预览，仅该范围会参与修复。" : "还需勾选素材授权确认才能预览。"}`
    : "尚未绘制选区。只能修改你手动画出的 Mask 范围。";
}

function resetRepairEdits() {
  state.imageRepair.history = createMaskHistory();
  state.imageRepair.activeStroke = null;
  state.imageRepair.resultPixels = null;
  renderRepairMask();
  renderRepairPreview();
  $("#repair-result").hidden = true;
  setFeedback("#repair-status", "#repair-error");
  updateRepairControls();
}

function isRepairImageCandidate(file) {
  try {
    validateRepairFile(file);
    return true;
  } catch {
    return false;
  }
}

async function loadRepairImage(file, { fromOwnedCandidate = false } = {}) {
  if (!file) return false;
  const loadSequence = state.imageRepair.loadSequence + 1;
  state.imageRepair.loadSequence = loadSequence;
  setFeedback("#repair-status", "#repair-error", { status: "正在浏览器本地读取图片…" });
  $("#repair-workspace").hidden = true;
  try {
    const fileInfo = validateRepairFile(file);
    if (fileInfo.mime === "image/webp") validateStaticWebpBytes(await file.arrayBuffer());
    const bitmap = await createImageBitmap(file);
    try {
      if (loadSequence !== state.imageRepair.loadSequence) return false;
      const dimensions = validateRepairDimensions(bitmap.width, bitmap.height);
      repairPreviewCanvas.width = dimensions.width;
      repairPreviewCanvas.height = dimensions.height;
      repairMaskCanvas.width = dimensions.width;
      repairMaskCanvas.height = dimensions.height;
      repairPreviewContext.clearRect(0, 0, dimensions.width, dimensions.height);
      repairPreviewContext.drawImage(bitmap, 0, 0);
      state.imageRepair.file = file;
      state.imageRepair.sourceMime = fileInfo.mime;
      state.imageRepair.sourcePixels = repairPreviewContext.getImageData(0, 0, dimensions.width, dimensions.height);
      $("#repair-file-label").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
      $("#repair-image-size").textContent = `${dimensions.width} × ${dimensions.height} · ${dimensions.pixels.toLocaleString("zh-CN")} 像素`;
      $("#repair-memory-estimate").textContent = `预计峰值内存 ${(dimensions.estimatedBytes / 1024 / 1024).toFixed(0)} MB / ${IMAGE_REPAIR_LIMITS.maxEstimatedBytes / 1024 / 1024} MB`;
      $("#repair-authorization").checked = false;
      $("#repair-workspace").hidden = false;
      if (fromOwnedCandidate) {
        $("#repair-master-priority").textContent = `已载入候选团队母版“${file.name}”供人工检查。请优先直接使用干净母版或从原始工程重新导出；只有母版本身仍有普通瑕疵时，才确认授权并手动画 Mask 修复。`;
      }
      resetRepairEdits();
      setFeedback("#repair-status", "#repair-error", { status: "图片已在本地载入；请确认授权并手动圈选修复范围。" });
      return true;
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (loadSequence !== state.imageRepair.loadSequence) return false;
    state.imageRepair.file = null;
    state.imageRepair.sourceMime = "";
    state.imageRepair.sourcePixels = null;
    state.imageRepair.resultPixels = null;
    state.imageRepair.history = createMaskHistory();
    $("#repair-workspace").hidden = true;
    setFeedback("#repair-status", "#repair-error", { error: error instanceof RangeError
      ? "浏览器内存不足，已停止读取；请从自有工程缩小图片后再试。"
      : error.message || "图片解码失败，请确认文件未损坏且格式受支持" });
    $("#repair-file-label").textContent = "支持 PNG、JPEG、静态 WebP；原图不会被覆盖";
    updateRepairControls();
    return false;
  }
}

$("#repair-image-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) await loadRepairImage(file);
});

function repairPointFromEvent(event) {
  const bounds = repairMaskCanvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(repairMaskCanvas.width, ((event.clientX - bounds.left) / bounds.width) * repairMaskCanvas.width)),
    y: Math.max(0, Math.min(repairMaskCanvas.height, ((event.clientY - bounds.top) / bounds.height) * repairMaskCanvas.height)),
    scale: Math.max(repairMaskCanvas.width / bounds.width, repairMaskCanvas.height / bounds.height)
  };
}

repairMaskCanvas.addEventListener("pointerdown", (event) => {
  if (!state.imageRepair.sourcePixels || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  invalidateRepairResult();
  const point = repairPointFromEvent(event);
  state.imageRepair.activeStroke = {
    tool: state.imageRepair.tool,
    size: Number($("#repair-brush-size").value) * point.scale,
    pointerId: event.pointerId,
    points: [{ x: point.x, y: point.y }]
  };
  repairMaskCanvas.setPointerCapture(event.pointerId);
  renderRepairMask();
});

repairMaskCanvas.addEventListener("pointermove", (event) => {
  const stroke = state.imageRepair.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = repairPointFromEvent(event);
  const previous = stroke.points.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(1, stroke.size / 12)) return;
  stroke.points.push({ x: point.x, y: point.y });
  renderRepairMask();
});

function finishRepairStroke(event) {
  const stroke = state.imageRepair.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) return;
  const committed = { tool: stroke.tool, size: stroke.size, points: stroke.points };
  state.imageRepair.history = commitMaskState(state.imageRepair.history, [...currentMaskStrokes(state.imageRepair.history), committed]);
  state.imageRepair.activeStroke = null;
  if (repairMaskCanvas.hasPointerCapture(event.pointerId)) repairMaskCanvas.releasePointerCapture(event.pointerId);
  renderRepairMask();
  updateRepairControls();
}
repairMaskCanvas.addEventListener("pointerup", finishRepairStroke);
repairMaskCanvas.addEventListener("pointercancel", finishRepairStroke);

function setRepairTool(tool) {
  state.imageRepair.tool = tool;
  for (const [id, value] of [["repair-brush-tool", "brush"], ["repair-eraser-tool", "eraser"]]) {
    const active = value === tool;
    $(`#${id}`).classList.toggle("active", active);
    $(`#${id}`).setAttribute("aria-pressed", String(active));
  }
}
$("#repair-brush-tool").addEventListener("click", () => setRepairTool("brush"));
$("#repair-eraser-tool").addEventListener("click", () => setRepairTool("eraser"));
$("#repair-brush-size").addEventListener("input", (event) => { $("#repair-brush-size-label").textContent = event.target.value; });
$("#repair-feather").addEventListener("input", (event) => { $("#repair-feather-label").textContent = event.target.value; invalidateRepairResult(); });
$("#repair-authorization").addEventListener("change", updateRepairControls);
$("#repair-undo").addEventListener("click", () => {
  state.imageRepair.history = undoMaskState(state.imageRepair.history);
  invalidateRepairResult();
  renderRepairMask();
  updateRepairControls();
});
$("#repair-redo").addEventListener("click", () => {
  state.imageRepair.history = redoMaskState(state.imageRepair.history);
  invalidateRepairResult();
  renderRepairMask();
  updateRepairControls();
});
$("#repair-clear-mask").addEventListener("click", () => {
  if (!window.confirm("将清空当前人工选区，并使现有修复预览失效。原图不会被修改。是否继续？")) {
    setFeedback("#repair-status", "#repair-error", { status: "已取消清空，人工选区保持不变。" });
    return;
  }
  state.imageRepair.history = clearMaskState(state.imageRepair.history);
  invalidateRepairResult();
  renderRepairMask();
  updateRepairControls();
});

$("#repair-add-rectangle").addEventListener("click", () => {
  if (!state.imageRepair.sourcePixels) return;
  const values = {
    x: Number($("#repair-rect-x").value),
    y: Number($("#repair-rect-y").value),
    width: Number($("#repair-rect-width").value),
    height: Number($("#repair-rect-height").value)
  };
  if (![values.x, values.y, values.width, values.height].every(Number.isFinite) || values.x < 0 || values.y < 0 || values.width <= 0 || values.height <= 0 || values.x + values.width > 100 || values.y + values.height > 100) {
    setFeedback("#repair-status", "#repair-error", { error: "矩形选区必须位于图片范围内，且宽度和高度均大于 0。" });
    return;
  }
  invalidateRepairResult();
  setFeedback("#repair-status", "#repair-error");
  const rectangle = {
    tool: "brush",
    shape: "rect",
    x: (values.x / 100) * repairMaskCanvas.width,
    y: (values.y / 100) * repairMaskCanvas.height,
    width: (values.width / 100) * repairMaskCanvas.width,
    height: (values.height / 100) * repairMaskCanvas.height,
    size: 0,
    points: []
  };
  state.imageRepair.history = commitMaskState(state.imageRepair.history, [...currentMaskStrokes(state.imageRepair.history), rectangle]);
  renderRepairMask();
  updateRepairControls();
  focusAndReveal($("#repair-mask-status"));
});

$("#run-image-repair").addEventListener("click", async () => {
  setFeedback("#repair-status", "#repair-error", { status: "正在浏览器本地生成预览…" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const repaired = repairLocalImage({
      authorizationConfirmed: $("#repair-authorization").checked,
      rgba: state.imageRepair.sourcePixels.data,
      mask: repairMaskBytes(),
      width: repairPreviewCanvas.width,
      height: repairPreviewCanvas.height,
      featherRadius: $("#repair-feather").value,
      searchRadius: 48
    });
    state.imageRepair.resultPixels = new ImageData(repaired.data, repaired.width, repaired.height);
    $("#repair-result").hidden = false;
    setFeedback("#repair-status", "#repair-error", { status: `预览完成：修改 ${repaired.changedPixels.toLocaleString("zh-CN")} 个 Mask 内像素；透明通道保持不变。` });
    renderRepairPreview();
    updateRepairControls();
  } catch (error) {
    state.imageRepair.resultPixels = null;
    $("#repair-result").hidden = true;
    setFeedback("#repair-status", "#repair-error", { error: error.message || "局部修复失败" });
    renderRepairPreview();
  }
});

$("#repair-compare").addEventListener("input", (event) => {
  $("#repair-compare-label").textContent = `${event.target.value}%`;
  renderRepairPreview();
});

function syncRepairExportControls() {
  const exportInfo = resolveRepairExport({
    requestedFormat: $("#repair-export-format").value,
    sourceMime: state.imageRepair.sourceMime,
    jpegQuality: $("#repair-jpeg-quality").value
  });
  $("#repair-jpeg-quality").disabled = exportInfo.mime !== "image/jpeg";
}
$("#repair-export-format").addEventListener("change", syncRepairExportControls);
$("#repair-jpeg-quality").addEventListener("input", (event) => { $("#repair-jpeg-quality-label").textContent = Number(event.target.value).toFixed(2); });
$("#reset-image-repair").addEventListener("click", () => {
  const hasEdits = currentMaskStrokes(state.imageRepair.history).length > 0 || Boolean(state.imageRepair.resultPixels);
  if (hasEdits && !window.confirm("将重置当前人工选区和修复预览。已选择的原图仍会保留，是否继续？")) {
    setFeedback("#repair-status", "#repair-error", { status: "已取消重置，当前选区与预览保持不变。" });
    return;
  }
  resetRepairEdits();
});
$("#export-repaired-image").addEventListener("click", () => {
  if (!state.imageRepair.resultPixels || !state.imageRepair.file || !$("#repair-authorization").checked) return;
  try {
    const exportInfo = resolveRepairExport({
      requestedFormat: $("#repair-export-format").value,
      sourceMime: state.imageRepair.sourceMime,
      jpegQuality: $("#repair-jpeg-quality").value
    });
    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = repairPreviewCanvas.width;
    pixelCanvas.height = repairPreviewCanvas.height;
    pixelCanvas.getContext("2d").putImageData(state.imageRepair.resultPixels, 0, 0);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = pixelCanvas.width;
    exportCanvas.height = pixelCanvas.height;
    const exportContext = exportCanvas.getContext("2d");
    if (exportInfo.mime === "image/jpeg") {
      exportContext.fillStyle = "#fff";
      exportContext.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    }
    exportContext.drawImage(pixelCanvas, 0, 0);
    exportCanvas.toBlob((blob) => {
      if (!blob) {
        setFeedback("#repair-status", "#repair-error", { error: "浏览器无法编码该图片" });
        return;
      }
      downloadBlob(repairOutputName(state.imageRepair.file.name, exportInfo.extension), blob);
      setFeedback("#repair-status", "#repair-error", { status: exportInfo.preservesAlpha ? "已导出 PNG，新文件保留透明通道。" : "已导出 JPEG；透明区域已安全铺为白色。" });
    }, exportInfo.mime, exportInfo.quality);
  } catch (error) {
    setFeedback("#repair-status", "#repair-error", { error: error.message || "图片导出失败" });
  }
});
syncRepairExportControls();

const transcodeInput = $("#transcode-files");

function transcodeFileIdentity(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

function refreshTranscodeSelection() {
  const count = state.transcodeFiles.length;
  const totalBytes = state.transcodeFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  $("#transcode-file-count").textContent = count ? `已加入 ${count} 个自有/授权视频 · ${formatLocalBytes(totalBytes)}` : "支持最多 100 个视频、合计 100 GB；也可从上方母版匹配结果加入";
  const list = $("#transcode-selection-list");
  list.replaceChildren();
  state.transcodeFiles.forEach((file) => {
    const row = element("div", "operation-item");
    row.append(element("span", "", file.webkitRelativePath || file.name), element("strong", "", `${formatLocalBytes(file.size)} · 待生成任务`));
    list.append(row);
  });
  if (!count) list.append(element("p", "empty-inline", "尚未选择视频。浏览器不会自动读取本地目录。"));
  $("#clear-transcode-selection").disabled = !count;
  updateTranscodeReadiness();
}

function markTranscodeDirty() {
  if (state.transcodeManifest) {
    state.transcodeManifest = null;
    $("#transcode-queue").hidden = true;
    setFeedback("#transcode-status", "#transcode-error", { status: "文件或参数已改变，旧任务清单已失效，请重新生成。" });
  }
  updateTranscodeReadiness();
}

function addTranscodeFiles(files) {
  const incoming = [...files];
  if (!incoming.length) return false;
  const supported = incoming.filter(isSupportedVideoFile);
  const previousCount = state.transcodeFiles.length;
  if (supported.length !== incoming.length) {
    setFeedback("#transcode-status", "#transcode-error", { error: `所选内容包含 ${incoming.length - supported.length} 个不支持的文件，本次没有加入任何文件。` });
    return false;
  }
  const known = new Set(state.transcodeFiles.map(transcodeFileIdentity));
  const nextFiles = [...state.transcodeFiles];
  for (const file of supported) {
    const identity = transcodeFileIdentity(file);
    if (!known.has(identity)) {
      known.add(identity);
      nextFiles.push(file);
    }
  }
  if (!supported.length && incoming.length) {
    setFeedback("#transcode-status", "#transcode-error", { error: "所选文件中没有可识别的视频原片。" });
    return false;
  }
  try {
    validateLocalVideoBatch(nextFiles, LOCAL_VIDEO_BATCH_LIMITS);
  } catch (error) {
    setFeedback("#transcode-status", "#transcode-error", { error: error.message || "所选视频超过本地任务保护上限" });
    return false;
  }
  state.transcodeFiles = nextFiles;
  const added = nextFiles.length - previousCount;
  const selectionMessage = added
    ? `${added} 个视频已加入当前选择。`
    : "所选视频已在当前选择中，没有重复加入。";
  setFeedback("#transcode-status", "#transcode-error", { status: selectionMessage });
  markTranscodeDirty();
  refreshTranscodeSelection();
  return true;
}

transcodeInput.addEventListener("change", (event) => {
  addTranscodeFiles(event.target.files);
  event.target.value = "";
});

$("#clear-transcode-selection").addEventListener("click", () => {
  if (!state.transcodeFiles.length || !window.confirm("将清空当前浏览器会话中的转码文件选择和待执行清单。原始文件不会被删除。是否继续？")) {
    setFeedback("#transcode-status", "#transcode-error", { status: "已取消清空，当前转码选择保持不变。" });
    return;
  }
  state.transcodeFiles = [];
  state.transcodeManifest = null;
  $("#transcode-queue").hidden = true;
  setFeedback("#transcode-status", "#transcode-error", { status: "当前浏览器内的转码选择与待执行清单已清空；原始文件未被修改。" });
  refreshTranscodeSelection();
});

const transcodeSettingIds = [
  "transcode-authorization", "transcode-source-root", "transcode-output-root", "transcode-preset",
  "transcode-resolution", "transcode-frame-rate", "transcode-video-bitrate", "transcode-audio-bitrate",
  "transcode-sample-rate", "transcode-output-suffix", "transcode-ffmpeg-path"
];
transcodeSettingIds.forEach((id) => $(`#${id}`).addEventListener("input", markTranscodeDirty));

function updateTranscodeReadiness() {
  const missing = [];
  if (!state.transcodeFiles.length) missing.push("选择至少一个视频");
  if (!$("#transcode-authorization").checked) missing.push("确认素材授权");
  if (!$("#transcode-source-root").value.trim()) missing.push("填写原片根目录");
  if (!$("#transcode-output-root").value.trim()) missing.push("填写输出目录");
  let validationError = "";
  if (state.transcodeFiles.length) {
    try {
      validateLocalVideoBatch(state.transcodeFiles, LOCAL_VIDEO_BATCH_LIMITS);
    } catch (error) {
      validationError = error.message || "当前选择超过本地任务保护上限";
    }
  }
  const reason = validationError || (missing.length ? `还需：${missing.join("、")}。` : "已就绪：点击后只生成本机待执行任务，不会在浏览器中转码。");
  $("#build-transcode-tasks").disabled = missing.length > 0 || Boolean(validationError);
  setNodeText("#transcode-button-help", reason);
}

function syncTranscodePreset() {
  const preset = $("#transcode-preset").value;
  const defaults = {
    balanced: { audio: "192" },
    high_quality: { audio: "256" },
    compact: { audio: "128" },
    custom_bitrate: { audio: "192" }
  };
  $("#transcode-audio-bitrate").value = defaults[preset].audio;
  $("#transcode-video-bitrate").disabled = preset !== "custom_bitrate";
  markTranscodeDirty();
}
$("#transcode-preset").addEventListener("change", syncTranscodePreset);
syncTranscodePreset();
refreshTranscodeSelection();

function readTranscodeSettings() {
  return {
    authorizationConfirmed: $("#transcode-authorization").checked,
    sourceRoot: $("#transcode-source-root").value,
    outputRoot: $("#transcode-output-root").value,
    preset: $("#transcode-preset").value,
    resolution: $("#transcode-resolution").value,
    frameRate: $("#transcode-frame-rate").value,
    videoBitrateKbps: $("#transcode-video-bitrate").value,
    audioBitrateKbps: $("#transcode-audio-bitrate").value,
    sampleRate: $("#transcode-sample-rate").value,
    outputSuffix: $("#transcode-output-suffix").value,
    ffmpegExecutable: $("#transcode-ffmpeg-path").value
  };
}

function renderTranscodeQueue() {
  const manifest = state.transcodeManifest;
  if (!manifest) {
    $("#transcode-queue").hidden = true;
    return;
  }
  const progress = transcodeProgress(manifest.tasks);
  setNodeText("#transcode-progress-label", `${progress.finished}/${progress.total} 已结束 · ${progress.completed} 成功 · ${progress.failed} 失败`);
  $("#transcode-progress-bar").style.width = `${progress.percent}%`;
  const progressNode = $("#transcode-progress");
  progressNode.setAttribute("aria-valuemax", String(progress.total));
  progressNode.setAttribute("aria-valuenow", String(progress.finished));
  progressNode.setAttribute("aria-valuetext", `${progress.finished}/${progress.total} 已结束，${progress.completed} 成功，${progress.failed} 失败`);
  setNodeText("#transcode-queue-status", progress.finished === 0
    ? `浏览器已生成 ${progress.total} 个待执行任务，但尚未运行 FFmpeg；请在本机执行后导入结果。`
    : progress.finished < progress.total
    ? `已导入部分结果；还有 ${progress.total - progress.finished} 个任务未结束。`
    : progress.failed
    ? `本轮执行结果已全部导入，其中 ${progress.failed} 个失败；请查看对应任务原因。`
    : "本轮执行结果已全部导入，所有任务完成。");
  const list = $("#transcode-task-list");
  list.replaceChildren();
  const labels = { pending: "待执行", completed: "已完成", failed: "失败", skipped: "已跳过" };
  manifest.tasks.forEach((task) => {
    const card = element("article", "item transcode-task");
    const head = element("div", "item-head");
    head.append(element("strong", "", task.source.name), element("span", `badge ${task.status}`, labels[task.status] || "待执行"));
    card.append(head);
    card.append(element("p", "task-path", `输出：${task.outputPath}`));
    if (task.status === "failed") {
      const failure = element("p", "error", task.failureReason || `FFmpeg 执行失败${task.exitCode === null ? "" : `（退出码 ${task.exitCode}）`}`);
      failure.setAttribute("role", "alert");
      card.append(failure);
    }
    const commandDetails = element("details", "task-command");
    const commandSummary = element("summary");
    commandSummary.append(element("span", "", "查看本地命令"));
    const command = element("pre", "", task.powerShellCommand);
    commandDetails.append(commandSummary, command);
    card.append(commandDetails);
    list.append(card);
  });
  if (!manifest.tasks.length) list.append(element("p", "empty-inline", "当前任务清单为空，请重新选择视频并生成。"));
  $("#transcode-queue").hidden = false;
}

$("#build-transcode-tasks").addEventListener("click", () => {
  setFeedback("#transcode-status", "#transcode-error");
  try {
    state.transcodeManifest = createTranscodeManifest(state.transcodeFiles, readTranscodeSettings(), { creatorVersion: CURRENT_VERSION });
    renderTranscodeQueue();
    setFeedback("#transcode-status", "#transcode-error", { status: `已生成 ${state.transcodeManifest.tasks.length} 个本机待执行任务；浏览器尚未运行 FFmpeg，也未修改原片。` });
  } catch (error) {
    state.transcodeManifest = null;
    renderTranscodeQueue();
    setFeedback("#transcode-status", "#transcode-error", { error: error.message || "无法生成转码任务" });
  }
});

$("#copy-transcode-commands").addEventListener("click", async () => {
  if (!state.transcodeManifest) return;
  try {
    await navigator.clipboard.writeText(state.transcodeManifest.tasks.map((task) => task.powerShellCommand).join("\r\n\r\n"));
    setFeedback("#transcode-status", "#transcode-error", { status: "全部本地命令已复制；执行前请再次核对输入与输出路径。" });
  } catch {
    setFeedback("#transcode-status", "#transcode-error", { error: "复制失败，请导出任务清单并使用本地执行器。" });
  }
});

$("#export-transcode-manifest").addEventListener("click", () => {
  if (!state.transcodeManifest) return;
  download("qianchuan-transcode-tasks.json", JSON.stringify(state.transcodeManifest, null, 2), "application/json;charset=utf-8");
  setFeedback("#transcode-status", "#transcode-error", { status: "任务清单已导出；它包含你填写的本地输入与输出路径，请只在可信设备上保存。" });
});

$("#download-transcode-worker").addEventListener("click", async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("tools/transcode-worker.ps1"), { cache: "no-store" });
    if (!response.ok) throw new Error("执行器文件无法读取");
    download("transcode-worker.ps1", await response.text(), "text/plain;charset=utf-8");
    setFeedback("#transcode-status", "#transcode-error", { status: "本地执行器已下载。运行前可以打开检查其源码。" });
  } catch (error) {
    setFeedback("#transcode-status", "#transcode-error", { error: `${error.message || "执行器下载失败"}；也可以从开源仓库 tools 目录获取。` });
  }
});

$("#import-transcode-result").addEventListener("click", () => $("#transcode-result-file").click());
$("#transcode-result-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.transcodeManifest) return;
  try {
    validateNonMediaImport(file, "executionResult");
    const results = validateTranscodeResult(parseJsonDocument(await file.text(), "本机执行结果"), state.transcodeManifest);
    const byId = new Map(results.map((result) => [result.id, result]));
    state.transcodeManifest.tasks = state.transcodeManifest.tasks.map((task) => ({ ...task, ...(byId.get(task.id) || {}) }));
    renderTranscodeQueue();
    const progress = transcodeProgress(state.transcodeManifest.tasks);
    setFeedback("#transcode-status", "#transcode-error", progress.failed
      ? { error: `已导入执行结果：${progress.completed} 成功，${progress.failed} 失败。失败原因已显示在任务下方。` }
      : { status: `已导入执行结果：${progress.completed} 个任务完成。` });
  } catch (error) {
    setFeedback("#transcode-status", "#transcode-error", { error: error.message || "执行结果无法导入" });
  }
});

async function applyWorkspaceMaintenance(recovery) {
  let writesSaved = true;
  if (Object.keys(recovery.writes).length) {
    try {
      await chrome.storage.local.set(recovery.writes);
    } catch (error) {
      writesSaved = false;
      showRecoveryIssues([{ key: "", message: `兼容资料已在当前会话恢复，但未能写回本地：${error.message || "本地存储不可用"}` }]);
    }
  }
  if (recovery.cleanupKeys.length && writesSaved) {
    try {
      await chrome.storage.local.remove(recovery.cleanupKeys);
    } catch (error) {
      showRecoveryIssues([{ key: "", message: `兼容迁移已保存，但旧记录暂未清理：${error.message || "本地存储不可用"}` }]);
    }
  }
  if (recovery.data.migrationNoticePending) {
    try {
      await chrome.storage.local.remove("migrationNoticePending");
    } catch (error) {
      showRecoveryIssues([{ key: "", message: `迁移提示状态未能更新：${error.message || "本地存储不可用"}` }]);
    }
  }
  return { writesSaved };
}

function renderRecoveredWorkspace(recovery, maintenance) {
  const restored = recovery.data;
  state.creativeTask = restored.creativeTask;
  state.analysis = restored.lastAnalysis;
  state.analysisRestored = Boolean(restored.lastAnalysis);
  state.plan = restored.creativePlan;
  state.updateSettings = restored.updateSettings;
  state.lastUpdateCheck = restored.lastUpdateCheck;
  state.planExportReceipt = restored.planExportReceipt;
  state.onboardingDismissed = restored.onboardingDismissed;

  fillCreativeTaskForm(state.creativeTask);
  $("#target-roi").value = restored.targetRoi;
  const taskHasContent = creativeTaskHasContent(state.creativeTask);
  setStatus("#task-save-state", taskHasContent ? "已保存" : "可选", taskHasContent);

  if (recovery.migrated || restored.migrationNoticePending) {
    $("#task-migration-notice").hidden = false;
    $("#task-migration-message").textContent = maintenance.writesSaved
      ? "旧版资料已迁移为可选创作任务。旧原值仅在当前浏览器本地归档，不参与生成，也不会进入新备份。"
      : "旧版资料已在当前会话兼容载入，但尚未写回本地；请先导出备份或检查浏览器存储。";
  }

  if (state.analysis) {
    try {
      renderAnalysis(state.analysis);
      $("#review-restore-notice").hidden = false;
      setStatus("#report-state", "已恢复上次复盘", true);
    } catch (error) {
      state.analysis = null;
      state.analysisRestored = false;
      showRecoveryIssues([{ key: "lastAnalysis", message: `复盘摘要无法显示，已隔离该记录：${error.message || "格式无效"}` }], ["lastAnalysis"]);
    }
  }

  if (state.plan) {
    try {
      state.planStale = !planMatchesCurrentContext(state.plan, state.creativeTask, state.analysis);
      state.planExported = Boolean(!state.planStale && state.planExportReceipt?.fingerprint === planFingerprint(state.plan));
      renderPlan(state.plan);
      setStatus("#plan-state", state.planStale ? "需重新生成" : "已恢复", !state.planStale);
      $("#test-variable").value = state.plan.testVariable || "hook";
      $("#min-spend").value = state.plan.items?.[0]?.minSpend || 300;
      setPlanExportControls(state.planStale, state.planStale ? "当前任务上下文与已保存方案不一致，请重新生成" : "");
      if (state.planStale) clearPlanExportReceipt();
      else if (state.planExported) $("#copy-state").textContent = "此方案已复制或导出；如继续编辑，完成状态会自动清除。";
    } catch (error) {
      state.plan = null;
      state.planStale = false;
      state.planExported = false;
      showRecoveryIssues([{ key: "creativePlan", message: `下一版任务无法显示，已隔离该记录：${error.message || "格式无效"}` }], ["creativePlan"]);
    }
  }

  try {
    renderUpdateState();
  } catch (error) {
    state.updateSettings = { autoCheck: false };
    state.lastUpdateCheck = null;
    showRecoveryIssues([{ key: "lastUpdateCheck", message: `版本状态无法显示，已恢复为未检查：${error.message || "格式无效"}` }], ["lastUpdateCheck"]);
    renderUpdateState();
  }
  $("#onboarding-guide").hidden = state.onboardingDismissed;
}

function finalizeWorkspaceUi() {
  const finalizers = [
    ["就绪状态", updateReadiness],
    ["素材计数", updateLibraryCounts],
    ["方案空状态", updatePlanEmptyState],
    ["工作流进度", updateWorkflowGuide],
    ["当前工作区", () => switchView(document.querySelector(".tab.active")?.dataset.view || "task")]
  ];
  $("#review-empty-state").hidden = Boolean(state.analysis || state.document);
  for (const [label, action] of finalizers) {
    try {
      action();
    } catch (error) {
      showRecoveryIssues([{ key: "", message: `${label}初始化失败：${error.message || "未知错误"}` }]);
    }
  }
}

async function initializeWorkspace() {
  let stored = {};
  try {
    stored = await chrome.storage.local.get(STORAGE_KEYS);
  } catch (error) {
    showRecoveryIssues([{ key: "", message: `本地工作区无法读取，已使用临时默认值：${error.message || "本地存储不可用"}` }]);
  }

  stored = await initializeProjectLayer(stored);

  let recovery;
  try {
    recovery = recoverStoredWorkspace(stored);
  } catch (error) {
    recovery = recoverStoredWorkspace({});
    showRecoveryIssues([{ key: "", message: `本地工作区恢复失败，已使用空白工作区：${error.message || "未知错误"}` }]);
  }
  showRecoveryIssues(recovery.issues, recovery.invalidKeys);
  const maintenance = await applyWorkspaceMaintenance(recovery);

  try {
    renderRecoveredWorkspace(recovery, maintenance);
  } catch (error) {
    showRecoveryIssues([{ key: "", message: `工作区界面已安全降级：${error.message || "未知错误"}` }]);
    $("#onboarding-guide").hidden = false;
  }
  finalizeWorkspaceUi();
  await persistCurrentProject({ syncPlan: Boolean(state.plan?.items?.length), quiet: true });
  if (!state.plan?.items?.length) await refreshExperimentLoop();
  await loadSessionAnalysisHandoff();
  try {
    await maybeRunAutomaticUpdateCheck();
  } catch (error) {
    showUpdateMessage(`自动版本检查未完成：${error.message || "未知错误"}。当前版本保持不变。`, "error");
  }
}

function initialize() {
  if (!initializationPromise) initializationPromise = initializeWorkspace();
  return initializationPromise;
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "session" || !Object.hasOwn(changes, ANALYSIS_HANDOFF_INBOX_KEY)) return;
  void initialize()
    .then(() => handleSessionAnalysisHandoff(changes[ANALYSIS_HANDOFF_INBOX_KEY]?.newValue, { announce: true }))
    .catch((error) => setFeedback("#analysis-handoff-message", "#analysis-handoff-error", { error: `无法响应工作台会话交接：${error.message || "会话存储不可用"}` }));
});

void initialize();
