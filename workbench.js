import {
  MATERIAL_VIDEO_BATCH_LIMITS,
  analyzeTranscriptStructure,
  createLocalTranscriptionPlan,
  createMaterialProcessingManifest,
  materialAnalysisToMarkdown,
  validateDouyinSourceNote
} from "./src/material-analysis.js";
import { parseTranscriptDocument, transcriptDocumentMatchesText } from "./src/timed-transcript.js";
import {
  CREATIVE_REVISION_EDITABLE_FIELDS,
  creativeRevisionToMarkdown,
  creativeRevisionWithEdits,
  createCreativeRevisionDraft,
  revisionRecommendationsForAnalysis
} from "./src/creative-revision.js";
import { isSupportedVideoFile, transcodeProgress, validateLocalVideoBatch, validateTranscodeResult } from "./src/transcode.js";
import { formatLocalBytes } from "./src/local-file-guard.js";
import { parseJsonDocument, validateNonMediaImport } from "./src/release-safety.js";
import { buildWorkbenchOverview, buildWorkbenchResetPrompt } from "./src/workbench-overview.js";
import {
  ANALYSIS_HANDOFF_INBOX_KEY,
  analysisHandoffForAnalysis,
  enqueueAnalysisHandoff,
  openAnalysisHandoffSidePanel
} from "./src/analysis-handoff-inbox.js";

const $ = (selector) => document.querySelector(selector);
const VERSION = chrome.runtime.getManifest().version;
const state = {
  entryMode: "",
  files: [],
  processingManifest: null,
  processingPrepared: false,
  processingExported: false,
  transcriptionPlan: null,
  transcriptionExported: false,
  transcriptSourceName: "手动粘贴文本",
  transcriptDocument: null,
  timingInvalidated: false,
  analysis: null,
  analysisPreserved: false,
  revisionRecommendations: [],
  selectedRecommendationIds: new Set(),
  revisionDraft: null,
  revisionPreserved: false,
  revisionConfirmed: false,
  analysisHandoffCache: null,
  handoffState: "idle",
  flowModel: null
};

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

function setFlowFeedback({ status = "", error = "" } = {}) {
  setFeedback("#workbench-flow-message", "#workbench-flow-error", { status, error });
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function download(name, content, type = "application/json;charset=utf-8") {
  downloadBlob(name, new Blob([content], { type }));
}

async function readPackagedText(path) {
  const resourceUrl = new URL(chrome.runtime.getURL(path));
  if (resourceUrl.protocol !== "chrome-extension:" || resourceUrl.hostname !== chrome.runtime.id) {
    throw new Error("只允许读取当前扩展内置文件");
  }
  const response = await fetch(resourceUrl.href, { cache: "no-store" });
  if (!response.ok) throw new Error("扩展内置文件无法读取");
  return response.text();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function materialSetupState() {
  const hasFiles = state.files.length > 0;
  const authorized = $("#material-authorization").checked;
  const hasSourceRoot = Boolean($("#material-source-root").value.trim());
  const hasOutputRoot = Boolean($("#material-output-root").value.trim());
  const hasFfmpeg = Boolean($("#material-ffmpeg-path").value.trim());
  let sourceNoteError = "";
  try {
    validateDouyinSourceNote($("#douyin-source-note").value);
  } catch (error) {
    sourceNoteError = error.message || "来源备注链接无效";
  }
  let missingField = "";
  if (!hasFiles) missingField = "files";
  else if (!authorized) missingField = "authorization";
  else if (!hasSourceRoot) missingField = "sourceRoot";
  else if (!hasOutputRoot) missingField = "outputRoot";
  else if (!hasFfmpeg) missingField = "ffmpeg";
  else if (sourceNoteError) missingField = "sourceNote";
  return {
    hasFiles,
    authorized,
    hasSourceRoot,
    hasOutputRoot,
    hasFfmpeg,
    sourceNoteError,
    ready: hasFiles && authorized && hasSourceRoot && hasOutputRoot && hasFfmpeg && !sourceNoteError,
    missingField
  };
}

function setOverviewStep(id, status, text, isCurrent = false) {
  const card = $(`#overview-${id}`);
  card.classList.toggle("current", status === "current");
  card.classList.toggle("complete", status === "complete");
  card.classList.toggle("attention", status === "attention");
  if (isCurrent) card.setAttribute("aria-current", "step");
  else card.removeAttribute("aria-current");
  setNodeText(`#overview-${id}-state`, text);
}

function updateWorkbenchOverview() {
  const setup = materialSetupState();
  const transcriptLength = $("#transcript-text").value.trim().length;
  const manifest = state.processingManifest;
  const analysis = state.analysis;
  const progress = manifest ? transcodeProgress(manifest.tasks) : null;
  const model = buildWorkbenchOverview({
    entryMode: state.entryMode,
    filesCount: state.files.length,
    sourceReady: setup.ready,
    missingSourceField: setup.missingField,
    processing: progress,
    processingPrepared: state.processingPrepared,
    transcriptLength,
    analysis: analysis?.summary || null,
    selectedRecommendationCount: state.selectedRecommendationIds.size,
    revisionDraft: state.revisionDraft,
    revisionConfirmed: state.revisionConfirmed,
    handoffState: state.handoffState
  });
  state.flowModel = model;
  for (const [id, step] of Object.entries(model.steps)) setOverviewStep(id, step.status, step.text, model.current === id);
  setNodeText("#workbench-overview-summary", model.summary);
  setNodeText("#workbench-entry-note", model.entryNotice);
  const phaseNode = $("#workbench-flow-state");
  setNodeText("#workbench-flow-state", model.phase.label);
  phaseNode.dataset.tone = model.phase.tone;
  setNodeText("#workbench-next-hint", model.phase.guidance);
  setNodeText("#workbench-progress-label", `${model.phase.progress}%`);
  $("#workbench-progress-bar").style.width = `${model.phase.progress}%`;
  const progressNode = $("#workbench-progress");
  progressNode.setAttribute("aria-valuenow", String(model.phase.progress));
  progressNode.setAttribute("aria-valuetext", `${model.phase.label}，完成 ${model.phase.progress}%`);
  const nextButton = $("#workbench-next-step");
  nextButton.dataset.action = model.next.type;
  nextButton.dataset.target = model.next.target;
  nextButton.dataset.focus = model.next.focus;
  nextButton.dataset.control = model.next.control;
  nextButton.textContent = model.next.label;
  nextButton.disabled = Boolean(model.next.disabled);
  $("#workbench-paste-entry").hidden = state.entryMode !== "transcript" || transcriptLength > 0;
}

function moveToFlowTarget(targetId, focusId) {
  const section = document.getElementById(targetId);
  const focusTarget = document.getElementById(focusId);
  window.requestAnimationFrame(() => {
    const target = focusTarget || section;
    focusTarget?.focus();
    target?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: focusTarget ? "center" : "start"
    });
  });
}

$("#workbench-next-step").addEventListener("click", async () => {
  const action = state.flowModel?.next;
  if (!action) return;
  setFlowFeedback();
  if (action.type === "focus") {
    moveToFlowTarget(action.target, action.focus);
    return;
  }
  if (action.type === "open-sidepanel") {
    const opened = await openAnalysisHandoffSidePanel(chrome.sidePanel, chrome.windows);
    setFlowFeedback(opened.opened
      ? { status: "编导台侧边栏已打开；请预览并确认待处理结果。" }
      : { error: opened.reason });
    moveToFlowTarget(action.target, action.focus);
    return;
  }
  const control = document.getElementById(action.control);
  if (!control) {
    setFlowFeedback({ error: "当前下一步控件不可用；页面状态未丢失，请重新加载扩展后重试。" });
    return;
  }
  control.click();
  moveToFlowTarget(action.target, action.focus);
});

function selectEntryMode(mode) {
  state.entryMode = mode;
  for (const input of document.querySelectorAll('input[name="workbench-entry-mode"]')) input.checked = input.value === mode;
}

document.querySelectorAll('input[name="workbench-entry-mode"]').forEach((input) => {
  input.addEventListener("change", (event) => {
    if (!event.target.checked) return;
    const previous = state.entryMode;
    selectEntryMode(event.target.value);
    const preserved = [];
    if (state.files.length) preserved.push(`${state.files.length} 个视频选择`);
    if (state.processingManifest) preserved.push("处理任务");
    if ($("#transcript-text").value.trim()) preserved.push("转写正文");
    if (state.analysis) preserved.push("分析结果");
    if (state.revisionDraft) preserved.push("可拍任务草稿");
    const label = state.entryMode === "transcript" ? "分析已有转写" : "处理本地视频";
    setFlowFeedback({
      status: `${previous ? "已切换" : "已选择"}“${label}”入口。${preserved.length ? `已保留当前${preserved.join("、")}；顶部会优先遵循已完成的真实状态。` : "没有读取、上传或清空任何内容。"}`
    });
    updateWorkbenchOverview();
  });
});

$("#workbench-paste-entry").addEventListener("click", () => {
  selectEntryMode("transcript");
  setFlowFeedback({ status: "已定位到转写粘贴区；文本只在当前工作台页面中处理。" });
  updateWorkbenchOverview();
  moveToFlowTarget("transcription", "transcript-text");
});

function workbenchResetSnapshot() {
  const hasSetupValues = Boolean(
    $("#material-source-root").value.trim()
    || $("#material-output-root").value.trim()
    || $("#douyin-source-note").value.trim()
    || $("#material-authorization").checked
    || !["", "ffmpeg"].includes($("#material-ffmpeg-path").value.trim())
    || $("#transcription-mode").value !== "text_import"
    || $("#transcription-language").value !== "zh"
    || $("#whisper-executable").value.trim()
    || $("#whisper-model").value.trim()
  );
  const feedbackSelectors = [
    "#workbench-flow-error",
    "#source-message", "#source-error",
    "#processing-message", "#processing-error",
    "#transcription-message", "#transcription-error",
    "#structure-message", "#structure-error"
  ];
  return {
    entryMode: state.entryMode,
    filesCount: state.files.length,
    processingTaskCount: state.processingManifest?.tasks?.length || 0,
    processingExported: state.processingExported,
    transcriptionTaskCount: state.transcriptionPlan?.tasks?.length || 0,
    transcriptionExported: state.transcriptionExported,
    transcriptLength: $("#transcript-text").value.trim().length,
    hasAnalysis: Boolean(state.analysis),
    analysisPreserved: state.analysisPreserved,
    hasRevisionDraft: Boolean(state.revisionDraft),
    revisionPreserved: state.revisionPreserved,
    handoffState: state.handoffState,
    hasSetupValues,
    hasFeedback: feedbackSelectors.some((selector) => $(selector).textContent.trim())
  };
}

function resetWorkbenchSession() {
  state.entryMode = "";
  state.files = [];
  state.processingManifest = null;
  state.processingPrepared = false;
  state.processingExported = false;
  state.transcriptionPlan = null;
  state.transcriptionExported = false;
  state.transcriptSourceName = "手动粘贴文本";
  state.transcriptDocument = null;
  state.timingInvalidated = false;
  state.analysis = null;
  state.analysisPreserved = false;
  state.revisionRecommendations = [];
  state.selectedRecommendationIds = new Set();
  state.revisionDraft = null;
  state.revisionPreserved = false;
  state.revisionConfirmed = false;
  state.analysisHandoffCache = null;
  state.handoffState = "idle";
  state.flowModel = null;

  for (const input of document.querySelectorAll('input[type="file"]')) input.value = "";
  selectEntryMode("");
  $("#material-source-root").value = "";
  $("#material-output-root").value = "";
  $("#material-ffmpeg-path").value = "ffmpeg";
  $("#material-authorization").checked = false;
  $("#douyin-source-note").value = "";
  $("#transcription-mode").value = "text_import";
  $("#transcription-language").value = "zh";
  $("#whisper-executable").value = "";
  $("#whisper-model").value = "";
  $("#transcript-text").value = "";
  $("#revision-parent-version").value = "";

  $("#processing-queue").hidden = true;
  $("#processing-task-list").replaceChildren();
  $("#create-material-tasks").setAttribute("aria-expanded", "false");
  setNodeText("#processing-progress-label", "0 / 0");
  setNodeText("#processing-queue-status", "浏览器仅生成任务；请在本机运行执行器后导入结果。");
  $("#processing-progress-bar").style.width = "0%";
  const processingProgress = $("#processing-progress");
  processingProgress.setAttribute("aria-valuemax", "0");
  processingProgress.setAttribute("aria-valuenow", "0");
  processingProgress.setAttribute("aria-valuetext", "尚未生成任务");

  $("#whisper-config").hidden = true;
  $("#transcription-mode").setAttribute("aria-expanded", "false");
  $("#transcription-language").disabled = true;
  $("#transcription-plan-actions").hidden = true;
  $("#structure-result").hidden = true;
  $("#analyze-transcript").setAttribute("aria-expanded", "false");
  setNodeText("#structure-score", "0%");
  setNodeText("#structure-summary", "—");
  $("#coverage-grid").replaceChildren();
  $("#structure-segments").replaceChildren();
  $("#structure-recommendations").replaceChildren();
  setNodeText("#structure-disclaimer", "");
  renderRevisionRecommendations();
  $("#revision-draft").hidden = true;
  $("#revision-evidence").replaceChildren();
  for (const field of document.querySelectorAll("[data-revision-field]")) field.value = "";
  $("#confirm-revision-draft").checked = false;
  $("#send-analysis-handoff").disabled = true;
  $("#export-analysis-handoff").disabled = true;
  $("#generate-revision-draft").disabled = true;
  setNodeText("#revision-test-id", "—");
  setNodeText("#revision-source-analysis-id", "—");
  setNodeText("#revision-primary-variable", "—");
  setNodeText("#revision-notice", "");
  setFeedback("#revision-selection-message", "#revision-selection-error");

  for (const [statusSelector, errorSelector] of [
    ["#source-message", "#source-error"],
    ["#processing-message", "#processing-error"],
    ["#transcription-message", "#transcription-error"],
    ["#structure-message", "#structure-error"]
  ]) setFeedback(statusSelector, errorSelector);
  setFlowFeedback();

  renderMaterialSelection();
  updateTranscriptionReadiness();
  setStatus("#processing-status", "尚未生成");
  setStatus("#transcript-status", "等待文本");
  setStatus("#structure-status", "尚未分析");
  updateWorkbenchOverview();
  setFlowFeedback({ status: "已开始新一轮；只清空了当前工作台页面内存，原始文件、侧边栏和浏览器本地工作区均未修改。" });
  moveToFlowTarget("", "workbench-entry-video");
}

$("#reset-workbench-session").addEventListener("click", () => {
  const resetPlan = buildWorkbenchResetPrompt(workbenchResetSnapshot());
  if (!resetPlan.hasWork) {
    setFlowFeedback({ status: "当前已经是新一轮的初始状态；请选择视频或已有转写入口。" });
    moveToFlowTarget("", "workbench-entry-video");
    return;
  }
  if (!window.confirm(resetPlan.message)) return;
  resetWorkbenchSession();
});

document.querySelectorAll("label.file-card[for]").forEach((trigger) => {
  trigger.id ||= `${trigger.htmlFor}-trigger`;
  trigger.tabIndex = 0;
  trigger.setAttribute("role", "button");
  trigger.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    document.getElementById(trigger.htmlFor)?.click();
  });
});

function fileIdentity(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

function invalidateProcessing(message = "文件或参数已变化，请重新生成任务。") {
  const hadManifest = Boolean(state.processingManifest);
  state.processingManifest = null;
  state.processingPrepared = false;
  state.processingExported = false;
  state.transcriptionPlan = null;
  state.transcriptionExported = false;
  $("#processing-queue").hidden = true;
  $("#create-material-tasks").setAttribute("aria-expanded", "false");
  $("#transcription-plan-actions").hidden = true;
  if (hadManifest) {
    setStatus("#processing-status", "需要重新生成");
    setFeedback("#processing-message", "#processing-error", { status: message });
  }
  updateMaterialReadiness();
  updateTranscriptionReadiness();
}

function renderMaterialSelection() {
  const count = state.files.length;
  const totalBytes = state.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  setNodeText("#material-file-label", count
    ? `已选择 ${count} 个本地视频 · ${formatLocalBytes(totalBytes)}`
    : "最多 40 个视频、单文件 10 GB、合计 40 GB");
  setStatus("#source-status", count ? `${count} 个本地视频` : "未选择", count > 0);
  const list = $("#material-selection-list");
  list.replaceChildren();
  for (const file of state.files) {
    const row = element("div", "operation-item");
    row.append(element("span", "", file.webkitRelativePath || file.name), element("strong", "", `${formatLocalBytes(file.size)} · 已选择`));
    list.append(row);
  }
  if (!count) list.append(element("p", "empty-inline", "尚未选择视频。工作台不会自动读取本地目录。"));
  $("#clear-material-selection").disabled = !count;
  updateMaterialReadiness();
}

function updateMaterialReadiness() {
  const setup = materialSetupState();
  const missing = [];
  if (!setup.hasFiles) missing.push("选择至少一个视频");
  if (!setup.authorized) missing.push("确认素材授权");
  if (!setup.hasSourceRoot) missing.push("填写自有原片根目录");
  if (!setup.hasOutputRoot) missing.push("填写处理输出目录");
  if (!setup.hasFfmpeg) missing.push("填写 FFmpeg 路径");
  let validationError = setup.sourceNoteError;
  if (state.files.length) {
    try {
      validateLocalVideoBatch(state.files, MATERIAL_VIDEO_BATCH_LIMITS);
    } catch (error) {
      validationError = error.message || "当前选择超过本地处理保护上限";
    }
  }
  const reason = validationError || (missing.length
    ? `还需：${missing.join("、")}。`
    : "已就绪：点击后只生成本机待执行任务，不会在浏览器中运行 FFmpeg。");
  $("#create-material-tasks").disabled = Boolean(validationError) || missing.length > 0;
  setNodeText("#material-readiness", reason);
  updateWorkbenchOverview();
}

$("#material-video-files").addEventListener("change", (event) => {
  const incoming = [...event.target.files];
  event.target.value = "";
  if (!incoming.length) return;
  const unsupported = incoming.filter((file) => !isSupportedVideoFile(file));
  if (unsupported.length) {
    const message = `所选内容包含 ${unsupported.length} 个不支持的文件，本次没有加入任何文件。`;
    setFeedback("#source-message", "#source-error", { error: message });
    setFlowFeedback({ error: message });
    return;
  }
  const known = new Set(state.files.map(fileIdentity));
  const nextFiles = [...state.files];
  for (const file of incoming) {
    if (!known.has(fileIdentity(file))) {
      known.add(fileIdentity(file));
      nextFiles.push(file);
    }
  }
  try {
    validateLocalVideoBatch(nextFiles, MATERIAL_VIDEO_BATCH_LIMITS);
  } catch (error) {
    const message = error.message || "所选视频超过本地处理保护上限";
    setFeedback("#source-message", "#source-error", { error: message });
    setFlowFeedback({ error: message });
    return;
  }
  const added = nextFiles.length - state.files.length;
  selectEntryMode("video");
  state.files = nextFiles;
  invalidateProcessing();
  renderMaterialSelection();
  const message = added ? `${added} 个视频已加入当前选择。` : "所选视频已在当前选择中，没有重复加入。";
  setFeedback("#source-message", "#source-error", { status: message });
  setFlowFeedback({ status: `${message} 请按顶部主操作继续。` });
});

$("#clear-material-selection").addEventListener("click", () => {
  if (!state.files.length || !window.confirm("将清空当前浏览器会话中的视频选择，并使已生成的处理清单失效。原始文件不会被删除。是否继续？")) {
    setFeedback("#source-message", "#source-error", { status: "已取消清空，当前文件选择保持不变。" });
    return;
  }
  state.files = [];
  invalidateProcessing("当前文件选择已清空，旧任务清单已失效。");
  renderMaterialSelection();
  setFeedback("#source-message", "#source-error", { status: "当前浏览器会话中的文件选择已清空；原始文件未被修改。" });
  setFlowFeedback({ status: "素材选择已清空；原始文件未被修改。" });
});

for (const id of ["material-source-root", "material-output-root", "material-ffmpeg-path", "material-authorization", "douyin-source-note"]) {
  $(`#${id}`).addEventListener("input", () => {
    setFlowFeedback();
    invalidateProcessing();
    updateMaterialReadiness();
  });
}

$("#open-source-note").addEventListener("click", () => {
  setFeedback("#source-message", "#source-error");
  try {
    const note = validateDouyinSourceNote($("#douyin-source-note").value);
    if (!note) throw new Error("请先填写抖音原页链接");
    const opened = window.open(note.url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    setFeedback("#source-message", "#source-error", { status: "已按原地址打开新标签页；扩展未请求或解析链接内容。" });
  } catch (error) {
    setFeedback("#source-message", "#source-error", { error: error.message || "无法打开来源链接" });
  }
});

function processingSettings() {
  return {
    authorizationConfirmed: $("#material-authorization").checked,
    sourceRoot: $("#material-source-root").value,
    outputRoot: $("#material-output-root").value,
    ffmpegExecutable: $("#material-ffmpeg-path").value,
    sourceNote: $("#douyin-source-note").value,
    outputSuffix: "_analysis",
    preset: "balanced",
    resolution: "1080p",
    frameRate: "keep",
    sampleRate: "48000"
  };
}

function renderProcessingQueue() {
  const manifest = state.processingManifest;
  if (!manifest) {
    $("#processing-queue").hidden = true;
    $("#create-material-tasks").setAttribute("aria-expanded", "false");
    updateWorkbenchOverview();
    return;
  }
  const progress = transcodeProgress(manifest.tasks);
  setNodeText("#processing-progress-label", `${progress.finished}/${progress.total} 已结束 · ${progress.completed} 成功 · ${progress.failed} 失败 · ${progress.skipped} 跳过`);
  $("#processing-progress-bar").style.width = `${progress.percent}%`;
  const progressNode = $("#processing-progress");
  progressNode.setAttribute("aria-valuemax", String(progress.total));
  progressNode.setAttribute("aria-valuenow", String(progress.finished));
  progressNode.setAttribute("aria-valuetext", `${progress.finished}/${progress.total} 已结束，${progress.completed} 成功，${progress.failed} 失败，${progress.skipped} 跳过`);
  setNodeText("#processing-queue-status", progress.finished === 0
    ? `浏览器已生成 ${progress.total} 个待执行任务，但尚未运行 FFmpeg；请在本机执行后导入结果。`
    : progress.finished < progress.total
    ? `已导入部分结果；还有 ${progress.total - progress.finished} 个任务未结束。`
    : progress.failed || progress.skipped
    ? `本轮结果已全部导入，其中 ${progress.failed} 个失败、${progress.skipped} 个跳过。`
    : "本轮执行结果已全部导入，所有任务完成。");
  const list = $("#processing-task-list");
  list.replaceChildren();
  for (const task of manifest.tasks) {
    const card = element("article", "task");
    const head = element("div", "task-head");
    head.append(
      element("strong", "", task.source.name),
      element("span", "", task.operation === "extract_audio" ? "提取 16 kHz WAV" : "标准化 MP4")
    );
    card.append(head, element("p", "", task.outputPath));
    if (task.status === "failed") {
      const failure = element("p", "failed", task.failureReason || "本地 FFmpeg 执行失败");
      failure.setAttribute("role", "alert");
      card.append(failure);
    }
    list.append(card);
  }
  if (!manifest.tasks.length) list.append(element("p", "empty-inline", "当前任务清单为空，请重新选择视频并生成。"));
  $("#processing-queue").hidden = false;
  $("#create-material-tasks").setAttribute("aria-expanded", "true");
  setStatus("#processing-status", progress.finished ? `${progress.completed}/${progress.total} 完成` : `${progress.total} 个任务待执行`, progress.completed === progress.total);
  updateWorkbenchOverview();
}

$("#create-material-tasks").addEventListener("click", () => {
  setFeedback("#source-message", "#source-error");
  setFeedback("#processing-message", "#processing-error");
  try {
    selectEntryMode("video");
    state.processingManifest = createMaterialProcessingManifest(state.files, processingSettings(), { creatorVersion: VERSION });
    state.processingPrepared = false;
    state.processingExported = false;
    state.transcriptionPlan = null;
    state.transcriptionExported = false;
    $("#transcription-plan-actions").hidden = true;
    renderProcessingQueue();
    setFeedback("#processing-message", "#processing-error", { status: `已生成 ${state.processingManifest.tasks.length} 个本机待执行任务；浏览器尚未运行任何程序，也未上传文件。` });
    setFlowFeedback({ status: `已生成 ${state.processingManifest.tasks.length} 个受限任务；下一步请导出执行清单。` });
    updateTranscriptionReadiness();
  } catch (error) {
    state.processingManifest = null;
    state.processingPrepared = false;
    state.processingExported = false;
    renderProcessingQueue();
    const message = error.message || "无法生成本地处理任务";
    setFeedback("#processing-message", "#processing-error", { error: message });
    setFlowFeedback({ error: `${message}；已保留素材选择和参数，可修正后重试。` });
    updateTranscriptionReadiness();
  }
});

$("#copy-material-commands").addEventListener("click", async () => {
  if (!state.processingManifest) return;
  try {
    await navigator.clipboard.writeText(state.processingManifest.tasks.map((task) => task.powerShellCommand).join("\r\n\r\n"));
    state.processingPrepared = true;
    setFeedback("#processing-message", "#processing-error", { status: "固定参数的本地 FFmpeg 命令已复制；执行前请再次核对路径。" });
    setFlowFeedback({ status: "本机命令已复制；执行完成后按顶部主操作导入结果。" });
    updateWorkbenchOverview();
  } catch {
    setFeedback("#processing-message", "#processing-error", { error: "复制失败，请改为导出任务清单并使用开源执行器。" });
    setFlowFeedback({ error: "复制失败；任务仍保留，请改为导出任务清单。" });
  }
});

$("#export-material-manifest").addEventListener("click", () => {
  if (!state.processingManifest) return;
  download("qianchuan-material-analysis-tasks.json", JSON.stringify(state.processingManifest, null, 2));
  state.processingPrepared = true;
  state.processingExported = true;
  setFeedback("#processing-message", "#processing-error", { status: "任务清单已导出；其中包含本机路径，请仅在可信设备保存。" });
  setFlowFeedback({ status: "执行清单已导出；请在本机完成处理后按顶部主操作导入结果。" });
  updateWorkbenchOverview();
});

$("#download-material-worker").addEventListener("click", async () => {
  try {
    download("transcode-worker.ps1", await readPackagedText("tools/transcode-worker.ps1"), "text/plain;charset=utf-8");
    setFeedback("#processing-message", "#processing-error", { status: "已下载开源本地执行器，可先打开审计源码再运行。" });
  } catch (error) {
    setFeedback("#processing-message", "#processing-error", { error: error.message || "执行器下载失败" });
  }
});

$("#import-material-result").addEventListener("click", () => $("#material-result-file").click());
$("#material-result-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.processingManifest) return;
  try {
    validateNonMediaImport(file, "executionResult");
    const results = validateTranscodeResult(parseJsonDocument(await file.text(), "本机执行结果"), state.processingManifest);
    const byId = new Map(results.map((result) => [result.id, result]));
    state.processingManifest.tasks = state.processingManifest.tasks.map((task) => ({ ...task, ...(byId.get(task.id) || {}) }));
    state.processingExported = false;
    renderProcessingQueue();
    const progress = transcodeProgress(state.processingManifest.tasks);
    const feedback = progress.failed || progress.skipped
      ? { error: `已导入：${progress.completed} 成功，${progress.failed} 失败，${progress.skipped} 跳过；异常原因显示在任务下方。` }
      : { status: `已导入：${progress.completed} 个任务完成。` };
    setFeedback("#processing-message", "#processing-error", feedback);
    setFlowFeedback(progress.failed || progress.skipped
      ? { error: `处理结果有 ${progress.failed + progress.skipped} 项异常；任务未丢失，可修正后重新导入。` }
      : progress.completed === progress.total
        ? { status: "本机处理已全部完成；下一步导入转写文本。" }
        : { status: `已导入 ${progress.finished}/${progress.total} 项结果；请继续完成并导入剩余结果。` });
  } catch (error) {
    const message = error.message || "执行结果无法导入";
    setFeedback("#processing-message", "#processing-error", { error: message });
    setFlowFeedback({ error: `${message}；当前任务清单和已导入状态保持不变。` });
  }
});

function updateTranscriptionReadiness() {
  const localEngine = $("#transcription-mode").value === "whisper_cpp";
  const missing = [];
  if (!state.processingManifest) missing.push("先生成素材处理任务");
  if (!$("#whisper-executable").value.trim()) missing.push("填写 whisper-cli 路径");
  if (!$("#whisper-model").value.trim()) missing.push("填写本地模型路径");
  $("#create-transcription-plan").disabled = !localEngine || missing.length > 0;
  setNodeText("#transcription-readiness", missing.length
    ? `还需：${missing.join("、")}。`
    : "已就绪：只生成固定参数的本机转写任务，不会连接云端服务。");
  updateWorkbenchOverview();
}

function invalidateTranscriptionPlan() {
  state.transcriptionExported = false;
  if (state.transcriptionPlan) {
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    setFeedback("#transcription-message", "#transcription-error", { status: "本地引擎参数已改变，旧转写清单已失效。" });
  }
  updateTranscriptionReadiness();
}

function syncTranscriptionMode({ announce = true } = {}) {
  const localEngine = $("#transcription-mode").value === "whisper_cpp";
  $("#whisper-config").hidden = !localEngine;
  $("#transcription-mode").setAttribute("aria-expanded", String(localEngine));
  $("#transcription-language").disabled = !localEngine;
  if (!localEngine) {
    state.transcriptionPlan = null;
    state.transcriptionExported = false;
    $("#transcription-plan-actions").hidden = true;
    setFeedback("#transcription-message", "#transcription-error", announce
      ? { status: "可直接导入或粘贴本机生成的文本，不需要配置执行引擎。" }
      : {});
  } else {
    setFeedback("#transcription-message", "#transcription-error");
  }
  updateTranscriptionReadiness();
}
$("#transcription-mode").addEventListener("change", () => syncTranscriptionMode());
for (const id of ["whisper-executable", "whisper-model", "transcription-language"]) {
  $(`#${id}`).addEventListener("input", invalidateTranscriptionPlan);
}
syncTranscriptionMode({ announce: false });

$("#create-transcription-plan").addEventListener("click", () => {
  setFeedback("#transcription-message", "#transcription-error");
  try {
    state.transcriptionPlan = createLocalTranscriptionPlan(state.processingManifest, {
      mode: "whisper_cpp",
      executable: $("#whisper-executable").value,
      modelPath: $("#whisper-model").value,
      language: $("#transcription-language").value
    });
    state.transcriptionExported = false;
    $("#transcription-plan-actions").hidden = false;
    setFeedback("#transcription-message", "#transcription-error", { status: `已生成 ${state.transcriptionPlan.tasks.length} 个固定参数本机转写任务；请在音频提取完成后执行。` });
  } catch (error) {
    state.transcriptionPlan = null;
    state.transcriptionExported = false;
    $("#transcription-plan-actions").hidden = true;
    setFeedback("#transcription-message", "#transcription-error", { error: error.message || "无法生成本地转写任务" });
  }
});

$("#copy-transcription-commands").addEventListener("click", async () => {
  if (!state.transcriptionPlan) return;
  try {
    await navigator.clipboard.writeText(state.transcriptionPlan.tasks.map((task) => task.command).join("\r\n\r\n"));
    setFeedback("#transcription-message", "#transcription-error", { status: "本机 whisper.cpp 固定参数命令已复制。" });
  } catch {
    setFeedback("#transcription-message", "#transcription-error", { error: "复制失败，请导出本地转写清单。" });
  }
});

$("#export-transcription-plan").addEventListener("click", () => {
  if (!state.transcriptionPlan) return;
  download("qianchuan-local-transcription-tasks.json", JSON.stringify(state.transcriptionPlan, null, 2));
  state.transcriptionExported = true;
  setFeedback("#transcription-message", "#transcription-error", { status: "本地转写任务清单已导出；其中包含本机路径，请仅在可信设备保存。" });
});

function setRevisionConfirmation(confirmed) {
  state.revisionConfirmed = Boolean(confirmed && state.revisionDraft);
  $("#confirm-revision-draft").checked = state.revisionConfirmed;
  $("#send-analysis-handoff").disabled = !state.revisionConfirmed;
  $("#export-analysis-handoff").disabled = !state.revisionConfirmed;
}

function clearRevisionDraft({ clearSelection = false } = {}) {
  state.revisionDraft = null;
  state.revisionPreserved = false;
  state.analysisHandoffCache = null;
  state.handoffState = "idle";
  if (clearSelection) state.selectedRecommendationIds = new Set();
  setRevisionConfirmation(false);
  $("#revision-draft").hidden = true;
  $("#revision-evidence").replaceChildren();
  for (const field of document.querySelectorAll("[data-revision-field]")) field.value = "";
  setNodeText("#revision-test-id", "—");
  setNodeText("#revision-source-analysis-id", "—");
  setNodeText("#revision-primary-variable", "—");
  setNodeText("#revision-notice", "");
}

function invalidateTranscriptAnalysis(message) {
  const hadAnalysis = Boolean(state.analysis);
  state.analysis = null;
  state.analysisPreserved = false;
  state.revisionRecommendations = [];
  clearRevisionDraft({ clearSelection: true });
  $("#revision-parent-version").value = "";
  $("#structure-result").hidden = true;
  $("#analyze-transcript").setAttribute("aria-expanded", "false");
  setStatus("#structure-status", hadAnalysis ? "需要重新分析" : "尚未分析");
  if (message) setFeedback("#structure-message", "#structure-error", { status: message });
}

function segmentSourceLabel(segment) {
  if (segment?.source?.start) {
    return `${segment.source.start} → ${segment.source.end}${segment.source.label ? ` · ${segment.source.label}` : ""}`;
  }
  return `段落 ${segment?.source?.cueIndex || segment?.index || 1}`;
}

function renderRevisionRecommendations() {
  const fieldset = $("#revision-recommendations");
  fieldset.replaceChildren();
  const legend = element("legend", "", "选择一项改进建议（必选）");
  fieldset.append(legend);
  if (!state.revisionRecommendations.length) {
    fieldset.append(element("p", "empty-inline", "完成结构分析后，将在这里显示可选择的单变量改进建议。"));
    $("#generate-revision-draft").disabled = true;
    return;
  }
  for (const recommendation of state.revisionRecommendations) {
    const option = element("label", "revision-option");
    const input = element("input");
    input.type = "radio";
    input.name = "revision-recommendation";
    input.value = recommendation.id;
    input.checked = state.selectedRecommendationIds.has(recommendation.id);
    const sourceLabels = recommendation.evidenceSegmentIndexes
      .map((index) => state.analysis?.segments?.[index - 1])
      .filter(Boolean)
      .map(segmentSourceLabel);
    option.append(
      input,
      element("strong", "", `${recommendation.label} · 唯一变量`),
      element("span", "", recommendation.advice),
      element("small", "", sourceLabels.length ? `分析来源：${sourceLabels.join("；")}` : "分析来源：当前文本规则提示")
    );
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const changed = !state.selectedRecommendationIds.has(recommendation.id);
      state.selectedRecommendationIds = new Set([recommendation.id]);
      if (changed && state.revisionDraft) clearRevisionDraft();
      for (const radio of fieldset.querySelectorAll('input[type="radio"]')) radio.checked = radio === input;
      $("#generate-revision-draft").disabled = false;
      setFeedback("#revision-selection-message", "#revision-selection-error", {
        status: `已选择“${recommendation.label}”作为唯一测试变量；现在可以生成草稿。`
      });
      updateWorkbenchOverview();
    });
    fieldset.append(option);
  }
  $("#generate-revision-draft").disabled = state.selectedRecommendationIds.size < 1;
}

function renderRevisionDraft(draft) {
  setNodeText("#revision-test-id", draft.testId);
  setNodeText("#revision-source-analysis-id", draft.sourceAnalysisId);
  setNodeText("#revision-primary-variable", draft.primaryVariable.label);
  setNodeText("#revision-notice", draft.notice);
  for (const field of CREATIVE_REVISION_EDITABLE_FIELDS) {
    const control = document.querySelector(`[data-revision-field="${field}"]`);
    if (control) control.value = draft[field];
  }
  const evidence = $("#revision-evidence");
  evidence.replaceChildren();
  for (const item of draft.evidence) {
    const card = element("article");
    card.append(element("strong", "", `分析证据 · ${item.sourceLabel}`), element("p", "", item.excerpt));
    evidence.append(card);
  }
  setRevisionConfirmation(false);
  $("#revision-draft").hidden = false;
}

function currentRevisionDraft() {
  if (!state.revisionDraft) throw new Error("请先生成下一版可拍任务草稿");
  const edits = Object.fromEntries(CREATIVE_REVISION_EDITABLE_FIELDS.map((field) => {
    const control = document.querySelector(`[data-revision-field="${field}"]`);
    return [field, control?.value || ""];
  }));
  if (CREATIVE_REVISION_EDITABLE_FIELDS.some((field) => edits[field] !== state.revisionDraft[field])) {
    state.revisionDraft = creativeRevisionWithEdits(state.revisionDraft, edits);
  }
  return state.revisionDraft;
}

$("#transcript-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    validateNonMediaImport(file, "transcript");
    const transcriptDocument = parseTranscriptDocument(await file.text(), { name: file.name });
    const text = transcriptDocument.text;
    selectEntryMode("transcript");
    $("#transcript-text").value = text;
    state.transcriptSourceName = file.name;
    state.transcriptDocument = transcriptDocument;
    state.timingInvalidated = false;
    setStatus("#transcript-status", `${text.length.toLocaleString("zh-CN")} 字符`, true);
    invalidateTranscriptAnalysis();
    const mapping = transcriptDocument.hasTiming ? `${transcriptDocument.cues.length} 个时间段已保留` : `${transcriptDocument.cues.length} 个文本段落已建立`;
    setFeedback("#transcription-message", "#transcription-error", { status: `文本已在本地读取；${mapping}，分析时会显示来源。` });
    setFlowFeedback({ status: "转写文本已在本地读取；下一步分析文案结构。" });
    updateWorkbenchOverview();
  } catch (error) {
    const message = error.message || "无法读取转写文本";
    setFeedback("#transcription-message", "#transcription-error", { error: message });
    setFlowFeedback({ error: `${message}；当前处理任务和已有文本保持不变。` });
  }
});

$("#transcript-text").addEventListener("input", (event) => {
  const length = event.target.value.trim().length;
  if (length) {
    selectEntryMode("transcript");
  }
  let timingMessage = "";
  if (state.transcriptDocument && !transcriptDocumentMatchesText(state.transcriptDocument, event.target.value)) {
    state.transcriptDocument = null;
    state.timingInvalidated = true;
    timingMessage = "正文已手动编辑，旧时间码或段落映射已失效；当前分析将按新文本段落重新建立来源。";
  }
  state.transcriptSourceName = "手动粘贴文本";
  setStatus("#transcript-status", length ? `${length.toLocaleString("zh-CN")} 字符` : "等待文本", length > 0);
  invalidateTranscriptAnalysis(timingMessage || "转写正文已改变，旧结构分析与可拍草稿已失效。");
  if (timingMessage) setFeedback("#transcription-message", "#transcription-error", { status: timingMessage });
  updateWorkbenchOverview();
});

function renderStructureAnalysis(result) {
  $("#structure-score").textContent = `${result.summary.structureCoveragePercent}%`;
  $("#structure-summary").textContent = `${result.summary.segments} 个片段 · ${result.summary.characters.toLocaleString("zh-CN")} 字符`;
  const coverageGrid = $("#coverage-grid");
  coverageGrid.replaceChildren();
  for (const item of Object.values(result.coverage)) {
    const card = element("article", `coverage${item.present ? " present" : ""}`);
    card.append(element("strong", "", `${item.present ? "✓" : "○"} ${item.label}`), element("span", "", item.present ? `${item.count} 个命中片段` : "尚未识别"));
    coverageGrid.append(card);
  }
  const segmentList = $("#structure-segments");
  segmentList.replaceChildren();
  for (const segment of result.segments.slice(0, 200)) {
    const card = element("article", "segment");
    card.append(element("small", "segment-source", `${segment.index}. ${segmentSourceLabel(segment)}`));
    card.append(element("p", "", segment.content));
    if (segment.tags.length) {
      const tags = element("div", "tags");
      for (const id of segment.tags) tags.append(element("span", "", result.coverage[id].label));
      card.append(tags);
    }
    segmentList.append(card);
  }
  state.revisionRecommendations = revisionRecommendationsForAnalysis(result);
  state.selectedRecommendationIds = new Set();
  clearRevisionDraft();
  renderRevisionRecommendations();
  setFeedback("#revision-selection-message", "#revision-selection-error");
  if (result.segments.length > 200) segmentList.append(element("p", "help", `页面只预览前 200 段；导出文件包含全部 ${result.segments.length} 段。`));
  const recommendations = $("#structure-recommendations");
  recommendations.replaceChildren();
  for (const item of result.recommendations) {
    const card = element("article");
    card.append(element("strong", "", `${item.label}：`), document.createTextNode(item.advice));
    recommendations.append(card);
  }
  $("#structure-disclaimer").textContent = result.disclaimer;
  $("#structure-result").hidden = false;
  $("#analyze-transcript").setAttribute("aria-expanded", "true");
  setStatus("#structure-status", `覆盖 ${result.summary.coveredStructures}/${result.summary.totalStructures}`, true);
  updateWorkbenchOverview();
}

$("#analyze-transcript").addEventListener("click", () => {
  setFeedback("#structure-message", "#structure-error");
  try {
    state.analysis = analyzeTranscriptStructure($("#transcript-text").value, {
      sourceName: state.transcriptSourceName,
      transcriptDocument: state.transcriptDocument
    });
    state.analysisPreserved = false;
    state.analysisHandoffCache = null;
    state.handoffState = "idle";
    renderStructureAnalysis(state.analysis);
    setFeedback("#structure-message", "#structure-error", { status: "结构分析已在浏览器本地完成；结果来自确定性规则，不代表投放效果预测。" });
    setFlowFeedback({ status: "结构分析已完成；下一步选择一项改进建议，生成单变量可拍草稿。" });
  } catch (error) {
    state.analysis = null;
    state.analysisPreserved = false;
    state.revisionRecommendations = [];
    state.selectedRecommendationIds = new Set();
    state.revisionDraft = null;
    state.revisionPreserved = false;
    state.revisionConfirmed = false;
    state.analysisHandoffCache = null;
    state.handoffState = "idle";
    $("#structure-result").hidden = true;
    $("#analyze-transcript").setAttribute("aria-expanded", "false");
    setStatus("#structure-status", "尚未分析");
    const message = error.message || "无法分析转写文本";
    setFeedback("#structure-message", "#structure-error", { error: message });
    setFlowFeedback({ error: `${message}；转写正文仍保留，可修正后重试。` });
    updateWorkbenchOverview();
  }
});

$("#export-structure-json").addEventListener("click", () => {
  if (state.analysis) {
    download("qianchuan-material-structure.json", JSON.stringify(state.analysis, null, 2));
    state.analysisPreserved = true;
    setFeedback("#structure-message", "#structure-error", { status: "JSON 结构分析已导出。" });
  }
});
$("#export-structure-md").addEventListener("click", () => {
  if (state.analysis) {
    download("qianchuan-material-structure.md", materialAnalysisToMarkdown(state.analysis), "text/markdown;charset=utf-8");
    state.analysisPreserved = true;
    setFeedback("#structure-message", "#structure-error", { status: "Markdown 结构分析已导出。" });
  }
});

$("#generate-revision-draft").addEventListener("click", () => {
  setFeedback("#revision-selection-message", "#revision-selection-error");
  try {
    if (!state.analysis) throw new Error("请先完成当前转写文本的结构分析");
    const selectedRecommendationId = [...state.selectedRecommendationIds][0];
    const recommendation = state.revisionRecommendations.find((item) => item.id === selectedRecommendationId);
    if (!recommendation) throw new Error("请至少选择一项改进建议后再生成草稿");
    state.revisionDraft = createCreativeRevisionDraft(state.analysis, {
      selectedRecommendationIds: [recommendation.id],
      testVariables: [recommendation.variableId],
      parentVersionId: $("#revision-parent-version").value
    });
    state.revisionPreserved = false;
    state.analysisHandoffCache = null;
    state.handoffState = "idle";
    renderRevisionDraft(state.revisionDraft);
    setFeedback("#revision-selection-message", "#revision-selection-error", {
      status: `已围绕“${state.revisionDraft.primaryVariable.label}”生成单变量可拍草稿；请逐项编辑并人工确认。`
    });
    setFlowFeedback({ status: "可拍草稿已生成；下一步逐项核对并明确确认，确认前不会发送。" });
    updateWorkbenchOverview();
    moveToFlowTarget("structure", "revision-draft-title");
  } catch (error) {
    const message = error.message || "无法生成可拍任务草稿";
    setFeedback("#revision-selection-message", "#revision-selection-error", { error: message });
    setFlowFeedback({ error: `${message}；结构分析和当前选择仍保留。` });
    updateWorkbenchOverview();
  }
});

$("#revision-parent-version").addEventListener("input", () => {
  if (!state.revisionDraft) return;
  clearRevisionDraft();
  setFeedback("#revision-selection-message", "#revision-selection-error", {
    status: "父版本编号已改变，旧草稿已失效；请重新生成以建立正确的版本关系。"
  });
  updateWorkbenchOverview();
});

for (const control of document.querySelectorAll("[data-revision-field]")) {
  control.addEventListener("input", () => {
    if (!state.revisionDraft) return;
    state.revisionPreserved = false;
    state.analysisHandoffCache = null;
    state.handoffState = "idle";
    setRevisionConfirmation(false);
    setFeedback("#revision-selection-message", "#revision-selection-error", {
      status: "草稿已编辑，之前的确认与交接缓存已取消；请完成核对后重新确认。"
    });
    updateWorkbenchOverview();
  });
}

$("#confirm-revision-draft").addEventListener("change", (event) => {
  setFeedback("#revision-selection-message", "#revision-selection-error");
  if (!event.target.checked) {
    setRevisionConfirmation(false);
    setFlowFeedback({ status: "已取消草稿确认；当前内容不会发送到编导台。" });
    updateWorkbenchOverview();
    return;
  }
  try {
    currentRevisionDraft();
    setRevisionConfirmation(true);
    setFeedback("#revision-selection-message", "#revision-selection-error", {
      status: "已确认当前草稿；如再次编辑会自动取消确认。"
    });
    setFlowFeedback({ status: "草稿已明确确认；现在可以发送到编导台或导出 V2 交接包。" });
  } catch (error) {
    setRevisionConfirmation(false);
    const message = error.message || "草稿字段校验失败";
    setFeedback("#revision-selection-message", "#revision-selection-error", { error: message });
    setFlowFeedback({ error: `${message}；请修正草稿后重新确认。` });
  }
  updateWorkbenchOverview();
});

$("#export-revision-json").addEventListener("click", () => {
  try {
    const draft = currentRevisionDraft();
    download(`${draft.testId}.json`, JSON.stringify(draft, null, 2));
    state.revisionPreserved = true;
    setFeedback("#revision-selection-message", "#revision-selection-error", { status: "可拍任务草稿 JSON 已导出。" });
  } catch (error) {
    setFeedback("#revision-selection-message", "#revision-selection-error", { error: error.message || "无法导出草稿" });
  }
});

$("#export-revision-md").addEventListener("click", () => {
  try {
    const draft = currentRevisionDraft();
    download(`${draft.testId}.md`, creativeRevisionToMarkdown(draft), "text/markdown;charset=utf-8");
    state.revisionPreserved = true;
    setFeedback("#revision-selection-message", "#revision-selection-error", { status: "可拍任务草稿 Markdown 已导出。" });
  } catch (error) {
    setFeedback("#revision-selection-message", "#revision-selection-error", { error: error.message || "无法导出草稿" });
  }
});

function currentAnalysisHandoff() {
  if (!state.analysis) throw new Error("请先完成当前转写文本的结构分析");
  if (!state.revisionConfirmed) throw new Error("请先逐项核对并明确确认当前可拍任务草稿");
  const revisionDraft = currentRevisionDraft();
  state.analysisHandoffCache = analysisHandoffForAnalysis(state.analysisHandoffCache, state.analysis, { revisionDraft });
  return state.analysisHandoffCache.handoff;
}

$("#send-analysis-handoff").addEventListener("click", async () => {
  if (!state.analysis) return;
  setFeedback("#structure-message", "#structure-error");
  let openPromise = null;
  try {
    const handoff = currentAnalysisHandoff();
    openPromise = openAnalysisHandoffSidePanel(chrome.sidePanel, chrome.windows);
    const queued = await enqueueAnalysisHandoff(chrome.storage?.session, handoff);
    const opened = await openPromise;
    state.handoffState = queued.status === "conflict" ? "conflict" : "sent";
    state.analysisPreserved ||= queued.status !== "conflict";
    state.revisionPreserved ||= queued.status !== "conflict";
    const queueMessage = queued.status === "conflict"
      ? "会话收件箱已有另一份待确认结果，未覆盖；请先在编导台处理。"
      : queued.status === "duplicate"
      ? "同一可拍任务草稿已在会话收件箱中，无需重复发送。"
      : queued.status === "replaced-expired"
      ? "已清理过期结果并发送新的可拍任务草稿。"
      : queued.status === "replaced-invalid"
      ? "已清理损坏的会话记录并发送新的可拍任务草稿。"
      : "可拍任务草稿已发送到当前浏览器会话，等待侧边栏预览。";
    setFeedback("#structure-message", "#structure-error", {
      status: `${queueMessage}${opened.opened ? " 编导台侧边栏已打开。" : ` ${opened.reason}`}`
    });
    setFlowFeedback({
      status: queued.status === "conflict"
        ? "编导台已有另一份待确认结果，本次未覆盖；请先处理收件箱。"
        : `可拍任务草稿已安全排队。${opened.opened ? "编导台已打开。" : opened.reason}`
    });
    updateWorkbenchOverview();
  } catch (error) {
    const opened = openPromise ? await openPromise : { opened: false };
    state.handoffState = "failed";
    if (!openPromise) setRevisionConfirmation(false);
    setFeedback("#structure-message", "#structure-error", {
      error: `${error.message || "无法发送到编导台"}${opened.opened ? "；侧边栏已打开，可改用 JSON 交接包" : "；请改用 JSON 交接包"}`
    });
    setFlowFeedback({ error: `${error.message || "无法发送到编导台"}；分析与草稿仍保留，可修正后重试或导出 JSON。` });
    updateWorkbenchOverview();
  }
});

$("#export-analysis-handoff").addEventListener("click", () => {
  if (!state.analysis) return;
  try {
    const handoff = currentAnalysisHandoff();
    download("qianchuan-analysis-handoff.json", JSON.stringify(handoff, null, 2));
    state.analysisPreserved = true;
    state.revisionPreserved = true;
    setFeedback("#structure-message", "#structure-error", {
      status: "备用 V2 JSON 交接包已导出：包含白名单可拍草稿，不含原始全文、文件名或本机路径；可在侧边栏手动导入。"
    });
    setFlowFeedback({ status: "备用 V2 JSON 交接包已导出；当前分析与草稿仍保留。" });
  } catch (error) {
    const message = error.message || "无法生成编导台交接包";
    setFeedback("#structure-message", "#structure-error", { error: message });
    setFlowFeedback({ error: `${message}；当前分析结果未丢失。` });
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "session" || !changes[ANALYSIS_HANDOFF_INBOX_KEY] || changes[ANALYSIS_HANDOFF_INBOX_KEY].newValue !== undefined) return;
  if (state.handoffState === "conflict") {
    state.handoffState = "idle";
    setFlowFeedback({ status: "编导台待确认结果已处理；可以重新发送当前分析。" });
    updateWorkbenchOverview();
  } else if (state.handoffState === "sent") {
    setFlowFeedback({ status: "编导台已消费本次交接结果；本轮工作已完成。" });
  }
});

renderMaterialSelection();
updateTranscriptionReadiness();
renderRevisionRecommendations();
updateWorkbenchOverview();
