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

function normalizedHeader(value) {
  return String(value || "").toLowerCase().replace(/[\s%％()（）/\\_-]+/gu, "");
}

function resolveColumns(headers) {
  const byNormalized = new Map(headers.map((header) => [normalizedHeader(header), header]));
  return Object.fromEntries(Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, aliases.map(normalizedHeader).map((alias) => byNormalized.get(alias)).find(Boolean) || ""]));
}

function metricNumber(value, label, { rate = false } = {}) {
  const source = String(value ?? "").trim();
  if (!source) return null;
  const percentage = /[%％]$/u.test(source);
  const normalized = source.replace(/[,%％￥¥\s]/gu, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}不是有效的非负数`);
  const result = rate && (percentage || parsed > 1) ? parsed / 100 : parsed;
  if (rate && result > 1) throw new Error(`${label}必须在 0% 到 100% 之间`);
  if (!rate && result > 1e12) throw new Error(`${label}超过可处理上限`);
  return result;
}

function validateFunnel(metrics, rowNumber) {
  if (metrics.impressions !== null && metrics.clicks !== null && metrics.clicks > metrics.impressions) {
    throw new Error(`第 ${rowNumber} 行点击量不能大于展示量`);
  }
  if (metrics.clicks !== null && metrics.conversions !== null && metrics.conversions > metrics.clicks) {
    throw new Error(`第 ${rowNumber} 行转化量不能大于点击量；如平台使用不同归因口径，请先拆分或校正字段`);
  }
}

function materiallyDifferent(actual, expected, absoluteTolerance, relativeTolerance = 0.15) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  return Math.abs(actual - expected) > Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance);
}

function metricWarnings(metrics, rowNumber, testId) {
  const warnings = [];
  if (metrics.spend > 0 && metrics.gmv !== null && metrics.roi !== null) {
    const expected = metrics.gmv / metrics.spend;
    if (materiallyDifferent(metrics.roi, expected, 0.1)) warnings.push({ rowNumber, testId, field: "roi", code: "roi_mismatch", message: `第 ${rowNumber} 行 ROI 与成交金额 ÷ 消耗差异较大，请核对平台归因口径` });
  }
  if (metrics.impressions > 0 && metrics.clicks !== null && metrics.ctr !== null) {
    const expected = metrics.clicks / metrics.impressions;
    if (materiallyDifferent(metrics.ctr, expected, 0.005, 0.2)) warnings.push({ rowNumber, testId, field: "ctr", code: "ctr_mismatch", message: `第 ${rowNumber} 行 CTR 与点击量 ÷ 展示量差异较大，请核对字段口径` });
  }
  if (metrics.clicks > 0 && metrics.conversions !== null && metrics.cvr !== null) {
    const expected = metrics.conversions / metrics.clicks;
    if (materiallyDifferent(metrics.cvr, expected, 0.005, 0.2)) warnings.push({ rowNumber, testId, field: "cvr", code: "cvr_mismatch", message: `第 ${rowNumber} 行 CVR 与转化量 ÷ 点击量差异较大，请核对字段口径` });
  }
  return warnings;
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
    const metrics = {
      spend: metricNumber(row[columns.spend], `第 ${rowNumber} 行消耗`),
      gmv: columns.gmv ? metricNumber(row[columns.gmv], `第 ${rowNumber} 行成交金额`) : null,
      roi: columns.roi ? metricNumber(row[columns.roi], `第 ${rowNumber} 行 ROI`) : null,
      impressions: columns.impressions ? metricNumber(row[columns.impressions], `第 ${rowNumber} 行展示`) : null,
      clicks: columns.clicks ? metricNumber(row[columns.clicks], `第 ${rowNumber} 行点击`) : null,
      conversions: columns.conversions ? metricNumber(row[columns.conversions], `第 ${rowNumber} 行转化`) : null,
      ctr: columns.ctr ? metricNumber(row[columns.ctr], `第 ${rowNumber} 行 CTR`, { rate: true }) : null,
      cvr: columns.cvr ? metricNumber(row[columns.cvr], `第 ${rowNumber} 行 CVR`, { rate: true }) : null,
      threeSecondRate: columns.threeSecondRate ? metricNumber(row[columns.threeSecondRate], `第 ${rowNumber} 行 3 秒播放率`, { rate: true }) : null,
      completionRate: columns.completionRate ? metricNumber(row[columns.completionRate], `第 ${rowNumber} 行完播率`, { rate: true }) : null
    };
    if (metrics.spend === null) throw new Error(`第 ${rowNumber} 行缺少消耗`);
    validateFunnel(metrics, rowNumber);
    const rowWarnings = metricWarnings(metrics, rowNumber, testId);
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
