import { parseCsvDocument } from "./core.js";

export const EXPERIMENT_RESULT_LIMITS = Object.freeze({ maxRows: 1000 });
export const EXPERIMENT_QUALITY_WARNING_LABELS = Object.freeze({
  roi_mismatch: "ROI 与成交金额 ÷ 消耗差异较大",
  ctr_mismatch: "CTR 与点击量 ÷ 展示量差异较大",
  cvr_mismatch: "CVR 与转化量 ÷ 点击量差异较大"
});

export function experimentQualityWarningLabel(code) {
  return EXPERIMENT_QUALITY_WARNING_LABELS[code] || "未知口径提醒";
}

const FIELD_ALIASES = Object.freeze({
  testId: ["测试编号", "测试id", "testid", "test_id", "versionid", "version_id", "方案编号", "素材编号"],
  spend: ["消耗", "花费", "spend", "cost"],
  gmv: ["成交金额", "支付金额", "gmv", "revenue"],
  roi: ["roi", "支付roi", "投产比"],
  impressions: ["展示", "展现", "曝光", "impressions"],
  clicks: ["点击", "clicks"],
  conversions: ["转化", "成交", "订单", "conversions", "orders"],
  ctr: ["ctr", "点击率"],
  cvr: ["cvr", "转化率"],
  threeSecondRate: ["3秒播放率", "三秒播放率", "3srate", "three_second_rate"],
  completionRate: ["完播率", "completionrate", "completion_rate"]
});
const MANUAL_RESULT_FIELDS = Object.freeze(["testId", "spend", "gmv", "roi", "impressions", "clicks", "conversions", "ctr", "cvr", "threeSecondRate", "completionRate"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}包含未知字段：${key}`);
  }
}

function normalizedHeader(value) {
  return String(value || "").toLowerCase().replace(/[\s%％()（）/\\_-]+/gu, "");
}

function resolveColumns(headers) {
  const byNormalized = new Map(headers.map((header) => [normalizedHeader(header), header]));
  return Object.fromEntries(Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, aliases.map(normalizedHeader).map((alias) => byNormalized.get(alias)).find(Boolean) || ""]));
}

function metricNumber(value, label, { rate = false, max = 1e12 } = {}) {
  const source = String(value ?? "").trim();
  if (!source) return null;
  const percentage = /[%％]$/u.test(source);
  const normalized = source.replace(/[,%％￥¥\s]/gu, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}不是有效的非负数`);
  const result = rate && (percentage || parsed > 1) ? parsed / 100 : parsed;
  if (rate && result > 1) throw new Error(`${label}必须在 0% 到 100% 之间`);
  if (!rate && result > max) throw new Error(`${label}超过可处理上限`);
  return result;
}

function validateFunnel(metrics, location) {
  if (metrics.impressions !== null && metrics.clicks !== null && metrics.clicks > metrics.impressions) {
    throw new Error(`${location}点击量不能大于展示量`);
  }
  if (metrics.clicks !== null && metrics.conversions !== null && metrics.conversions > metrics.clicks) {
    throw new Error(`${location}转化量不能大于点击量；如平台使用不同归因口径，请先拆分或校正字段`);
  }
}

function materiallyDifferent(actual, expected, absoluteTolerance, relativeTolerance = 0.15) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return Math.abs(actual - expected) > Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance);
}

function metricWarnings(metrics, location, testId, rowNumber = null) {
  const warnings = [];
  if (metrics.spend > 0 && metrics.gmv !== null && metrics.roi !== null) {
    const expected = metrics.gmv / metrics.spend;
    if (materiallyDifferent(metrics.roi, expected, 0.1)) warnings.push({ rowNumber, location, testId, field: "roi", code: "roi_mismatch", message: `${location}ROI 与成交金额 ÷ 消耗差异较大，请核对平台归因口径` });
  }
  if (metrics.impressions > 0 && metrics.clicks !== null && metrics.ctr !== null) {
    const expected = metrics.clicks / metrics.impressions;
    if (materiallyDifferent(metrics.ctr, expected, 0.005, 0.2)) warnings.push({ rowNumber, location, testId, field: "ctr", code: "ctr_mismatch", message: `${location}CTR 与点击量 ÷ 展示量差异较大，请核对字段口径` });
  }
  if (metrics.clicks > 0 && metrics.conversions !== null && metrics.cvr !== null) {
    const expected = metrics.conversions / metrics.clicks;
    if (materiallyDifferent(metrics.cvr, expected, 0.005, 0.2)) warnings.push({ rowNumber, location, testId, field: "cvr", code: "cvr_mismatch", message: `${location}CVR 与转化量 ÷ 点击量差异较大，请核对字段口径` });
  }
  return warnings;
}

function normalizedMetrics(source, labelFor) {
  return {
    spend: metricNumber(source.spend, labelFor("消耗")),
    gmv: metricNumber(source.gmv, labelFor("成交金额")),
    roi: metricNumber(source.roi, labelFor("ROI"), { max: 1e6 }),
    impressions: metricNumber(source.impressions, labelFor("展示")),
    clicks: metricNumber(source.clicks, labelFor("点击")),
    conversions: metricNumber(source.conversions, labelFor("转化")),
    ctr: metricNumber(source.ctr, labelFor("CTR"), { rate: true }),
    cvr: metricNumber(source.cvr, labelFor("CVR"), { rate: true }),
    threeSecondRate: metricNumber(source.threeSecondRate, labelFor("3 秒播放率"), { rate: true }),
    completionRate: metricNumber(source.completionRate, labelFor("完播率"), { rate: true })
  };
}

export function parseManualExperimentResult(value, knownTestIds = []) {
  if (!isRecord(value)) throw new Error("手动结果格式无效");
  exactKeys(value, MANUAL_RESULT_FIELDS, "手动结果");
  const testId = String(value.testId || "").trim();
  if (!testId) throw new Error("请选择要回填的测试版本");
  const known = new Set([...knownTestIds].map((entry) => String(entry)));
  if (!known.has(testId)) throw new Error("测试编号不属于当前项目");
  const metrics = normalizedMetrics(value, (metric) => `手动回填${metric}`);
  if (metrics.spend === null) throw new Error("手动回填缺少消耗");
  validateFunnel(metrics, "手动回填");
  const warnings = metricWarnings(metrics, "手动回填：", testId);
  const record = { testId, metrics, qualityWarnings: warnings.map((entry) => entry.code) };
  return {
    inputMode: "manual",
    columns: Object.fromEntries(MANUAL_RESULT_FIELDS.map((field) => [field, field])),
    totalRows: 1,
    matched: [record],
    unmatched: [],
    warnings,
    notice: warnings.length
      ? `发现 ${warnings.length} 条指标口径提醒；请在确认写入前人工核对。手动结果只保存在当前浏览器。`
      : "手动结果已在本地校验；确认后按测试编号写入当前项目。"
  };
}

export function parseExperimentResults(text, knownTestIds = []) {
  const document = parseCsvDocument(text);
  if (document.rows.length > EXPERIMENT_RESULT_LIMITS.maxRows) throw new Error(`结果回填最多支持 ${EXPERIMENT_RESULT_LIMITS.maxRows} 行`);
  const columns = resolveColumns(document.headers);
  if (!columns.testId || !columns.spend) throw new Error("结果文件必须包含“测试编号”和“消耗”列");
  const known = new Set([...knownTestIds].map((value) => String(value)));
  const seen = new Set();
  const matched = [];
  const unmatched = [];
  const warnings = [];
  document.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const testId = String(row[columns.testId] || "").trim();
    if (!testId) throw new Error(`第 ${rowNumber} 行缺少测试编号`);
    if (seen.has(testId)) throw new Error(`结果文件包含重复测试编号：${testId}`);
    seen.add(testId);
    const metrics = normalizedMetrics(Object.fromEntries(Object.keys(FIELD_ALIASES).map((field) => [field, columns[field] ? row[columns[field]] : ""])), (metric) => `第 ${rowNumber} 行${metric}`);
    if (metrics.spend === null) throw new Error(`第 ${rowNumber} 行缺少消耗`);
    validateFunnel(metrics, `第 ${rowNumber} 行`);
    const rowWarnings = metricWarnings(metrics, `第 ${rowNumber} 行`, testId, rowNumber);
    const record = { testId, metrics, qualityWarnings: rowWarnings.map((entry) => entry.code) };
    if (known.has(testId)) {
      matched.push(record);
      warnings.push(...rowWarnings);
    }
    else unmatched.push(record);
  });
  return {
    columns,
    totalRows: document.rows.length,
    matched,
    unmatched,
    warnings,
    notice: warnings.length
      ? `发现 ${warnings.length} 条指标口径提醒；请在确认写入前人工核对。结果差异仍只是描述性证据，不代表单一变量具有因果效果。`
      : "只按测试编号回填本地版本记录；结果差异是描述性证据，不代表单一变量具有因果效果。"
  };
}
