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
  sellingPoint: { label: "核心卖点" },
  scene: { label: "拍摄场景" }
};

export const TAG_FIELDS = ["audience", "hook", "sellingPoint", "scene"];

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

export const BRIEF_TEMPLATES = {
  custom: { label: "空白模板" },
  apparel: {
    label: "服饰",
    painPoints: "版型不合身、面料不舒适、上身效果与想象不一致",
    evidence: "面料近景、上身对比、尺码实测、真实买家反馈",
    shootingConditions: "真人试穿、商品近景、室内全身机位",
    forbiddenExpressions: "绝对显瘦、全网最低、百分百不起球"
  },
  beauty: {
    label: "美妆",
    painPoints: "妆效不持久、肤感厚重、选色困难",
    evidence: "上脸实测、持妆时间记录、成分或检测资料",
    shootingConditions: "素颜与上妆对比、自然光近景、不同肤质模特",
    forbiddenExpressions: "医疗功效、永久改善、适合所有肤质"
  },
  food: {
    label: "食品",
    painPoints: "口味不确定、分量不清楚、食用不方便",
    evidence: "配料表、净含量、开袋实拍、食用场景",
    shootingConditions: "食品特写、开袋试吃、包装信息清晰可见",
    forbiddenExpressions: "治疗疾病、零风险、夸大保健功效"
  },
  cleaning: {
    label: "家清",
    painPoints: "清洁费力、顽渍难处理、使用步骤复杂",
    evidence: "同一污渍前后对比、计时实测、正确用量演示",
    shootingConditions: "真实家居场景、固定机位、前后对比",
    forbiddenExpressions: "百分百除菌、一次根除、无任何刺激"
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
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const headers = rows[0].map((cell) => cell.trim());
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
  if (ctrGood && !cvrGood) return { confidence: "中", diagnosis: "点击表现较好但转化承接偏弱，保留钩子并强化卖点证据" };
  if (!ctrGood && cvrGood) return { confidence: "中", diagnosis: "转化承接尚可但开场吸引不足，优先测试前三秒钩子" };
  return { confidence: "中", diagnosis: "已有消耗但核心指标未达标，拆分钩子、卖点或场景做单变量测试" };
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

export function normalizeBrief(brief = {}) {
  return {
    productName: String(brief.productName ?? "").trim(),
    category: String(brief.category ?? "").trim(),
    targetAudience: String(brief.targetAudience ?? "").trim(),
    painPoints: String(brief.painPoints ?? "").trim(),
    sellingPoints: String(brief.sellingPoints ?? "").trim(),
    evidence: String(brief.evidence ?? "").trim(),
    promotion: String(brief.promotion ?? "").trim(),
    shootingConditions: String(brief.shootingConditions ?? "").trim(),
    forbiddenExpressions: String(brief.forbiddenExpressions ?? "").trim(),
    duration: [15, 30, 60].includes(Number(brief.duration)) ? Number(brief.duration) : 15
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

function productCode(name) {
  let hash = 0;
  for (const char of String(name || "SPU")) hash = (hash + char.codePointAt(0)) % 1000;
  return `SPU${String(hash).padStart(3, "0")}`;
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

function variantCandidates(variable, brief, baseline) {
  const pain = first(brief.painPoints, "用户的核心使用痛点");
  const selling = splitIdeas(brief.sellingPoints);
  const evidence = first(brief.evidence, "真实使用证据");
  const promotion = first(brief.promotion, "当前购买权益");
  const candidates = {
    hook: [baseline.hook, `还在被${pain}困扰？`, `${evidence}，结果到底怎么样`, `${promotion}，先看清再决定`],
    sellingPoint: [baseline.sellingPoint, ...selling, evidence],
    scene: [baseline.scene, ...splitIdeas(brief.shootingConditions), "真实使用场景", "同机位前后对比"],
    audience: [baseline.audience, ...splitIdeas(brief.targetAudience), `正在解决${pain}的人`, "首次购买用户"]
  };
  const fallbacks = {
    hook: ["直接点出核心痛点", "展示使用前后变化", "用可验证证据建立信任", "说明当前购买权益"],
    sellingPoint: ["核心功能利益", "使用体验", "可信证据", "价格与权益"],
    scene: ["产品近景", "真实使用", "问题演示", "结果对比"],
    audience: ["核心购买人群", "高意向人群", "问题困扰人群", "首次购买用户"]
  };
  return uniqueVariants(candidates[variable], fallbacks[variable]);
}

function buildScript(brief, creative) {
  const pain = first(brief.painPoints, "这个常见问题");
  const selling = creative.sellingPoint || first(brief.sellingPoints, "核心卖点");
  const evidence = first(brief.evidence, "把真实细节拍清楚");
  const promotion = first(brief.promotion, "当前购买权益以商品页为准");
  const product = brief.productName || "这款商品";
  const lines = [
    creative.hook || `如果你也在意${pain}，先别急着下单。`,
    `${product}这次重点解决的是${pain}，核心是${selling}。`,
    `镜头直接看${evidence}，不靠口头夸张。`,
    `${promotion}。适合${creative.audience || brief.targetAudience || "有相关需求的人"}，下单前请核对商品页信息。`
  ];
  if (brief.duration >= 30) lines.splice(2, 0, `我们会在${creative.scene || "真实使用场景"}里，把使用步骤和结果完整演示一遍。`);
  return lines.join("\n");
}

function buildStoryboard(brief, creative) {
  const duration = brief.duration;
  const middle = duration === 15 ? "3-10秒" : duration === 30 ? "3-20秒" : "3-45秒";
  const close = duration === 15 ? "10-15秒" : duration === 30 ? "20-30秒" : "45-60秒";
  return [
    `0-3秒｜近景/问题现场｜${creative.hook || "直接提出用户痛点"}｜大字幕只保留一个信息点`,
    `${middle}｜${creative.scene || "真实使用场景"}｜演示${creative.sellingPoint || first(brief.sellingPoints, "核心卖点")}与${first(brief.evidence, "可信证据")}｜关键细节给特写`,
    `${close}｜商品与人物同框｜说明${first(brief.promotion, "购买权益")}并引导核对商品页｜避免制造虚假紧迫感`
  ].join("\n");
}

function buildProduction(brief, creative) {
  const compliance = [
    "商品、价格、优惠、库存等信息必须与实际页面一致。",
    "效果展示保留测试条件，不使用无法证明的绝对化表述。",
    "人物、音乐、字体和素材须确认授权。",
    brief.forbiddenExpressions ? `本项目禁用表达：${brief.forbiddenExpressions}` : "发布前补充并检查项目禁用表达。"
  ];
  return {
    spokenScript: buildScript(brief, creative),
    storyboard: buildStoryboard(brief, creative),
    shootingTask: [`测试编号：${creative.id}`, `场景：${creative.scene || "待确认"}`, `人群：${creative.audience || "待确认"}`, `必拍证据：${first(brief.evidence, "商品与使用细节")}`, `可用条件：${brief.shootingConditions || "请编导补充机位、演员、道具与场地"}`].join("\n"),
    editingNotes: `前三秒只表达“${shorten(creative.hook || "核心痛点")}”；中段用特写证明“${shorten(creative.sellingPoint || "核心卖点")}”；${brief.duration} 秒内完成问题—证据—行动闭环，避免无关转场。`,
    subtitleHighlights: [creative.hook, creative.sellingPoint, first(brief.evidence, "真实证据"), first(brief.promotion, "购买权益")].filter(Boolean).map((item) => `• ${item}`).join("\n"),
    complianceChecklist: compliance.join("\n")
  };
}

export function generateCreativePlan(inputBrief, analysis, options = {}) {
  const brief = normalizeBrief(inputBrief);
  if (!brief.productName) throw new Error("请先填写商品名称");
  if (!analysis?.topCreatives?.length) throw new Error("请先完成素材复盘");
  const allowedVariables = ["hook", "sellingPoint", "scene", "audience"];
  const variable = allowedVariables.includes(options.testVariable) ? options.testVariable : "hook";
  const variableLabels = { hook: "前三秒钩子", sellingPoint: "核心卖点", scene: "拍摄场景", audience: "目标人群" };
  const variableCodes = { hook: "HOOK", sellingPoint: "SELL", scene: "SCENE", audience: "AUD" };
  const baseline = analysis.topCreatives[0];
  const variants = variantCandidates(variable, brief, baseline);
  const minSpend = Math.max(1, numberOf(options.minSpend) || Math.round(Math.max(analysis.summary.spendFloor || 0, 300)));
  const observationMetrics = variable === "hook" ? "3 秒留存、CTR，辅助观察 ROI" : variable === "sellingPoint" ? "CVR、ROI，辅助观察 CTR" : variable === "scene" ? "CTR、CVR、ROI" : "CTR、CVR、CPA、ROI";
  const baseId = `${productCode(brief.productName)}-${variableCodes[variable]}`;
  const items = variants.map((variant, index) => {
    const creative = {
      id: `${baseId}-${index === 0 ? "B00" : `A${String(index).padStart(2, "0")}`}`,
      type: index === 0 ? "基线" : "变体",
      baselineCreative: baseline.creativeName,
      singleVariable: variableLabels[variable],
      variant,
      audience: variable === "audience" ? variant : (baseline.audience || brief.targetAudience),
      hook: variable === "hook" ? variant : (baseline.hook || first(brief.painPoints, "直接提出核心问题")),
      sellingPoint: variable === "sellingPoint" ? variant : (baseline.sellingPoint || first(brief.sellingPoints, "核心卖点")),
      scene: variable === "scene" ? variant : (baseline.scene || first(brief.shootingConditions, "真实使用场景")),
      hypothesis: index === 0 ? `保留历史素材“${baseline.creativeName}”作为对照，验证原有表现能否复现。` : `仅将${variableLabels[variable]}改为“${variant}”，预期在不损失 ROI 的前提下改善${observationMetrics.split("，")[0]}。`,
      fixedElements: ["商品与价格机制", ...Object.entries({ audience: "目标人群", hook: "前三秒钩子", sellingPoint: "核心卖点", scene: "拍摄场景" }).filter(([key]) => key !== variable).map(([, label]) => label)].join("、"),
      observationMetrics,
      minSpend,
      stopCondition: `单条消耗达到 ¥${formatMoney(minSpend)} 后再判断；若核心指标低于基线 80% 且无改善趋势，则停止。`,
      successAction: `若达到目标 ROI ${analysis.summary.targetRoi.toFixed(2)} 且核心指标优于基线，保留该变量进入下一轮测试。`
    };
    creative.production = buildProduction(brief, creative);
    return creative;
  });
  return {
    generatedAt: new Date().toISOString(),
    version: "0.5.0",
    brief,
    sourceSummary: analysis.summary,
    testVariable: variable,
    items,
    notice: "本方案由本地规则基于 Brief 与历史报表生成，结论需由编导结合样本量、商品事实与平台规则复核。"
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
  const { brief } = plan;
  const lines = ["# 下一批素材拍摄方案", "", `- 商品：${brief.productName}`, `- 类目：${brief.category || "未填写"}`, `- 目标人群：${brief.targetAudience || "未填写"}`, `- 视频时长：${brief.duration} 秒`, "", "## 测试策略", ""];
  for (const item of plan.items) {
    lines.push(`### ${item.id} · ${item.type}`, "", `- 测试假设：${item.hypothesis}`, `- 基线素材：${item.baselineCreative}`, `- 唯一变量：${item.singleVariable} → ${item.variant}`, `- 保持不变：${item.fixedElements}`, `- 观察指标：${item.observationMetrics}`, `- 最低消耗：¥${formatMoney(item.minSpend)}`, `- 停止条件：${item.stopCondition}`, `- 成功后：${item.successAction}`, "", "#### 口播稿", "", item.production.spokenScript, "", "#### 分镜", "", item.production.storyboard, "", "#### 拍摄任务单", "", item.production.shootingTask, "", "#### 剪辑要求", "", item.production.editingNotes, "", "#### 字幕重点", "", item.production.subtitleHighlights, "", "#### 合规检查", "", item.production.complianceChecklist, "");
  }
  lines.push("> " + plan.notice);
  return lines.join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function planToCsv(plan) {
  const headers = ["测试编号", "类型", "测试假设", "基线素材", "唯一变量", "变量值", "人群", "钩子", "卖点", "场景", "观察指标", "最低消耗", "停止条件", "成功后动作", "口播稿", "分镜", "拍摄任务单", "剪辑要求", "字幕重点", "合规检查"];
  const rows = plan.items.map((item) => [item.id, item.type, item.hypothesis, item.baselineCreative, item.singleVariable, item.variant, item.audience, item.hook, item.sellingPoint, item.scene, item.observationMetrics, item.minSpend, item.stopCondition, item.successAction, item.production.spokenScript, item.production.storyboard, item.production.shootingTask, item.production.editingNotes, item.production.subtitleHighlights, item.production.complianceChecklist]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
