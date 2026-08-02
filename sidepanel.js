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
  matchData: null
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

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
masterInput.addEventListener("change", refreshMatchButton);

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
  $("#match-summary").textContent = `${exactCount}/${data.matches.length} 个确定匹配`;
  const list = $("#match-list");
  list.replaceChildren();
  data.matches.forEach((match) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", match.platformAsset), element("span", `badge${match.status === "exact_hash" ? "" : " warn"}`, labels[match.status]));
    card.append(head, element("p", "", match.ownedMasterCandidates.length ? match.ownedMasterCandidates.join("；") : "请补充自有母版或原始工程"));
    list.append(card);
  });
  $("#match-results").hidden = false;
}

$("#export-matches").addEventListener("click", () => state.matchData && download("owned-master-matches.json", JSON.stringify(state.matchData, null, 2), "application/json"));

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
