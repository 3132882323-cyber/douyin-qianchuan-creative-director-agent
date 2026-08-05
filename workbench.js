import {
  MATERIAL_VIDEO_BATCH_LIMITS,
  analyzeTranscriptStructure,
  createLocalTranscriptionPlan,
  createMaterialProcessingManifest,
  materialAnalysisToMarkdown,
  transcriptTextFromDocument,
  validateDouyinSourceNote
} from "./src/material-analysis.js";
import { isSupportedVideoFile, transcodeProgress, validateLocalVideoBatch, validateTranscodeResult } from "./src/transcode.js";
import { formatLocalBytes } from "./src/local-file-guard.js";
import { parseJsonDocument, validateNonMediaImport } from "./src/release-safety.js";

const $ = (selector) => document.querySelector(selector);
const VERSION = chrome.runtime.getManifest().version;
const state = {
  files: [],
  processingManifest: null,
  transcriptionPlan: null,
  transcriptSourceName: "手动粘贴文本",
  analysis: null
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

document.querySelectorAll("label.file-card[for]").forEach((trigger) => {
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
  state.transcriptionPlan = null;
  $("#processing-queue").hidden = true;
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
  if (!count) list.append(element("p", "empty-inline", "尚未选择视频。服务台不会自动读取本地目录。"));
  $("#clear-material-selection").disabled = !count;
  updateMaterialReadiness();
}

function updateMaterialReadiness() {
  const missing = [];
  if (!state.files.length) missing.push("选择至少一个视频");
  if (!$("#material-authorization").checked) missing.push("确认素材授权");
  if (!$("#material-source-root").value.trim()) missing.push("填写自有原片根目录");
  if (!$("#material-output-root").value.trim()) missing.push("填写处理输出目录");
  let validationError = "";
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
}

$("#material-video-files").addEventListener("change", (event) => {
  const incoming = [...event.target.files];
  event.target.value = "";
  if (!incoming.length) return;
  const unsupported = incoming.filter((file) => !isSupportedVideoFile(file));
  if (unsupported.length) {
    setFeedback("#source-message", "#source-error", { error: `所选内容包含 ${unsupported.length} 个不支持的文件，本次没有加入任何文件。` });
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
    setFeedback("#source-message", "#source-error", { error: error.message || "所选视频超过本地处理保护上限" });
    return;
  }
  const added = nextFiles.length - state.files.length;
  state.files = nextFiles;
  invalidateProcessing();
  renderMaterialSelection();
  setFeedback("#source-message", "#source-error", { status: added ? `${added} 个视频已加入当前选择。` : "所选视频已在当前选择中，没有重复加入。" });
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
});

for (const id of ["material-source-root", "material-output-root", "material-ffmpeg-path", "material-authorization", "douyin-source-note"]) {
  $(`#${id}`).addEventListener("input", () => {
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
    return;
  }
  const progress = transcodeProgress(manifest.tasks);
  setNodeText("#processing-progress-label", `${progress.finished}/${progress.total} 已结束 · ${progress.completed} 成功 · ${progress.failed} 失败`);
  $("#processing-progress-bar").style.width = `${progress.percent}%`;
  const progressNode = $("#processing-progress");
  progressNode.setAttribute("aria-valuemax", String(progress.total));
  progressNode.setAttribute("aria-valuenow", String(progress.finished));
  progressNode.setAttribute("aria-valuetext", `${progress.finished}/${progress.total} 已结束，${progress.completed} 成功，${progress.failed} 失败`);
  setNodeText("#processing-queue-status", progress.finished === 0
    ? `浏览器已生成 ${progress.total} 个待执行任务，但尚未运行 FFmpeg；请在本机执行后导入结果。`
    : progress.finished < progress.total
    ? `已导入部分结果；还有 ${progress.total - progress.finished} 个任务未结束。`
    : progress.failed
    ? `本轮结果已全部导入，其中 ${progress.failed} 个失败。`
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
  setStatus("#processing-status", progress.finished ? `${progress.completed}/${progress.total} 完成` : `${progress.total} 个任务待执行`, progress.completed === progress.total);
}

$("#create-material-tasks").addEventListener("click", () => {
  setFeedback("#source-message", "#source-error");
  setFeedback("#processing-message", "#processing-error");
  try {
    state.processingManifest = createMaterialProcessingManifest(state.files, processingSettings(), { creatorVersion: VERSION });
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    renderProcessingQueue();
    setFeedback("#processing-message", "#processing-error", { status: `已生成 ${state.processingManifest.tasks.length} 个本机待执行任务；浏览器尚未运行任何程序，也未上传文件。` });
    updateTranscriptionReadiness();
  } catch (error) {
    state.processingManifest = null;
    renderProcessingQueue();
    setFeedback("#processing-message", "#processing-error", { error: error.message || "无法生成本地处理任务" });
    updateTranscriptionReadiness();
  }
});

$("#copy-material-commands").addEventListener("click", async () => {
  if (!state.processingManifest) return;
  try {
    await navigator.clipboard.writeText(state.processingManifest.tasks.map((task) => task.powerShellCommand).join("\r\n\r\n"));
    setFeedback("#processing-message", "#processing-error", { status: "固定参数的本地 FFmpeg 命令已复制；执行前请再次核对路径。" });
  } catch {
    setFeedback("#processing-message", "#processing-error", { error: "复制失败，请改为导出任务清单并使用开源执行器。" });
  }
});

$("#export-material-manifest").addEventListener("click", () => {
  if (!state.processingManifest) return;
  download("qianchuan-material-analysis-tasks.json", JSON.stringify(state.processingManifest, null, 2));
  setFeedback("#processing-message", "#processing-error", { status: "任务清单已导出；其中包含本机路径，请仅在可信设备保存。" });
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
    renderProcessingQueue();
    const progress = transcodeProgress(state.processingManifest.tasks);
    setFeedback("#processing-message", "#processing-error", progress.failed
      ? { error: `已导入：${progress.completed} 成功，${progress.failed} 失败；失败原因显示在任务下方。` }
      : { status: `已导入：${progress.completed} 个任务完成。` });
  } catch (error) {
    setFeedback("#processing-message", "#processing-error", { error: error.message || "执行结果无法导入" });
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
}

function invalidateTranscriptionPlan() {
  if (state.transcriptionPlan) {
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    setFeedback("#transcription-message", "#transcription-error", { status: "本地引擎参数已改变，旧转写清单已失效。" });
  }
  updateTranscriptionReadiness();
}

function syncTranscriptionMode() {
  const localEngine = $("#transcription-mode").value === "whisper_cpp";
  $("#whisper-config").hidden = !localEngine;
  $("#transcription-language").disabled = !localEngine;
  if (!localEngine) {
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    setFeedback("#transcription-message", "#transcription-error", { status: "可直接导入或粘贴本机生成的文本，不需要配置执行引擎。" });
  } else {
    setFeedback("#transcription-message", "#transcription-error");
  }
  updateTranscriptionReadiness();
}
$("#transcription-mode").addEventListener("change", syncTranscriptionMode);
for (const id of ["whisper-executable", "whisper-model", "transcription-language"]) {
  $(`#${id}`).addEventListener("input", invalidateTranscriptionPlan);
}
syncTranscriptionMode();

$("#create-transcription-plan").addEventListener("click", () => {
  setFeedback("#transcription-message", "#transcription-error");
  try {
    state.transcriptionPlan = createLocalTranscriptionPlan(state.processingManifest, {
      mode: "whisper_cpp",
      executable: $("#whisper-executable").value,
      modelPath: $("#whisper-model").value,
      language: $("#transcription-language").value
    });
    $("#transcription-plan-actions").hidden = false;
    setFeedback("#transcription-message", "#transcription-error", { status: `已生成 ${state.transcriptionPlan.tasks.length} 个固定参数本机转写任务；请在音频提取完成后执行。` });
  } catch (error) {
    state.transcriptionPlan = null;
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
  setFeedback("#transcription-message", "#transcription-error", { status: "本地转写任务清单已导出；其中包含本机路径，请仅在可信设备保存。" });
});

$("#transcript-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    validateNonMediaImport(file, "transcript");
    const text = transcriptTextFromDocument(await file.text());
    $("#transcript-text").value = text;
    state.transcriptSourceName = file.name;
    setStatus("#transcript-status", `${text.length.toLocaleString("zh-CN")} 字符`, true);
    state.analysis = null;
    $("#structure-result").hidden = true;
    setStatus("#structure-status", "尚未分析");
    setFeedback("#transcription-message", "#transcription-error", { status: "文本已在本地读取；时间码与字幕序号已清理。" });
  } catch (error) {
    setFeedback("#transcription-message", "#transcription-error", { error: error.message || "无法读取转写文本" });
  }
});

$("#transcript-text").addEventListener("input", (event) => {
  const length = event.target.value.trim().length;
  if (length) state.transcriptSourceName = "手动粘贴文本";
  setStatus("#transcript-status", length ? `${length.toLocaleString("zh-CN")} 字符` : "等待文本", length > 0);
  if (state.analysis) {
    state.analysis = null;
    $("#structure-result").hidden = true;
    setStatus("#structure-status", "需要重新分析");
    setFeedback("#structure-message", "#structure-error", { status: "转写正文已改变，旧结构分析已失效。" });
  }
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
    card.append(element("p", "", `${segment.index}. ${segment.content}`));
    if (segment.tags.length) {
      const tags = element("div", "tags");
      for (const id of segment.tags) tags.append(element("span", "", result.coverage[id].label));
      card.append(tags);
    }
    segmentList.append(card);
  }
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
  setStatus("#structure-status", `覆盖 ${result.summary.coveredStructures}/${result.summary.totalStructures}`, true);
}

$("#analyze-transcript").addEventListener("click", () => {
  setFeedback("#structure-message", "#structure-error");
  try {
    state.analysis = analyzeTranscriptStructure($("#transcript-text").value, { sourceName: state.transcriptSourceName });
    renderStructureAnalysis(state.analysis);
    setFeedback("#structure-message", "#structure-error", { status: "结构分析已在浏览器本地完成；结果来自确定性规则，不代表投放效果预测。" });
  } catch (error) {
    state.analysis = null;
    $("#structure-result").hidden = true;
    setStatus("#structure-status", "尚未分析");
    setFeedback("#structure-message", "#structure-error", { error: error.message || "无法分析转写文本" });
  }
});

$("#export-structure-json").addEventListener("click", () => {
  if (state.analysis) {
    download("qianchuan-material-structure.json", JSON.stringify(state.analysis, null, 2));
    setFeedback("#structure-message", "#structure-error", { status: "JSON 结构分析已导出。" });
  }
});
$("#export-structure-md").addEventListener("click", () => {
  if (state.analysis) {
    download("qianchuan-material-structure.md", materialAnalysisToMarkdown(state.analysis), "text/markdown;charset=utf-8");
    setFeedback("#structure-message", "#structure-error", { status: "Markdown 结构分析已导出。" });
  }
});

renderMaterialSelection();
updateTranscriptionReadiness();
