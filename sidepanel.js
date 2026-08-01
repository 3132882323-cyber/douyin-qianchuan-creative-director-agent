import { analyzeReport, formatMoney, normalizedStem, parseCsv, toMarkdown } from "./src/core.js";

const $ = (selector) => document.querySelector(selector);
let reportFile = null;
let analysis = null;
let matchData = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .view").forEach((node) => node.classList.remove("active"));
    tab.classList.add("active");
    $(`#${tab.dataset.view}`).classList.add("active");
  });
});

chrome.storage.local.get(["targetRoi"]).then(({ targetRoi }) => {
  if (targetRoi !== undefined) $("#target-roi").value = targetRoi;
});

$("#report-file").addEventListener("change", (event) => {
  reportFile = event.target.files[0] ?? null;
  $("#report-file-name").textContent = reportFile ? `${reportFile.name} · ${formatMoney(reportFile.size / 1024)} KB` : "支持 UTF-8 CSV";
  $("#analyze-button").disabled = !reportFile;
  $("#analysis-error").textContent = "";
});

$("#analyze-button").addEventListener("click", async () => {
  try {
    const targetRoi = Number($("#target-roi").value || 0);
    await chrome.storage.local.set({ targetRoi });
    analysis = analyzeReport(parseCsv(await reportFile.text()), targetRoi);
    renderAnalysis(analysis);
    $("#analysis-error").textContent = "";
  } catch (error) {
    $("#analysis-error").textContent = error.message || "分析失败，请检查 CSV 格式";
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
    card.append(element("strong", "", count), element("span", "", name.replace("且", "\n")));
    segments.append(card);
  }
  const top = $("#top-creatives");
  top.replaceChildren();
  result.topCreatives.slice(0, 5).forEach((row) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", row.creativeName || "未命名素材"), element("span", `badge${row.segment === "高消耗且达标" ? "" : " warn"}`, row.segment));
    card.append(head, element("p", "", `消耗 ¥${formatMoney(row.spend)} · ROI ${row.roi.toFixed(2)} · CTR ${(row.ctr * 100).toFixed(2)}%`));
    top.append(card);
  });
  const matrix = $("#test-matrix");
  matrix.replaceChildren();
  result.testMatrix.forEach((row) => {
    const card = element("article", "item");
    const head = element("div", "item-head");
    head.append(element("strong", "", `${row.id} · ${row.type}`), element("span", `badge${row.type === "基线" ? "" : " warn"}`, `只改 ${row.singleVariable}`));
    card.append(head, element("p", "", `钩子：${row.hook || "待填写"}`), element("p", "", `人群：${row.audience || "待填写"} · 卖点：${row.sellingPoint || "待填写"} · 场景：${row.scene || "待填写"}`));
    matrix.append(card);
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

$("#export-json").addEventListener("click", () => analysis && download("qianchuan-analysis.json", JSON.stringify(analysis, null, 2), "application/json"));
$("#export-md").addEventListener("click", () => analysis && download("qianchuan-analysis.md", toMarkdown(analysis), "text/markdown"));

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
    matchData = { generatedAt: new Date().toISOString(), platformAssetCount: platformInput.files.length, ownedMasterCount: masters.length, matches, notice: "仅进行本地指纹和名称匹配，不检测、移除、破解或规避平台水印。" };
    renderMatches(matchData);
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

$("#export-matches").addEventListener("click", () => matchData && download("owned-master-matches.json", JSON.stringify(matchData, null, 2), "application/json"));
