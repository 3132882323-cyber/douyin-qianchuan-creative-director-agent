import { spreadsheetSafeText } from "./release-safety.js";

export const FIELD_DEFINITIONS = {
  creativeName: { label: "素材名称", required: true },
  spend: { label: "消耗", required: true },
  impressions: { label: "展示量" },
  clicks: { label: "点击量" },
  conversions: { label: "成交订单" },
  gmv: { label: "成交金额" },
  roi: { label: "支付 ROI" },
  audience: { label: "人群标签" },
  hook: { label: "前三秒钩子" },
  sellingPoint: { label: "核心主张" },
  scene: { label: "拍摄场景" }
};

export const TAG_FIELDS = ["audience", "hook", "sellingPoint", "scene"];
export const CSV_STRUCTURE_LIMITS = Object.freeze({ maxRows: 50_000, maxColumns: 200 });

export const ALIASES = {
  creativeName: ["creative_name", "creativeName", "素材名称", "创意名称", "素材", "创意", "广告创意名称", "视频名称", "creative"],
  spend: ["spend", "消耗", "总消耗", "花费", "广告消耗", "cost"],
  impressions: ["impressions", "展示", "展示量", "曝光", "曝光量"],
  clicks: ["clicks", "点击", "点击量", "组件点击量"],
  conversions: ["conversions", "转化", "转化数", "成交订单", "成交订单数", "支付订单量", "orders"],
  gmv: ["gmv", "GMV", "成交金额", "支付金额", "支付 GMV", "成交 GMV"],
  roi: ["roi", "ROI", "支付ROI", "支付 ROI", "整体支付ROI", "整体支付 ROI", "roas", "ROAS"],
  audience: ["audience", "人群", "目标人群", "人群标签"],
  hook: ["hook", "钩子", "前三秒", "前三秒钩子", "开场钩子"],
  sellingPoint: ["selling_point", "sellingPoint", "卖点", "核心卖点", "利益点", "angle"],
  scene: ["scene", "场景", "拍摄场景", "使用场景"]
};

export const CREATIVE_TASK_TEMPLATES = {
  custom: { label: "空白任务" },
  performance: {
    label: "效果验证",
    creativeGoal: "用可拍摄、可核验的证据说明核心主张",
    evidence: "同机位对比、过程实拍、关键细节特写",
    shootingConstraints: "固定机位、统一光线、保留完整测试条件",
    riskNotes: "不使用无法证明的效果承诺或绝对化表达"
  },
  scenario: {
    label: "场景共鸣",
    creativeGoal: "让目标受众快速识别自己的使用场景与问题",
    evidence: "真实场景、人物动作、问题发生与解决过程",
    shootingConstraints: "优先实景拍摄，确保人物与场景素材已授权",
    riskNotes: "不夸大焦虑，不虚构用户经历"
  },
  story: {
    label: "人物故事",
    creativeGoal: "用人物经历完成问题—证据—行动的叙事闭环",
    evidence: "人物口述、过程记录、可核验的前后变化",
    shootingConstraints: "准备采访提纲、环境声和补充镜头",
    riskNotes: "人物陈述需本人确认，事实与素材授权需复核"
  }
};

const REQUIRED_FIELDS = Object.entries(FIELD_DEFINITIONS).filter(([, value]) => value.required).map(([key]) => key);
const RECOMMENDED_FIELDS = ["impressions", "clicks", "conversions", "gmv", "roi"];

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_（）()·]/g, "");
}

function detectDelimiter(source) {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const choices = [",", "\t", ";"];
  return choices.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
}

export function parseCsvDocument(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
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
  if (quoted) throw new Error("CSV 存在未闭合的引号字段");
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const headers = rows[0].map((cell) => cell.trim());
  if (headers.length > CSV_STRUCTURE_LIMITS.maxColumns) throw new Error(`CSV 列数超过 ${CSV_STRUCTURE_LIMITS.maxColumns} 列上限`);
  if (headers.some((header) => !header)) throw new Error("CSV 表头不能包含空白列名");
  if (new Set(headers).size !== headers.length) throw new Error("CSV 表头包含重复列名，请先修改后再导入");
  if (rows.length - 1 > CSV_STRUCTURE_LIMITS.maxRows) throw new Error(`CSV 数据超过 ${CSV_STRUCTURE_LIMITS.maxRows.toLocaleString("zh-CN")} 行上限`);
  const dataRows = rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""])));
  return { headers, rows: dataRows, delimiter };
}

export function parseCsv(text) {
  return parseCsvDocument(text).rows;
}

export function inspectColumnMapping(headers, preferredMapping = {}) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const mapping = {};
  for (const [standard, aliases] of Object.entries(ALIASES)) {
    const preferred = preferredMapping[standard];
    if (preferred && headers.includes(preferred)) {
      mapping[standard] = preferred;
      continue;
    }
    const found = [standard, ...aliases].map(normalizeHeader).map((alias) => normalizedHeaders.get(alias)).find(Boolean);
    if (found) mapping[standard] = found;
  }
  const missingRequired = REQUIRED_FIELDS.filter((key) => !mapping[key]);
  const missingRecommended = RECOMMENDED_FIELDS.filter((key) => !mapping[key]);
  return { mapping, missingRequired, missingRecommended };
}

export function resolveColumns(headers, preferredMapping = {}) {
  const inspected = inspectColumnMapping(headers, preferredMapping);
  if (inspected.missingRequired.length) {
    const labels = inspected.missingRequired.map((key) => FIELD_DEFINITIONS[key].label);
    throw new Error(`缺少必需字段：${labels.join("、")}`);
  }
  return inspected.mapping;
}

export function numberOf(value) {
  const raw = String(value ?? "").trim().replace(/[,%¥￥,]/g, "");
  if (!raw || ["-", "--", "N/A", "n/a", "null"].includes(raw)) return 0;
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

function diagnoseRow(row, thresholds, targetRoi) {
  const enoughSample = row.spend >= thresholds.spendFloor || row.impressions >= thresholds.impressionFloor;
  const ctrGood = row.ctr >= thresholds.ctrMedian;
  const cvrGood = row.cvr >= thresholds.cvrMedian;
  if (!enoughSample) return { confidence: "低", diagnosis: "样本不足，继续小额验证，不宜直接判定创意失败" };
  if (row.roi >= targetRoi && ctrGood) return { confidence: "高", diagnosis: "跑量与回报均达标，优先作为下一轮基线" };
  if (ctrGood && !cvrGood) return { confidence: "中", diagnosis: "点击表现较好但转化承接偏弱，保留钩子并强化主张证据" };
  if (!ctrGood && cvrGood) return { confidence: "中", diagnosis: "转化承接尚可但开场吸引不足，优先测试前三秒钩子" };
  return { confidence: "中", diagnosis: "已有消耗但核心指标未达标，拆分钩子、核心主张或场景做单变量测试" };
}

export function analyzeReport(rawRows, targetRoi = 1, preferredMapping = {}) {
  if (!rawRows.length) throw new Error("报表没有数据行");
  const headers = [...new Set(rawRows.flatMap((row) => Object.keys(row)))];
  const columns = resolveColumns(headers, preferredMapping);
  const rows = rawRows.map((raw, index) => {
    const get = (key) => columns[key] ? String(raw[columns[key]] ?? "").trim() : "";
    const spend = numberOf(get("spend"));
    const gmv = numberOf(get("gmv"));
    const suppliedRoi = numberOf(get("roi"));
    const conversions = numberOf(get("conversions"));
    const impressions = numberOf(get("impressions"));
    const clicks = numberOf(get("clicks"));
    return {
      sourceIndex: index,
      creativeName: get("creativeName") || `未命名素材 ${index + 1}`,
      spend,
      gmv,
      roi: suppliedRoi || (spend ? gmv / spend : 0),
      impressions,
      clicks,
      conversions,
      ctr: impressions ? clicks / impressions : 0,
      cvr: clicks ? conversions / clicks : 0,
      cpa: conversions ? spend / conversions : null,
      audience: get("audience"),
      hook: get("hook"),
      sellingPoint: get("sellingPoint"),
      scene: get("scene")
    };
  });
  const spendFloor = median(rows.map((row) => row.spend).filter((value) => value > 0));
  const thresholds = {
    spendFloor,
    impressionFloor: median(rows.map((row) => row.impressions).filter((value) => value > 0)),
    ctrMedian: median(rows.map((row) => row.ctr).filter((value) => value > 0)),
    cvrMedian: median(rows.map((row) => row.cvr).filter((value) => value > 0))
  };
  for (const row of rows) {
    if (row.spend >= spendFloor && row.roi >= targetRoi) row.segment = "高消耗且达标";
    else if (row.spend >= spendFloor) row.segment = "起量但不达标";
    else row.segment = "低曝光待验证";
    Object.assign(row, diagnoseRow(row, thresholds, targetRoi));
  }
  const rank = { "高消耗且达标": 2, "起量但不达标": 1, "低曝光待验证": 0 };
  const ranked = [...rows].sort((a, b) => rank[b.segment] - rank[a.segment] || b.spend - a.spend || b.roi - a.roi);
  const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
  const totalGmv = rows.reduce((sum, row) => sum + row.gmv, 0);
  const suppliedRoiSpend = rows.reduce((sum, row) => sum + (row.roi ? row.spend : 0), 0);
  const weightedRoi = suppliedRoiSpend ? rows.reduce((sum, row) => sum + row.roi * row.spend, 0) / suppliedRoiSpend : 0;
  return {
    generatedAt: new Date().toISOString(),
    columns,
    summary: {
      creativeCount: rows.length,
      totalSpend,
      totalGmv,
      blendedRoi: totalGmv && totalSpend ? totalGmv / totalSpend : weightedRoi,
      targetRoi,
      ...thresholds
    },
    segments: Object.fromEntries(Object.keys(rank).map((name) => [name, rows.filter((row) => row.segment === name).length])),
    rows,
    topCreatives: ranked.slice(0, 10),
    tagInsights: Object.fromEntries(TAG_FIELDS.map((field) => [field, aggregate(rows, field)])),
    caveats: ["低消耗素材不能直接判定为创意失败。", "标签聚合是相关性观察，不代表因果关系。", "缺少成交金额与 ROI 时，混合 ROI 无法计算。"]
  };
}

export function normalizeCreativeTask(task = {}) {
  const source = task && typeof task === "object" && !Array.isArray(task) ? task : {};
  return {
    subject: String(source.subject ?? "").trim(),
    targetAudience: String(source.targetAudience ?? "").trim(),
    creativeGoal: String(source.creativeGoal ?? "").trim(),
    audienceProblems: String(source.audienceProblems ?? "").trim(),
    coreClaim: String(source.coreClaim ?? "").trim(),
    evidence: String(source.evidence ?? "").trim(),
    shootingConstraints: String(source.shootingConstraints ?? "").trim(),
    riskNotes: String(source.riskNotes ?? "").trim(),
    duration: [15, 30, 60].includes(Number(source.duration)) ? Number(source.duration) : 15
  };
}

export function migrateLegacyProductBrief(legacy = {}) {
  const source = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {};
  return {
    ...normalizeCreativeTask({
      subject: source.productName,
      targetAudience: source.targetAudience,
      creativeGoal: source.creativeGoal,
      audienceProblems: source.painPoints,
      coreClaim: source.sellingPoints,
      evidence: source.evidence,
      shootingConstraints: source.shootingConditions,
      riskNotes: source.forbiddenExpressions,
      duration: source.duration
    }),
    _migration: {
      source: "productBrief",
      archivedLegacyData: structuredClone(source)
    }
  };
}

function splitIdeas(value) {
  return String(value ?? "").split(/[，,、；;\n]/).map((item) => item.trim()).filter(Boolean);
}

function first(value, fallback) {
  return splitIdeas(value)[0] || fallback;
}

function shorten(value, length = 24) {
  const text = String(value ?? "").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function materialCode(name, generatedAt = new Date()) {
  if (!String(name ?? "").trim()) {
    const date = generatedAt.toISOString().slice(0, 10).replaceAll("-", "");
    return `MAT${date}`;
  }
  let hash = 0x811c9dc5;
  for (const char of String(name)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `MAT${hash.toString(36).toUpperCase().padStart(7, "0")}`;
}

function batchTimeCode(generatedAt) {
  return generatedAt.toISOString().replace(/[-:.Z]/gu, "");
}

function uniqueVariants(values, fallbacks) {
  const result = [];
  for (const item of [...values, ...fallbacks]) {
    const value = String(item ?? "").trim();
    if (value && !result.includes(value)) result.push(value);
    if (result.length === 4) break;
  }
  return result;
}

function variantCandidates(variable, task, baseline) {
  const pain = first(task.audienceProblems, "受众正在解决的具体问题");
  const claims = splitIdeas(task.coreClaim);
  const evidence = first(task.evidence, "真实可核验的证据");
  const goal = first(task.creativeGoal, "把问题、证据和行动说清楚");
  const candidates = {
    hook: [baseline.hook, `还在被${pain}困扰？`, `${evidence}，结果到底怎么样`, `${goal}，先看证据再判断`],
    sellingPoint: [baseline.sellingPoint, ...claims, evidence],
    scene: [baseline.scene, ...splitIdeas(task.shootingConstraints), "真实使用场景", "同机位前后对比"],
    audience: [baseline.audience, ...splitIdeas(task.targetAudience), `正在解决${pain}的人`, "首次接触这一主题的人"]
  };
  const fallbacks = {
    hook: ["直接点出核心问题", "展示过程与变化", "用可验证证据建立信任", "明确本条内容的观看价值"],
    sellingPoint: ["核心主张", "使用体验", "可信证据", "行动价值"],
    scene: ["主体近景", "真实使用", "问题演示", "结果对比"],
    audience: ["核心目标受众", "高意向受众", "问题困扰人群", "首次接触人群"]
  };
  return uniqueVariants(candidates[variable], fallbacks[variable]);
}

function buildScript(task, creative) {
  const pain = first(task.audienceProblems, "这个常见问题");
  const claim = creative.coreClaim || creative.sellingPoint || first(task.coreClaim, "本条内容的核心主张");
  const evidence = first(task.evidence, "把真实细节拍清楚");
  const subject = task.subject || "这个主题";
  const lines = [
    creative.hook || `如果你也在意${pain}，先看清事实再判断。`,
    `${subject}这条素材先回应${pain}，核心主张是${claim}。`,
    `镜头直接看${evidence}，不靠口头夸张。`,
    `适合${creative.audience || task.targetAudience || "有相关需求的人"}；行动引导发布前由编导补齐，并人工核验所有事实与证据。`
  ];
  if (task.duration >= 30) lines.splice(2, 0, `我们会在${creative.scene || "真实使用场景"}里，把过程和结果完整演示一遍。`);
  return lines.join("\n");
}

function buildStoryboard(task, creative) {
  const duration = task.duration;
  const middle = duration === 15 ? "3-10秒" : duration === 30 ? "3-20秒" : "3-45秒";
  const close = duration === 15 ? "10-15秒" : duration === 30 ? "20-30秒" : "45-60秒";
  const claim = creative.coreClaim || creative.sellingPoint || first(task.coreClaim, "核心主张");
  return [
    `0-3秒｜近景/问题现场｜${creative.hook || "直接提出受众问题"}｜大字幕只保留一个信息点`,
    `${middle}｜${creative.scene || "真实使用场景"}｜演示${claim}与${first(task.evidence, "可信证据")}｜关键细节给特写`,
    `${close}｜人物、结果与行动提示同框｜明确下一步行动并保留事实核验空间｜避免制造虚假紧迫感`
  ].join("\n");
}

function buildProduction(task, creative) {
  const claim = creative.coreClaim || creative.sellingPoint || "核心主张";
  const compliance = [
    "所有事实、数据、案例和证据必须由编导人工核验。",
    "效果展示需保留测试条件，不使用无法证明的绝对化表述。",
    "人物、音乐、字体和素材须确认授权。",
    task.riskNotes ? `本任务风险备注：${task.riskNotes}` : "发布前补充并检查项目风险表达。"
  ];
  return {
    spokenScript: buildScript(task, creative),
    storyboard: buildStoryboard(task, creative),
    shootingTask: [`测试编号：${creative.id}`, `场景：${creative.scene || "待确认"}`, `受众：${creative.audience || "待确认"}`, `必拍证据：${first(task.evidence, "主体与过程细节")}`, `拍摄限制：${task.shootingConstraints || "请编导补充机位、演员、道具与场地"}`].join("\n"),
    editingNotes: `前三秒只表达“${shorten(creative.hook || "核心问题")}”；中段用特写证明“${shorten(claim)}”；${task.duration} 秒内完成问题—证据—行动闭环，避免无关转场。`,
    subtitleHighlights: [creative.hook, claim, first(task.evidence, "真实证据"), first(task.creativeGoal, "行动引导")].filter(Boolean).map((item) => `• ${item}`).join("\n"),
    complianceChecklist: compliance.join("\n")
  };
}

const PLAN_SUMMARY_FIELDS = ["creativeCount", "totalSpend", "totalGmv", "blendedRoi", "targetRoi", "spendFloor", "impressionFloor", "ctrMedian", "cvrMedian"];
const PLAN_ROW_TEXT_FIELDS = ["creativeName", "audience", "hook", "sellingPoint", "scene", "segment", "confidence", "diagnosis"];
const PLAN_ROW_NUMBER_FIELDS = ["sourceIndex", "spend", "gmv", "roi", "impressions", "clicks", "conversions", "ctr", "cvr", "cpa"];

function finiteFingerprintNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function creativePlanDependencySnapshot(inputTask, analysis, options = {}) {
  const allowedVariables = ["hook", "sellingPoint", "scene", "audience"];
  const testVariable = allowedVariables.includes(options.testVariable) ? options.testVariable : "hook";
  const summarySource = analysis?.summary && typeof analysis.summary === "object" ? analysis.summary : {};
  const minSpend = Math.max(1, numberOf(options.minSpend) || Math.round(Math.max(finiteFingerprintNumber(summarySource.spendFloor), 300)));
  const columnsSource = analysis?.columns && typeof analysis.columns === "object" ? analysis.columns : {};
  const summary = Object.fromEntries(PLAN_SUMMARY_FIELDS.map((key) => [key, finiteFingerprintNumber(summarySource[key])]));
  const topCreatives = Array.isArray(analysis?.topCreatives) ? analysis.topCreatives.map((entry) => {
    const row = entry && typeof entry === "object" ? entry : {};
    return {
      ...Object.fromEntries(PLAN_ROW_TEXT_FIELDS.map((key) => [key, String(row[key] ?? "").trim()])),
      ...Object.fromEntries(PLAN_ROW_NUMBER_FIELDS.map((key) => [key, finiteFingerprintNumber(row[key])]))
    };
  }) : [];
  const tagSource = analysis?.tagInsights && typeof analysis.tagInsights === "object" ? analysis.tagInsights : {};
  const tagInsights = Object.fromEntries(TAG_FIELDS.map((field) => [field, Array.isArray(tagSource[field]) ? tagSource[field].map((entry) => ({
    value: String(entry?.value ?? "").trim(),
    creativeCount: finiteFingerprintNumber(entry?.creativeCount),
    spend: finiteFingerprintNumber(entry?.spend),
    roi: finiteFingerprintNumber(entry?.roi)
  })) : []]));
  return {
    creativeTask: normalizeCreativeTask(inputTask),
    analysis: {
      columns: Object.fromEntries(Object.keys(FIELD_DEFINITIONS).filter((key) => typeof columnsSource[key] === "string").map((key) => [key, columnsSource[key].trim()])),
      summary,
      topCreatives,
      tagInsights
    },
    testVariable,
    minSpend
  };
}

export function creativePlanDependencyFingerprint(inputTask, analysis, options = {}) {
  return `fnv1a32:${fnv1a(stableSerialize(creativePlanDependencySnapshot(inputTask, analysis, options)))}`;
}

export function generateCreativePlan(inputTask, analysis, options = {}) {
  const creativeTask = normalizeCreativeTask(inputTask);
  if (!analysis?.topCreatives?.length) throw new Error("请先完成素材复盘");
  const dependencies = creativePlanDependencySnapshot(creativeTask, analysis, options);
  const variable = dependencies.testVariable;
  const variableLabels = { hook: "前三秒钩子", sellingPoint: "核心主张", scene: "拍摄场景", audience: "目标受众" };
  const variableCodes = { hook: "HOOK", sellingPoint: "CLAIM", scene: "SCENE", audience: "AUD" };
  const baseline = analysis.topCreatives[0];
  const variants = variantCandidates(variable, creativeTask, baseline);
  const minSpend = dependencies.minSpend;
  const observationMetrics = variable === "hook" ? "3 秒留存、CTR，辅助观察 ROI" : variable === "sellingPoint" ? "CVR、ROI，辅助观察 CTR" : variable === "scene" ? "CTR、CVR、ROI" : "CTR、CVR、CPA、ROI";
  const generatedAt = new Date();
  const batchId = `${materialCode(creativeTask.subject || baseline.creativeName, generatedAt)}-${variableCodes[variable]}-${batchTimeCode(generatedAt)}`;
  const items = variants.map((variant, index) => {
    const creative = {
      id: `${batchId}-${index === 0 ? "B00" : `A${String(index).padStart(2, "0")}`}`,
      type: index === 0 ? "基线" : "变体",
      baselineCreative: baseline.creativeName,
      singleVariable: variableLabels[variable],
      variant,
      audience: variable === "audience" ? variant : (baseline.audience || creativeTask.targetAudience),
      hook: variable === "hook" ? variant : (baseline.hook || first(creativeTask.audienceProblems, "直接提出核心问题")),
      coreClaim: variable === "sellingPoint" ? variant : (baseline.sellingPoint || first(creativeTask.coreClaim, "核心主张")),
      scene: variable === "scene" ? variant : (baseline.scene || first(creativeTask.shootingConstraints, "真实使用场景")),
      hypothesis: index === 0 ? `保留历史素材“${baseline.creativeName}”作为对照，验证原有表现能否复现。` : `仅将${variableLabels[variable]}改为“${variant}”，预期在不损失 ROI 的前提下改善${observationMetrics.split("，")[0]}。`,
      fixedElements: ["事实口径与行动引导", ...Object.entries({ audience: "目标受众", hook: "前三秒钩子", sellingPoint: "核心主张", scene: "拍摄场景" }).filter(([key]) => key !== variable).map(([, label]) => label)].join("、"),
      observationMetrics,
      minSpend,
      stopCondition: `单条消耗达到 ¥${formatMoney(minSpend)} 后再判断；若核心指标低于基线 80% 且无改善趋势，则停止。`,
      successAction: `若达到目标 ROI ${analysis.summary.targetRoi.toFixed(2)} 且核心指标优于基线，保留该变量进入下一轮测试。`
    };
    creative.production = buildProduction(creativeTask, creative);
    return creative;
  });
  return {
    generatedAt: generatedAt.toISOString(),
    version: "1.4.0",
    batchId,
    dependencyFingerprint: creativePlanDependencyFingerprint(creativeTask, analysis, { testVariable: variable, minSpend }),
    creativeTask,
    sourceSummary: analysis.summary,
    testVariable: variable,
    items,
    notice: "本方案由本地规则基于可选创作任务与历史报表生成，结论需由编导结合样本量、事实证据与平台规则复核。"
  };
}

export function normalizedStem(name) {
  return String(name ?? "").toLowerCase().replace(/\.[^.]+$/, "").replace(/(?:[-_ ](?:copy|download|douyin|qianchuan|抖音|千川|副本))+$/g, "").replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

export function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value || 0);
}

function markdownCell(value) {
  return String(value ?? "-").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function toMarkdown(result) {
  const lines = ["# 千川素材复盘", "", `- 素材数：${result.summary.creativeCount}`, `- 总消耗：¥${formatMoney(result.summary.totalSpend)}`, `- 混合 ROI：${result.summary.blendedRoi.toFixed(2)}`, `- 目标 ROI：${result.summary.targetRoi.toFixed(2)}`, "", "## 优先复盘素材", "", "| 素材 | 分层 | 消耗 | ROI | 诊断 |", "|---|---|---:|---:|---|"];
  for (const row of result.topCreatives) lines.push(`| ${markdownCell(row.creativeName)} | ${row.segment} | ¥${formatMoney(row.spend)} | ${row.roi.toFixed(2)} | ${markdownCell(row.diagnosis)} |`);
  lines.push("", "## 注意", "", ...result.caveats.map((item) => `- ${item}`));
  return lines.join("\n");
}

export function planToMarkdown(plan) {
  const creativeTask = plan.creativeTask ?? migrateLegacyProductBrief(plan.brief ?? {});
  const lines = ["# 下一版素材任务", "", `- 素材主题：${creativeTask.subject || "未填写（不影响生成）"}`, `- 目标受众：${creativeTask.targetAudience || "未填写"}`, `- 创作目标：${creativeTask.creativeGoal || "未填写"}`, `- 核心主张：${creativeTask.coreClaim || "未填写"}`, `- 可用证据：${creativeTask.evidence || "未填写"}`, `- 视频时长：${creativeTask.duration} 秒`, "", "## 测试策略", ""];
  for (const item of plan.items) {
    lines.push(`### ${item.id} · ${item.type}`, "", `- 测试假设：${item.hypothesis}`, `- 基线素材：${item.baselineCreative}`, `- 唯一变量：${item.singleVariable} → ${item.variant}`, `- 保持不变：${item.fixedElements}`, `- 观察指标：${item.observationMetrics}`, `- 最低消耗：¥${formatMoney(item.minSpend)}`, `- 停止条件：${item.stopCondition}`, `- 成功后：${item.successAction}`, "", "#### 口播稿", "", item.production.spokenScript, "", "#### 分镜", "", item.production.storyboard, "", "#### 拍摄任务单", "", item.production.shootingTask, "", "#### 剪辑要求", "", item.production.editingNotes, "", "#### 字幕重点", "", item.production.subtitleHighlights, "", "#### 合规检查", "", item.production.complianceChecklist, "");
  }
  lines.push("> " + plan.notice);
  return lines.join("\n");
}

function runSheetText(value, fallback = "待补充") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

const SHOOT_READINESS_FIELDS = Object.freeze([
  { path: "hook", label: "前三秒钩子" },
  { path: "audience", label: "目标受众" },
  { path: "scene", label: "拍摄场景" },
  { path: "production.spokenScript", label: "口播稿" },
  { path: "production.storyboard", label: "分镜" },
  { path: "production.shootingTask", label: "现场任务" },
  { path: "production.editingNotes", label: "剪辑要求" },
  { path: "production.subtitleHighlights", label: "字幕重点" },
  { path: "production.complianceChecklist", label: "发布前检查" }
]);

function nestedValue(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function shootFieldReady(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && !/(?:待确认|待补充|未填写|请编导补充)/u.test(text));
}

export function assessPlanShootReadiness(plan) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) throw new Error("开拍准备检查缺少可执行任务");
  const items = plan.items.map((item, index) => {
    const missing = SHOOT_READINESS_FIELDS
      .filter((definition) => !shootFieldReady(nestedValue(item, definition.path)))
      .map((definition) => definition.label);
    return {
      index,
      id: runSheetText(item?.id, `任务 ${index + 1}`),
      ready: missing.length === 0,
      missing
    };
  });
  const readyCount = items.filter((item) => item.ready).length;
  return {
    ready: readyCount === items.length,
    readyCount,
    total: items.length,
    missingCount: items.reduce((total, item) => total + item.missing.length, 0),
    items
  };
}

export function planToRunSheet(plan, { itemIndex } = {}) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) throw new Error("开拍清单缺少可执行任务");
  if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= plan.items.length)) {
    throw new Error("开拍清单任务序号无效");
  }
  const indexedItems = plan.items.map((item, index) => ({ item, index }));
  const selected = itemIndex === undefined ? indexedItems : [indexedItems[itemIndex]];
  const lines = [
    itemIndex === undefined ? "# 千川现场开拍清单" : "# 千川单条开拍单",
    "",
    `- 测试批次：${runSheetText(plan.batchId, "未记录")}`,
    `- 共 ${plan.items.length} 条：先拍基线，再按编号拍变体。`,
    "- 现场原则：每条只替换本轮唯一变量；其余机位、演员、光线、证据、时长和行动引导按方案保持一致。",
    ""
  ];
  for (const { item, index } of selected) {
    const production = item?.production || {};
    const orderLabel = index === 0 ? "先拍基线" : `第 ${index + 1} 条变体`;
    lines.push(
      `## ${String(index + 1).padStart(2, "0")} · ${runSheetText(item?.id, "未编号")} · ${runSheetText(item?.type, "任务")}`,
      "",
      `- 拍摄顺序：${orderLabel}`,
      `- 本条只改：${runSheetText(item?.singleVariable)} → ${runSheetText(item?.variant)}`,
      `- 前三秒：${runSheetText(item?.hook)}`,
      `- 受众：${runSheetText(item?.audience)}`,
      `- 场景：${runSheetText(item?.scene)}`,
      `- 其余保持：${runSheetText(item?.fixedElements)}`,
      "",
      "### 现场必拍",
      "",
      runSheetText(production.shootingTask),
      "",
      "### 剪辑交付",
      "",
      runSheetText(production.editingNotes),
      "",
      "### 字幕重点",
      "",
      runSheetText(production.subtitleHighlights),
      "",
      "### 发布前检查",
      "",
      runSheetText(production.complianceChecklist),
      ""
    );
  }
  lines.push("> 本清单只重排已生成并可编辑的本地方案，不新增效果判断；事实、授权、证据和发布表达仍需编导人工核对。");
  return lines.join("\n");
}

function csvCell(value) {
  const text = spreadsheetSafeText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function planToCsv(plan) {
  const headers = ["测试编号", "类型", "测试假设", "基线素材", "唯一变量", "变量值", "目标受众", "钩子", "核心主张", "场景", "观察指标", "最低消耗", "停止条件", "成功后动作", "口播稿", "分镜", "拍摄任务单", "剪辑要求", "字幕重点", "合规检查"];
  const rows = plan.items.map((item) => [item.id, item.type, item.hypothesis, item.baselineCreative, item.singleVariable, item.variant, item.audience, item.hook, item.coreClaim ?? item.sellingPoint, item.scene, item.observationMetrics, item.minSpend, item.stopCondition, item.successAction, item.production.spokenScript, item.production.storyboard, item.production.shootingTask, item.production.editingNotes, item.production.subtitleHighlights, item.production.complianceChecklist]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
