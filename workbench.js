import {
  MAX_TRANSCRIPT_BYTES,
  analyzeTranscriptStructure,
  createLocalTranscriptionPlan,
  createMaterialProcessingManifest,
  materialAnalysisToMarkdown,
  transcriptTextFromDocument,
  validateDouyinSourceNote
} from "./src/material-analysis.js";
import { isSupportedVideoFile, transcodeProgress, validateTranscodeResult } from "./src/transcode.js";

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
  node.textContent = text;
  node.classList.toggle("good", good);
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

function fileIdentity(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

function invalidateProcessing(message = "文件或参数已变化，请重新生成任务。") {
  if (!state.processingManifest) return;
  state.processingManifest = null;
  state.transcriptionPlan = null;
  $("#processing-queue").hidden = true;
  $("#transcription-plan-actions").hidden = true;
  setStatus("#processing-status", "需要重新生成");
  $("#processing-error").textContent = message;
}

$("#material-video-files").addEventListener("change", (event) => {
  const incoming = [...event.target.files];
  event.target.value = "";
  const known = new Set(state.files.map(fileIdentity));
  for (const file of incoming.filter(isSupportedVideoFile)) {
    if (!known.has(fileIdentity(file))) {
      known.add(fileIdentity(file));
      state.files.push(file);
    }
  }
  const ignored = incoming.length - incoming.filter(isSupportedVideoFile).length;
  $("#material-file-label").textContent = state.files.length
    ? `已选择 ${state.files.length} 个本地视频${ignored ? `；忽略 ${ignored} 个非视频文件` : ""}`
    : "支持多选 MP4、MOV、MKV、WebM 等视频";
  setStatus("#source-status", state.files.length ? `${state.files.length} 个本地视频` : "未选择", state.files.length > 0);
  $("#source-error").textContent = ignored ? "已忽略无法识别的非视频文件。" : "";
  invalidateProcessing();
});

for (const id of ["material-source-root", "material-output-root", "material-ffmpeg-path", "material-authorization", "douyin-source-note"]) {
  $(`#${id}`).addEventListener("input", () => invalidateProcessing());
}

$("#open-source-note").addEventListener("click", () => {
  $("#source-error").textContent = "";
  try {
    const note = validateDouyinSourceNote($("#douyin-source-note").value);
    if (!note) throw new Error("请先填写抖音原页链接");
    const opened = window.open(note.url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    $("#source-error").textContent = "已按原地址打开新标签页；扩展未请求或解析链接内容。";
  } catch (error) {
    $("#source-error").textContent = error.message || "无法打开来源链接";
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
  $("#processing-progress-label").textContent = `${progress.finished}/${progress.total} 已结束 · ${progress.completed} 成功 · ${progress.failed} 失败`;
  $("#processing-progress-bar").style.width = `${progress.percent}%`;
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
    if (task.status === "failed") card.append(element("p", "failed", task.failureReason || "本地 FFmpeg 执行失败"));
    list.append(card);
  }
  $("#processing-queue").hidden = false;
  setStatus("#processing-status", progress.finished ? `${progress.completed}/${progress.total} 完成` : `${progress.total} 个任务待执行`, progress.completed === progress.total);
}

$("#create-material-tasks").addEventListener("click", () => {
  $("#source-error").textContent = "";
  $("#processing-error").textContent = "";
  try {
    state.processingManifest = createMaterialProcessingManifest(state.files, processingSettings(), { creatorVersion: VERSION });
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    renderProcessingQueue();
    $("#processing-error").textContent = `已生成 ${state.processingManifest.tasks.length} 个本地任务；扩展尚未执行任何程序或上传文件。`;
  } catch (error) {
    state.processingManifest = null;
    renderProcessingQueue();
    $("#processing-error").textContent = error.message || "无法生成本地处理任务";
  }
});

$("#copy-material-commands").addEventListener("click", async () => {
  if (!state.processingManifest) return;
  try {
    await navigator.clipboard.writeText(state.processingManifest.tasks.map((task) => task.powerShellCommand).join("\r\n\r\n"));
    $("#processing-error").textContent = "固定参数的本地 FFmpeg 命令已复制；执行前请再次核对路径。";
  } catch {
    $("#processing-error").textContent = "复制失败，请改为导出任务清单并使用开源执行器。";
  }
});

$("#export-material-manifest").addEventListener("click", () => {
  if (!state.processingManifest) return;
  download("qianchuan-material-analysis-tasks.json", JSON.stringify(state.processingManifest, null, 2));
  $("#processing-error").textContent = "任务清单已导出；其中包含本机路径，请仅在可信设备保存。";
});

$("#download-material-worker").addEventListener("click", async () => {
  try {
    download("transcode-worker.ps1", await readPackagedText("tools/transcode-worker.ps1"), "text/plain;charset=utf-8");
    $("#processing-error").textContent = "已下载开源本地执行器，可先打开审计源码再运行。";
  } catch (error) {
    $("#processing-error").textContent = error.message || "执行器下载失败";
  }
});

$("#import-material-result").addEventListener("click", () => $("#material-result-file").click());
$("#material-result-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.processingManifest) return;
  if (file.size > 2 * 1024 * 1024) {
    $("#processing-error").textContent = "执行结果超过 2 MB，已停止导入。";
    return;
  }
  try {
    const results = validateTranscodeResult(JSON.parse(await file.text()), state.processingManifest);
    const byId = new Map(results.map((result) => [result.id, result]));
    state.processingManifest.tasks = state.processingManifest.tasks.map((task) => ({ ...task, ...(byId.get(task.id) || {}) }));
    renderProcessingQueue();
    const progress = transcodeProgress(state.processingManifest.tasks);
    $("#processing-error").textContent = progress.failed
      ? `已导入：${progress.completed} 成功，${progress.failed} 失败；失败原因显示在任务下方。`
      : `已导入：${progress.completed} 个任务完成。`;
  } catch (error) {
    $("#processing-error").textContent = error.message || "执行结果无法导入";
  }
});

function syncTranscriptionMode() {
  const localEngine = $("#transcription-mode").value === "whisper_cpp";
  $("#whisper-config").hidden = !localEngine;
  $("#transcription-language").disabled = !localEngine;
  if (!localEngine) {
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    $("#transcription-error").textContent = "可直接导入或粘贴本机生成的文本，不需要配置执行引擎。";
  } else {
    $("#transcription-error").textContent = "";
  }
}
$("#transcription-mode").addEventListener("change", syncTranscriptionMode);
syncTranscriptionMode();

$("#create-transcription-plan").addEventListener("click", () => {
  $("#transcription-error").textContent = "";
  try {
    state.transcriptionPlan = createLocalTranscriptionPlan(state.processingManifest, {
      mode: "whisper_cpp",
      executable: $("#whisper-executable").value,
      modelPath: $("#whisper-model").value,
      language: $("#transcription-language").value
    });
    $("#transcription-plan-actions").hidden = false;
    $("#transcription-error").textContent = `已生成 ${state.transcriptionPlan.tasks.length} 个固定参数本地转写任务；请在音频提取完成后执行。`;
  } catch (error) {
    state.transcriptionPlan = null;
    $("#transcription-plan-actions").hidden = true;
    $("#transcription-error").textContent = error.message || "无法生成本地转写任务";
  }
});

$("#copy-transcription-commands").addEventListener("click", async () => {
  if (!state.transcriptionPlan) return;
  try {
    await navigator.clipboard.writeText(state.transcriptionPlan.tasks.map((task) => task.command).join("\r\n\r\n"));
    $("#transcription-error").textContent = "本机 whisper.cpp 固定参数命令已复制。";
  } catch {
    $("#transcription-error").textContent = "复制失败，请导出本地转写清单。";
  }
});

$("#export-transcription-plan").addEventListener("click", () => {
  if (!state.transcriptionPlan) return;
  download("qianchuan-local-transcription-tasks.json", JSON.stringify(state.transcriptionPlan, null, 2));
});

$("#transcript-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (![".txt", ".md", ".srt", ".vtt"].includes(extension)) {
    $("#transcription-error").textContent = "仅支持 TXT、MD、SRT 或 VTT 文本。";
    return;
  }
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    $("#transcription-error").textContent = "转写文本超过 4 MB，已停止导入。";
    return;
  }
  try {
    const text = transcriptTextFromDocument(await file.text());
    $("#transcript-text").value = text;
    state.transcriptSourceName = file.name;
    setStatus("#transcript-status", `${text.length.toLocaleString("zh-CN")} 字符`, true);
    $("#transcription-error").textContent = "文本已在本地读取；时间码与字幕序号已清理。";
  } catch (error) {
    $("#transcription-error").textContent = error.message || "无法读取转写文本";
  }
});

$("#transcript-text").addEventListener("input", (event) => {
  const length = event.target.value.trim().length;
  if (length) state.transcriptSourceName = "手动粘贴文本";
  setStatus("#transcript-status", length ? `${length.toLocaleString("zh-CN")} 字符` : "等待文本", length > 0);
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
  $("#structure-error").textContent = "";
  try {
    state.analysis = analyzeTranscriptStructure($("#transcript-text").value, { sourceName: state.transcriptSourceName });
    renderStructureAnalysis(state.analysis);
  } catch (error) {
    state.analysis = null;
    $("#structure-result").hidden = true;
    setStatus("#structure-status", "尚未分析");
    $("#structure-error").textContent = error.message || "无法分析转写文本";
  }
});

$("#export-structure-json").addEventListener("click", () => {
  if (state.analysis) download("qianchuan-material-structure.json", JSON.stringify(state.analysis, null, 2));
});
$("#export-structure-md").addEventListener("click", () => {
  if (state.analysis) download("qianchuan-material-structure.md", materialAnalysisToMarkdown(state.analysis), "text/markdown;charset=utf-8");
});
