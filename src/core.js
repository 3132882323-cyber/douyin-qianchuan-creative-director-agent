export const ALIASES = {
  creativeName: ["creative_name", "素材名称", "创意名称", "素材", "creative"],
  spend: ["spend", "消耗", "花费", "cost"],
  impressions: ["impressions", "展示", "展示量"],
  clicks: ["clicks", "点击", "点击量"],
  conversions: ["conversions", "转化", "转化数", "成交订单", "orders"],
  gmv: ["gmv", "GMV", "成交金额", "支付金额"],
  roi: ["roi", "ROI", "支付ROI", "roas", "ROAS"],
  audience: ["audience", "人群", "目标人群"],
  hook: ["hook", "钩子", "前三秒"],
  sellingPoint: ["selling_point", "卖点", "核心卖点", "angle"],
  scene: ["scene", "场景", "拍摄场景"]
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  }
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const headers = rows[0].map((cell) => cell.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""])));
}

export function resolveColumns(headers) {
  const columns = {};
  for (const [standard, aliases] of Object.entries(ALIASES)) {
    const found = aliases.find((alias) => headers.includes(alias));
    if (found) columns[standard] = found;
  }
  const missing = ["creativeName", "spend"].filter((key) => !columns[key]);
  if (missing.length) throw new Error(`缺少必需字段：${missing.join("、")}`);
  return columns;
}

export function numberOf(value) {
  const raw = String(value ?? "").trim().replace(/[,%¥￥]/g, "");
  if (!raw || ["-", "--", "N/A", "n/a"].includes(raw)) return 0;
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return String(value).trim().endsWith("%") ? number / 100 : number;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregate(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    if (!row[field]) continue;
    const list = groups.get(row[field]) ?? [];
    list.push(row);
    groups.set(row[field], list);
  }
  return [...groups.entries()].map(([value, items]) => {
    const spend = items.reduce((sum, item) => sum + item.spend, 0);
    const gmv = items.reduce((sum, item) => sum + item.gmv, 0);
    const weightedRoi = spend ? items.reduce((sum, item) => sum + item.roi * item.spend, 0) / spend : 0;
    return { value, creativeCount: items.length, spend, roi: gmv && spend ? gmv / spend : weightedRoi };
  }).sort((a, b) => b.spend - a.spend || b.roi - a.roi);
}

export function analyzeReport(rawRows, targetRoi = 1) {
  if (!rawRows.length) throw new Error("报表没有数据行");
  const columns = resolveColumns(Object.keys(rawRows[0]));
  const rows = rawRows.map((raw) => {
    const get = (key) => columns[key] ? String(raw[columns[key]] ?? "").trim() : "";
    const spend = numberOf(get("spend"));
    const gmv = numberOf(get("gmv"));
    const suppliedRoi = numberOf(get("roi"));
    const conversions = numberOf(get("conversions"));
    const impressions = numberOf(get("impressions"));
    const clicks = numberOf(get("clicks"));
    return {
      creativeName: get("creativeName"), spend, gmv,
      roi: suppliedRoi || (spend ? gmv / spend : 0),
      impressions, clicks, conversions,
      ctr: impressions ? clicks / impressions : 0,
      cpa: conversions ? spend / conversions : null,
      audience: get("audience"), hook: get("hook"),
      sellingPoint: get("sellingPoint"), scene: get("scene")
    };
  });
  const spendFloor = median(rows.map((row) => row.spend).filter((value) => value > 0));
  for (const row of rows) {
    if (row.spend >= spendFloor && row.roi >= targetRoi) row.segment = "高消耗且达标";
    else if (row.spend >= spendFloor) row.segment = "起量但不达标";
    else row.segment = "低曝光待验证";
  }
  const rank = { "高消耗且达标": 2, "起量但不达标": 1, "低曝光待验证": 0 };
  const ranked = [...rows].sort((a, b) => rank[b.segment] - rank[a.segment] || b.spend - a.spend || b.roi - a.roi);
  const best = ranked[0];
  const variable = ["hook", "sellingPoint", "scene", "audience"].find((key) => best[key]) ?? "hook";
  const variants = [best[variable] || "历史基线", "直接痛点", "反常识", "结果展示"];
  const testMatrix = variants.map((variant, index) => ({
    id: `T${index + 1}`,
    type: index === 0 ? "基线" : "变体",
    audience: best.audience,
    hook: variable === "hook" ? variant : best.hook,
    sellingPoint: variable === "sellingPoint" ? variant : best.sellingPoint,
    scene: variable === "scene" ? variant : best.scene,
    singleVariable: variable,
    variant
  }));
  const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const totalGmv = rows.reduce((sum, row) => sum + row.gmv, 0);
  return {
    generatedAt: new Date().toISOString(), columns,
    summary: { creativeCount: rows.length, totalSpend, totalGmv, blendedRoi: totalSpend ? totalGmv / totalSpend : 0, targetRoi, spendFloor },
    segments: Object.fromEntries(Object.keys(rank).map((name) => [name, rows.filter((row) => row.segment === name).length])),
    topCreatives: ranked.slice(0, 10),
    tagInsights: Object.fromEntries(["audience", "hook", "sellingPoint", "scene"].map((field) => [field, aggregate(rows, field)])),
    testMatrix,
    caveats: ["低消耗素材不能直接判定为创意失败。", "标签聚合是相关性观察，不代表因果关系。", "缺少 GMV 时，混合 ROI 可能无法计算。"]
  };
}

export function normalizedStem(name) {
  return name.toLowerCase().replace(/\.[^.]+$/, "").replace(/(?:[-_ ](?:copy|download|douyin|qianchuan|抖音|千川|副本))+$/g, "").replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

export function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value || 0);
}

export function toMarkdown(result) {
  const lines = ["# 千川素材分析", "", `- 素材数：${result.summary.creativeCount}`, `- 总消耗：${formatMoney(result.summary.totalSpend)}`, `- 混合 ROI：${result.summary.blendedRoi.toFixed(2)}`, "", "## 下一轮测试矩阵", "", "| 方案 | 类型 | 人群 | 钩子 | 卖点 | 场景 | 唯一变量 |", "|---|---|---|---|---|---|---|"];
  for (const row of result.testMatrix) lines.push(`| ${row.id} | ${row.type} | ${row.audience || "-"} | ${row.hook || "-"} | ${row.sellingPoint || "-"} | ${row.scene || "-"} | ${row.singleVariable} |`);
  lines.push("", "## 注意", "", ...result.caveats.map((item) => `- ${item}`));
  return lines.join("\n");
}
