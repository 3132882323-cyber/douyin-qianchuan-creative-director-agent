import {
  BRIEF_TEMPLATES,
  FIELD_DEFINITIONS,
  TAG_FIELDS,
  analyzeReport,
  formatMoney,
  generateCreativePlan,
  inspectColumnMapping,
  normalizedStem,
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
  shouldAutoCheck,
  validateUpdateSnapshot
} from "./src/update.js";
import {
  createTranscodeManifest,
  isSupportedVideoFile,
  transcodeProgress,
  validateTranscodeResult
} from "./src/transcode.js";
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

const $ = (selector) => document.querySelector(selector);
const STORAGE_KEYS = ["productBrief", "targetRoi", "lastAnalysis", "creativePlan", "updateSettings", "lastUpdateCheck"];
const CURRENT_VERSION = chrome.runtime.getManifest().version;
const state = {
  brief: {},
  document: null,
  mapping: {},
  tagValues: [],
  tagPage: 0,
  analysis: null,
  plan: null,
  updateSettings: { autoCheck: false },
  lastUpdateCheck: null,
  matchData: null,
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
let briefSaveTimer = null;
let planSaveTimer = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(selector, text, good = false) {
  const node = $(selector);
  node.textContent = text;
  node.classList.toggle("good", good);
}

function switchView(viewId) {
  document.querySelectorAll(".tab, .view").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.tab[data-view="${viewId}"]`)?.classList.add("active");
  $(`#${viewId}`)?.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.nav)));

function readBriefForm() {
  return Object.fromEntries(new FormData($("#brief-form")).entries());
}

function fillBriefForm(brief = {}) {
  for (const [key, value] of Object.entries(brief)) {
    const field = $(`#brief-form [name="${key}"]`);
    if (field) field.value = value ?? "";
  }
}

function missingBriefFields() {
  const brief = readBriefForm();
  const required = {
    productName: "商品名称",
    targetAudience: "核心人群",
    painPoints: "用户痛点",
    sellingPoints: "核心卖点"
  };
  return Object.entries(required).filter(([key]) => !String(brief[key] ?? "").trim()).map(([, label]) => label);
}

async function saveBrief({ quiet = false } = {}) {
  state.brief = readBriefForm();
  await chrome.storage.local.set({ productBrief: state.brief });
  const missing = missingBriefFields();
  setStatus("#brief-save-state", missing.length ? "草稿已保存" : "已保存", true);
  if (!quiet) $("#brief-error").textContent = missing.length ? `已保存草稿；生成策略前请补充：${missing.join("、")}` : "";
  updateReadiness();
  updateLibraryCounts();
}

$("#brief-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveBrief();
});

$("#brief-form").addEventListener("input", () => {
  setStatus("#brief-save-state", "保存中…");
  clearTimeout(briefSaveTimer);
  briefSaveTimer = setTimeout(() => saveBrief({ quiet: true }), 500);
});

$("#brief-template").addEventListener("change", async (event) => {
  const template = BRIEF_TEMPLATES[event.target.value];
  if (!template) return;
  const form = $("#brief-form");
  for (const [key, value] of Object.entries(template)) {
    if (key === "label") continue;
    const field = form.elements.namedItem(key);
    if (field && !String(field.value).trim()) field.value = value;
  }
  if (event.target.value !== "custom" && !form.elements.namedItem("category").value.trim()) {
    form.elements.namedItem("category").value = template.label;
  }
  await saveBrief({ quiet: true });
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
      updateMappingState();
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
  $("#analyze-button").disabled = actuallyMissing.length > 0;
}

function renderPreview() {
  const container = $("#csv-preview");
  container.replaceChildren();
  const table = element("table", "preview-table");
  const thead = element("thead");
  const headerRow = element("tr");
  state.document.headers.forEach((header) => headerRow.append(element("th", "", header)));
  thead.append(headerRow);
  const tbody = element("tbody");
  state.document.rows.slice(0, 5).forEach((row) => {
    const tr = element("tr");
    state.document.headers.forEach((header) => tr.append(element("td", "", row[header] || "—")));
    tbody.append(tr);
  });
  table.append(thead, tbody);
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
      input.addEventListener("input", () => { state.tagValues[index][field] = input.value; });
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
});

$("#tag-next").addEventListener("click", () => {
  const pageCount = Math.ceil((state.document?.rows.length ?? 0) / 25);
  if (state.tagPage < pageCount - 1) state.tagPage += 1;
  renderTagEditor();
});

$("#report-file").addEventListener("change", async (event) => {
  const reportFile = event.target.files[0] ?? null;
  $("#analysis-error").textContent = "";
  $("#results").hidden = true;
  if (!reportFile) {
    state.document = null;
    $("#import-workspace").hidden = true;
    setStatus("#report-state", "等待 CSV");
    return;
  }
  try {
    state.document = parseCsvDocument(await reportFile.text());
    state.mapping = inspectColumnMapping(state.document.headers).mapping;
    state.tagValues = [];
    state.tagPage = 0;
    initializeTags();
    $("#report-file-name").textContent = `${reportFile.name} · ${formatMoney(reportFile.size / 1024)} KB · ${state.document.rows.length} 行`;
    $("#import-workspace").hidden = false;
    renderMapping();
    renderPreview();
    renderTagEditor();
    setStatus("#report-state", "已读取", true);
  } catch (error) {
    state.document = null;
    $("#import-workspace").hidden = true;
    $("#analysis-error").textContent = error.message || "无法读取 CSV，请检查编码与格式";
    setStatus("#report-state", "读取失败");
  }
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
    state.analysis = analyzeReport(rows, targetRoi, mapping);
    const storedAnalysis = {
      ...state.analysis,
      tagInsights: Object.fromEntries(Object.entries(state.analysis.tagInsights).map(([field, items]) => [field, items.slice(0, 50)]))
    };
    delete storedAnalysis.rows;
    await chrome.storage.local.set({ targetRoi, lastAnalysis: storedAnalysis });
    renderAnalysis(state.analysis);
    $("#analysis-error").textContent = "";
    setStatus("#report-state", "复盘完成", true);
    updateReadiness();
    updateLibraryCounts();
  } catch (error) {
    $("#analysis-error").textContent = error.message || "分析失败，请检查字段映射与 CSV 内容";
    $("#results").hidden = true;
  }
});

function renderAnalysis(result) {
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
  const insights = $("#tag-insights");
  insights.replaceChildren();
  const labels = { audience: "人群", hook: "钩子", sellingPoint: "卖点", scene: "场景" };
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
  const missing = missingBriefFields();
  const hasAnalysis = Boolean(state.analysis?.topCreatives?.length);
  const ready = !missing.length && hasAnalysis;
  $("#generate-plan").disabled = !ready;
  if (ready) {
    $("#plan-readiness").textContent = `已就绪：${state.brief.productName || readBriefForm().productName} · ${state.analysis.summary.creativeCount} 条历史素材。`;
    $("#plan-readiness").className = "notice ready";
  } else {
    const needs = [];
    if (missing.length) needs.push(`补充 Brief：${missing.join("、")}`);
    if (!hasAnalysis) needs.push("完成一次素材复盘");
    $("#plan-readiness").textContent = `生成前需要：${needs.join("；")}。`;
    $("#plan-readiness").className = "notice";
  }
}

$("#generate-plan").addEventListener("click", async () => {
  try {
    await saveBrief({ quiet: true });
    state.plan = generateCreativePlan(state.brief, state.analysis, {
      testVariable: $("#test-variable").value,
      minSpend: $("#min-spend").value
    });
    await chrome.storage.local.set({ creativePlan: state.plan });
    renderPlan(state.plan);
    $("#plan-error").textContent = "";
    setStatus("#plan-state", "已生成", true);
    updateLibraryCounts();
  } catch (error) {
    $("#plan-error").textContent = error.message || "生成失败，请检查商品 Brief 与复盘数据";
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
  input.addEventListener("input", () => {
    setPlanValue(Number(input.dataset.index), input.dataset.path, input.value);
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

function schedulePlanSave() {
  setStatus("#plan-state", "保存中…");
  clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ creativePlan: state.plan });
    setStatus("#plan-state", "已保存", true);
  }, 450);
}

function renderPlan(plan) {
  $("#plan-batch").textContent = plan.items[0]?.id.split("-").slice(0, 2).join("-") || "—";
  $("#plan-baseline").textContent = plan.items[0]?.baselineCreative || "—";
  const list = $("#plan-list");
  list.replaceChildren();
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
      editorField("目标人群", item.audience, index, "audience", 2),
      editorField("前三秒钩子", item.hook, index, "hook", 2),
      editorField("核心卖点", item.sellingPoint, index, "sellingPoint", 2),
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
}

$("#copy-plan").addEventListener("click", async () => {
  if (!state.plan) return;
  try {
    await navigator.clipboard.writeText(planToMarkdown(state.plan));
    $("#copy-state").textContent = "已复制完整策略、脚本、分镜与任务单。";
  } catch {
    $("#copy-state").textContent = "复制失败，请改用 Markdown 导出。";
  }
});
$("#export-plan-md").addEventListener("click", () => state.plan && download("next-creative-plan.md", planToMarkdown(state.plan), "text/markdown;charset=utf-8"));
$("#export-plan-csv").addEventListener("click", () => state.plan && download("next-creative-plan.csv", planToCsv(state.plan), "text/csv;charset=utf-8"));
$("#export-plan-json").addEventListener("click", () => state.plan && download("next-creative-plan.json", JSON.stringify(state.plan, null, 2), "application/json"));

function updateLibraryCounts() {
  $("#asset-brief").textContent = state.brief?.productName ? "1" : "0";
  $("#asset-report").textContent = state.analysis?.summary?.creativeCount ?? "0";
  $("#asset-plan").textContent = state.plan?.items?.length ?? "0";
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
  status.className = "notice compact";
  openButton.disabled = true;
  if (!record) {
    $("#update-latest-version").textContent = "尚未检查";
    $("#update-checked-at").textContent = "尚未连接 GitHub 检查版本。";
    $("#update-summary").textContent = "本地安装 · 用户确认";
    status.textContent = "加载已解压的扩展不会静默自更新。你可以安全检查新版本，再确认是否打开官方下载页。";
    return;
  }
  $("#update-checked-at").textContent = `上次检查：${checkedAtLabel(record.checkedAt)} · 来源：GitHub Releases`;
  if (record.error) {
    $("#update-latest-version").textContent = "检查失败";
    $("#update-summary").textContent = "当前版本保持不变";
    status.classList.add("error");
    status.textContent = `${record.error}。没有下载或替换任何文件，当前版本仍可继续使用。`;
    return;
  }
  let available = false;
  try {
    available = compareVersions(record.latestVersion, CURRENT_VERSION) > 0;
  } catch {
    status.classList.add("error");
    status.textContent = "已保存的版本记录无效，请重新检查。当前文件未发生变化。";
  }
  $("#update-latest-version").textContent = record.latestVersion ? `v${record.latestVersion}` : "未知";
  if (available) {
    $("#update-summary").textContent = `发现 v${record.latestVersion}`;
    status.textContent = `发现新版本 v${record.latestVersion}。扩展不会自行安装；请先导出备份，再由你确认打开 GitHub Release。`;
    openButton.disabled = false;
  } else {
    $("#update-summary").textContent = "当前已是最新";
    status.classList.add("ready");
    status.textContent = "当前版本不低于最新稳定 Release，无需替换文件。";
  }
}

function showUpdateMessage(message, kind = "") {
  const status = $("#update-status");
  status.className = `notice compact${kind ? ` ${kind}` : ""}`;
  status.textContent = message;
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
  if (checkbox.checked) {
    const granted = await requestUpdatePermission();
    if (!granted) {
      checkbox.checked = false;
      state.updateSettings = { autoCheck: false };
      await chrome.storage.local.set({ updateSettings: state.updateSettings });
      showUpdateMessage("未获得 GitHub 访问权限，自动检查没有开启。", "error");
      return;
    }
  }
  state.updateSettings = { autoCheck: checkbox.checked };
  await chrome.storage.local.set({ updateSettings: state.updateSettings });
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
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  const snapshot = safeUpdateSnapshot(stored, CURRENT_VERSION);
  download(`qianchuan-director-workspace-v${CURRENT_VERSION}.json`, JSON.stringify(snapshot, null, 2), "application/json;charset=utf-8");
  showUpdateMessage("工作区备份已导出。它不包含原始 CSV、素材文件、账号凭据或私钥。", "ready");
});

$("#import-update-backup").addEventListener("click", () => $("#update-backup-file").click());
$("#update-backup-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showUpdateMessage("备份文件超过 2 MB，已停止导入。", "error");
    return;
  }
  try {
    const restored = validateUpdateSnapshot(JSON.parse(await file.text()));
    if (!window.confirm("导入会覆盖当前浏览器中的商品 Brief、复盘摘要和拍摄方案。是否继续？")) {
      showUpdateMessage("已取消导入，当前工作区没有变化。", "ready");
      return;
    }
    await chrome.storage.local.set(restored);
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
  $("#master-count").textContent = masterInput.files.length ? `已选择 ${masterInput.files.length} 个自有文件` : "请选择商家拥有版权的原片目录";
  $("#match-button").disabled = !platformInput.files.length || !masterInput.files.length;
}
platformInput.addEventListener("change", refreshMatchButton);
masterInput.addEventListener("change", () => {
  state.masterFileIndex = new Map([...masterInput.files].map((file) => [file.webkitRelativePath || file.name, file]));
  refreshMatchButton();
});

async function digest(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

$("#match-button").addEventListener("click", async () => {
  $("#match-progress").hidden = false;
  $("#match-error").textContent = "";
  try {
    const masters = [...masterInput.files];
    const hashIndex = new Map();
    const nameIndex = new Map();
    for (const file of masters) {
      const hash = await digest(file);
      const byHash = hashIndex.get(hash) ?? [];
      byHash.push(file);
      hashIndex.set(hash, byHash);
      const stem = normalizedStem(file.name);
      const byName = nameIndex.get(stem) ?? [];
      byName.push(file);
      nameIndex.set(stem, byName);
    }
    const matches = [];
    for (const file of [...platformInput.files]) {
      const exact = hashIndex.get(await digest(file)) ?? [];
      const candidates = nameIndex.get(normalizedStem(file.name)) ?? [];
      const sameSize = candidates.filter((candidate) => candidate.size === file.size);
      let status = "no_match";
      let selected = [];
      if (exact.length) [status, selected] = ["exact_hash", exact];
      else if (sameSize.length) [status, selected] = ["name_and_size", sameSize];
      else if (candidates.length) [status, selected] = ["name_candidate", candidates];
      matches.push({ platformAsset: file.name, status, ownedMasterCandidates: selected.map((candidate) => candidate.webkitRelativePath || candidate.name), requiresHumanReview: status !== "exact_hash" });
    }
    state.matchData = { generatedAt: new Date().toISOString(), platformAssetCount: platformInput.files.length, ownedMasterCount: masters.length, matches, notice: "仅进行本地指纹和名称匹配，不检测、移除、破解或规避平台水印。" };
    renderMatches(state.matchData);
  } catch (error) {
    $("#match-error").textContent = error.message || "匹配失败";
  } finally {
    $("#match-progress").hidden = true;
  }
});

function renderMatches(data) {
  const labels = { exact_hash: "指纹完全一致", name_and_size: "名称与大小候选", name_candidate: "仅名称候选", no_match: "未找到" };
  const exactCount = data.matches.filter((item) => item.status === "exact_hash").length;
  const candidateCount = data.matches.filter((item) => item.ownedMasterCandidates.length).length;
  $("#match-summary").textContent = `${exactCount}/${data.matches.length} 个确定匹配`;
  $("#repair-master-priority").textContent = candidateCount
    ? `已为 ${candidateCount} 个素材找到自有母版候选。请先人工核对并优先直接使用母版或从原始工程重新导出；只有母版本身仍有普通瑕疵时才使用下方局部修复。`
    : "尚未找到自有母版候选。请优先补充母版或原始工程；局部修复仅用于已授权图片的小范围普通瑕疵。";
  const list = $("#match-list");
  list.replaceChildren();
  data.matches.forEach((match) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", match.platformAsset), element("span", `badge${match.status === "exact_hash" ? "" : " warn"}`, labels[match.status]));
    card.append(head, element("p", "", match.ownedMasterCandidates.length ? match.ownedMasterCandidates.join("；") : "请补充自有母版或原始工程"));
    const candidateFiles = match.ownedMasterCandidates.map((path) => state.masterFileIndex.get(path)).filter(Boolean);
    const candidateVideos = candidateFiles.filter(isSupportedVideoFile);
    const candidateImages = candidateFiles.filter(isRepairImageCandidate);
    if (candidateVideos.length) {
      const addButton = element("button", "secondary full", "将候选自有母版加入转码队列");
      addButton.type = "button";
      addButton.addEventListener("click", () => {
        addTranscodeFiles(candidateVideos);
        $("#transcode-panel").open = true;
        $("#transcode-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      card.append(addButton);
    }
    if (candidateImages.length) {
      const inspectButton = element("button", "secondary full", "优先检查候选自有母版图片");
      inspectButton.type = "button";
      inspectButton.addEventListener("click", async () => {
        $("#image-repair-panel").open = true;
        await loadRepairImage(candidateImages[0], { fromOwnedCandidate: true });
        $("#image-repair-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      card.append(inspectButton);
    }
    list.append(card);
  });
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
  if (!stroke?.points?.length) return;
  const context = repairMaskContext;
  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = "rgba(255, 35, 35, 1)";
  context.fillStyle = "rgba(255, 35, 35, 1)";
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
  state.imageRepair.resultPixels = null;
  $("#repair-result").hidden = true;
  renderRepairPreview();
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
  $("#run-image-repair").disabled = !repair.sourcePixels || !stats.selected || maskTooLarge || !$("#repair-authorization").checked;
  $("#repair-mask-status").textContent = maskTooLarge
    ? `选区 ${stats.selected.toLocaleString("zh-CN")} 像素（${(stats.coverage * 100).toFixed(2)}%）超过局部同步处理上限；请缩小或分区圈选。`
    : stats.selected
    ? `人工选区 ${stats.selected.toLocaleString("zh-CN")} 像素（${(stats.coverage * 100).toFixed(2)}%）；仅该范围会参与局部修复。`
    : "尚未绘制选区。只能修改你手动画出的 Mask 范围。";
}

function resetRepairEdits() {
  state.imageRepair.history = createMaskHistory();
  state.imageRepair.activeStroke = null;
  state.imageRepair.resultPixels = null;
  renderRepairMask();
  renderRepairPreview();
  $("#repair-result").hidden = true;
  $("#repair-error").textContent = "";
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
  $("#repair-error").textContent = "";
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
        $("#repair-master-priority").textContent = `已载入候选自有母版“${file.name}”供人工检查。请优先直接使用干净母版或从原始工程重新导出；只有母版本身仍有普通瑕疵时，才确认授权并手动画 Mask 修复。`;
      }
      resetRepairEdits();
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
    $("#repair-error").textContent = error instanceof RangeError
      ? "浏览器内存不足，已停止读取；请从自有工程缩小图片后再试。"
      : error.message || "图片解码失败，请确认文件未损坏且格式受支持";
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
  state.imageRepair.history = clearMaskState(state.imageRepair.history);
  invalidateRepairResult();
  renderRepairMask();
  updateRepairControls();
});

$("#run-image-repair").addEventListener("click", async () => {
  $("#repair-error").textContent = "正在本地生成预览…";
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
    $("#repair-error").textContent = `预览完成：修改 ${repaired.changedPixels.toLocaleString("zh-CN")} 个 Mask 内像素；透明通道保持不变。`;
    renderRepairPreview();
  } catch (error) {
    state.imageRepair.resultPixels = null;
    $("#repair-result").hidden = true;
    $("#repair-error").textContent = error.message || "局部修复失败";
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
$("#reset-image-repair").addEventListener("click", resetRepairEdits);
$("#export-repaired-image").addEventListener("click", () => {
  if (!state.imageRepair.resultPixels || !state.imageRepair.file) return;
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
        $("#repair-error").textContent = "浏览器无法编码该图片";
        return;
      }
      downloadBlob(repairOutputName(state.imageRepair.file.name, exportInfo.extension), blob);
      $("#repair-error").textContent = exportInfo.preservesAlpha ? "已导出 PNG，新文件保留透明通道。" : "已导出 JPEG；透明区域已安全铺为白色。";
    }, exportInfo.mime, exportInfo.quality);
  } catch (error) {
    $("#repair-error").textContent = error.message || "图片导出失败";
  }
});
syncRepairExportControls();

const transcodeInput = $("#transcode-files");

function transcodeFileIdentity(file) {
  return `${file.webkitRelativePath || file.name}|${file.size}|${file.lastModified}`;
}

function refreshTranscodeSelection() {
  const count = state.transcodeFiles.length;
  $("#transcode-file-count").textContent = count ? `已加入 ${count} 个自有/授权视频` : "支持多选视频；也可从上方母版匹配结果加入";
}

function markTranscodeDirty() {
  if (!state.transcodeManifest) return;
  state.transcodeManifest = null;
  $("#transcode-queue").hidden = true;
  $("#transcode-error").textContent = "文件或参数已改变，请重新生成转码任务。";
}

function addTranscodeFiles(files) {
  const incoming = [...files];
  const supported = incoming.filter(isSupportedVideoFile);
  const known = new Set(state.transcodeFiles.map(transcodeFileIdentity));
  for (const file of supported) {
    const identity = transcodeFileIdentity(file);
    if (!known.has(identity)) {
      known.add(identity);
      state.transcodeFiles.push(file);
    }
  }
  if (!supported.length && incoming.length) $("#transcode-error").textContent = "所选文件中没有可识别的视频原片。";
  else $("#transcode-error").textContent = supported.length < incoming.length ? "已忽略非视频文件。" : "";
  markTranscodeDirty();
  refreshTranscodeSelection();
}

transcodeInput.addEventListener("change", (event) => {
  addTranscodeFiles(event.target.files);
  event.target.value = "";
});

const transcodeSettingIds = [
  "transcode-authorization", "transcode-source-root", "transcode-output-root", "transcode-preset",
  "transcode-resolution", "transcode-frame-rate", "transcode-video-bitrate", "transcode-audio-bitrate",
  "transcode-sample-rate", "transcode-output-suffix", "transcode-ffmpeg-path"
];
transcodeSettingIds.forEach((id) => $(`#${id}`).addEventListener("input", markTranscodeDirty));

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
  $("#transcode-progress-label").textContent = `${progress.finished}/${progress.total} 已结束 · ${progress.completed} 成功 · ${progress.failed} 失败`;
  $("#transcode-progress-bar").style.width = `${progress.percent}%`;
  const list = $("#transcode-task-list");
  list.replaceChildren();
  const labels = { pending: "待执行", completed: "已完成", failed: "失败", skipped: "已跳过" };
  manifest.tasks.forEach((task) => {
    const card = element("article", "item transcode-task");
    const head = element("div", "item-head");
    head.append(element("strong", "", task.source.name), element("span", `badge ${task.status}`, labels[task.status] || "待执行"));
    card.append(head);
    card.append(element("p", "task-path", `输出：${task.outputPath}`));
    if (task.status === "failed") card.append(element("p", "error", task.failureReason || `FFmpeg 执行失败${task.exitCode === null ? "" : `（退出码 ${task.exitCode}）`}`));
    const commandDetails = element("details", "task-command");
    const commandSummary = element("summary");
    commandSummary.append(element("span", "", "查看本地命令"));
    const command = element("pre", "", task.powerShellCommand);
    commandDetails.append(commandSummary, command);
    card.append(commandDetails);
    list.append(card);
  });
  $("#transcode-queue").hidden = false;
}

$("#build-transcode-tasks").addEventListener("click", () => {
  $("#transcode-error").textContent = "";
  try {
    state.transcodeManifest = createTranscodeManifest(state.transcodeFiles, readTranscodeSettings(), { creatorVersion: CURRENT_VERSION });
    renderTranscodeQueue();
  } catch (error) {
    state.transcodeManifest = null;
    renderTranscodeQueue();
    $("#transcode-error").textContent = error.message || "无法生成转码任务";
  }
});

$("#copy-transcode-commands").addEventListener("click", async () => {
  if (!state.transcodeManifest) return;
  try {
    await navigator.clipboard.writeText(state.transcodeManifest.tasks.map((task) => task.powerShellCommand).join("\r\n\r\n"));
    $("#transcode-error").textContent = "全部本地命令已复制；执行前请再次核对输入与输出路径。";
  } catch {
    $("#transcode-error").textContent = "复制失败，请导出任务清单并使用本地执行器。";
  }
});

$("#export-transcode-manifest").addEventListener("click", () => {
  if (!state.transcodeManifest) return;
  download("qianchuan-transcode-tasks.json", JSON.stringify(state.transcodeManifest, null, 2), "application/json;charset=utf-8");
  $("#transcode-error").textContent = "任务清单已导出；它包含你填写的本地输入与输出路径，请只在可信设备上保存。";
});

$("#download-transcode-worker").addEventListener("click", async () => {
  try {
    const response = await fetch(chrome.runtime.getURL("tools/transcode-worker.ps1"), { cache: "no-store" });
    if (!response.ok) throw new Error("执行器文件无法读取");
    download("transcode-worker.ps1", await response.text(), "text/plain;charset=utf-8");
    $("#transcode-error").textContent = "本地执行器已下载。运行前可以打开检查其源码。";
  } catch (error) {
    $("#transcode-error").textContent = `${error.message || "执行器下载失败"}；也可以从开源仓库 tools 目录获取。`;
  }
});

$("#import-transcode-result").addEventListener("click", () => $("#transcode-result-file").click());
$("#transcode-result-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.transcodeManifest) return;
  if (file.size > 2 * 1024 * 1024) {
    $("#transcode-error").textContent = "执行结果超过 2 MB，已停止导入。";
    return;
  }
  try {
    const results = validateTranscodeResult(JSON.parse(await file.text()), state.transcodeManifest);
    const byId = new Map(results.map((result) => [result.id, result]));
    state.transcodeManifest.tasks = state.transcodeManifest.tasks.map((task) => ({ ...task, ...(byId.get(task.id) || {}) }));
    renderTranscodeQueue();
    const progress = transcodeProgress(state.transcodeManifest.tasks);
    $("#transcode-error").textContent = progress.failed ? `已导入执行结果：${progress.completed} 成功，${progress.failed} 失败。失败原因已显示在任务下方。` : `已导入执行结果：${progress.completed} 个任务完成。`;
  } catch (error) {
    $("#transcode-error").textContent = error.message || "执行结果无法导入";
  }
});

async function initialize() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS);
    state.brief = stored.productBrief ?? {};
    state.analysis = stored.lastAnalysis ?? null;
    state.plan = stored.creativePlan ?? null;
    state.updateSettings = stored.updateSettings && typeof stored.updateSettings === "object" ? { autoCheck: stored.updateSettings.autoCheck === true } : { autoCheck: false };
    state.lastUpdateCheck = stored.lastUpdateCheck ?? null;
    fillBriefForm(state.brief);
    if (stored.targetRoi !== undefined) $("#target-roi").value = stored.targetRoi;
    if (state.brief.productName) setStatus("#brief-save-state", "已保存", true);
    if (state.analysis) {
      renderAnalysis(state.analysis);
      setStatus("#report-state", "已恢复上次复盘", true);
    }
    if (state.plan) {
      renderPlan(state.plan);
      setStatus("#plan-state", "已恢复", true);
      $("#test-variable").value = state.plan.testVariable || "hook";
      $("#min-spend").value = state.plan.items?.[0]?.minSpend || 300;
    }
    renderUpdateState();
  } catch (error) {
    $("#brief-error").textContent = `无法读取本地工作区：${error.message || "未知错误"}`;
  }
  updateReadiness();
  updateLibraryCounts();
  void maybeRunAutomaticUpdateCheck();
}

initialize();
