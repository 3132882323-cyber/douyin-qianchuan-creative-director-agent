import { productionStageCode, productionStageLabel } from "./production-status.js";
import { buildCreativeVersionDiff } from "./creative-version-diff.js";

const READY_PRODUCTION_STAGES = new Set(["ready", "launched"]);
const PLACEHOLDER_PATTERN = /(?:待确认|待补充|未填写|请(?:编导|投手|操盘手)?补充)/u;

function requiredEntry(entry) {
  if (!entry?.version?.testId || !entry.version.planItem) throw new Error("投放交接缺少测试版本或拍摄方案");
  return entry;
}

function compactText(value, fallback = "待补充") {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return text || fallback;
}

function hasFinalText(value) {
  const text = compactText(value, "");
  return Boolean(text && !PLACEHOLDER_PATTERN.test(text));
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isBaselineVersion(entry) {
  return String(entry?.version?.planItem?.type || "").trim() === "基线" || /-B00$/u.test(String(entry?.version?.testId || ""));
}

export function buildOperatorSingleVariableDiff(entry, timeline = []) {
  const current = requiredEntry(entry);
  if (!Array.isArray(timeline)) throw new Error("投放交接单变量时间线格式无效");
  if (isBaselineVersion(current)) return buildCreativeVersionDiff(current, timeline);
  const batchId = String(current.version.batchId || "").trim();
  if (!batchId) {
    return {
      code: "baseline_missing",
      badge: "需核对",
      label: "当前变体缺少批次编号，无法确认应对照的同批次基线"
    };
  }
  const candidates = timeline.filter((candidate) => candidate?.version?.testId !== current.version.testId
    && String(candidate?.version?.batchId || "").trim() === batchId
    && isBaselineVersion(candidate));
  const numberedBaselines = candidates.filter((candidate) => /-B00$/u.test(String(candidate.version.testId || "")));
  const baseline = numberedBaselines.length === 1
    ? numberedBaselines[0]
    : numberedBaselines.length === 0 && candidates.length === 1
      ? candidates[0]
      : null;
  if (!baseline) {
    return {
      code: "baseline_missing",
      badge: "需核对",
      label: candidates.length > 1
        ? "同批次存在多个可用基线，无法唯一确认变体的对照版本"
        : "同批次基线版本不可用，无法核对变体是否只改变一个变量"
    };
  }
  return buildCreativeVersionDiff({
    ...current,
    version: { ...current.version, parentVersionId: baseline.version.testId }
  }, timeline);
}

function money(value) {
  return positiveNumber(value) ? `¥${Number(value).toFixed(2)}` : "待补充";
}

function roi(value) {
  return positiveNumber(value) ? Number(value).toFixed(2) : "待补充";
}

function singleVariableReady(entry, contentDiff) {
  if (contentDiff) return contentDiff.code === "aligned";
  return isBaselineVersion(entry) && !entry.version.parentVersionId;
}

export function assessOperatorHandoffReadiness(entry, { targetRoi, contentDiff = null } = {}) {
  const current = requiredEntry(entry);
  const item = current.version.planItem;
  const stage = productionStageCode(current.version.productionStatus);
  const checks = [
    { code: "production_stage", label: "制作状态需为待投放或已上线", ready: READY_PRODUCTION_STAGES.has(stage) },
    { code: "baseline", label: "基线素材", ready: hasFinalText(current.version.baselineCreative || item.baselineCreative) },
    { code: "variable", label: "唯一变量", ready: hasFinalText(current.version.primaryVariable || item.singleVariable) },
    { code: "variant", label: "本条变量值", ready: hasFinalText(item.variant) },
    { code: "hypothesis", label: "测试假设", ready: hasFinalText(item.hypothesis) },
    { code: "fixed_elements", label: "保持不变项", ready: hasFinalText(item.fixedElements) },
    { code: "observation_metrics", label: "观察指标", ready: hasFinalText(item.observationMetrics) },
    { code: "min_spend", label: "最低测试消耗需大于 0", ready: positiveNumber(current.version.minSpend ?? item.minSpend) },
    { code: "target_roi", label: "当前项目目标 ROI 需大于 0", ready: positiveNumber(targetRoi) },
    { code: "stop_condition", label: "停止条件", ready: hasFinalText(item.stopCondition) },
    { code: "success_action", label: "达成后动作", ready: hasFinalText(item.successAction) },
    { code: "single_variable", label: contentDiff?.label || (isBaselineVersion(current) ? "父子单变量差异待核对" : "同批次基线版本不可用"), ready: singleVariableReady(current, contentDiff) }
  ];
  const missing = checks.filter((check) => !check.ready).map(({ code, label }) => ({ code, label }));
  return {
    ready: missing.length === 0,
    readyCount: checks.length - missing.length,
    total: checks.length,
    missing,
    productionStage: stage,
    productionStageLabel: productionStageLabel(current.version.productionStatus),
    singleVariableCode: contentDiff?.code || (isBaselineVersion(current) && !current.version.parentVersionId ? "root" : "missing")
  };
}

export function experimentVersionToOperatorCard(entry, {
  targetRoi,
  projectName = "当前本地项目",
  contentDiff = null
} = {}) {
  const current = requiredEntry(entry);
  const version = current.version;
  const item = version.planItem;
  const readiness = assessOperatorHandoffReadiness(current, { targetRoi, contentDiff });
  const singleVariableNote = contentDiff
    ? `${contentDiff.badge || "待核对"}：${contentDiff.label}`
    : isBaselineVersion(current) && !version.parentVersionId
      ? "新测试起点：没有父版本对照"
      : "待核对：同批次基线或父版本差异不可用";
  const lines = [
    "# 千川投放交接卡",
    "",
    `- 项目：${compactText(projectName)}`,
    `- 测试编号：${compactText(version.testId)}`,
    `- 父版本：${compactText(version.parentVersionId, "无（新测试起点）")}`,
    `- 人工制作状态：${readiness.productionStageLabel}`,
    `- 单变量核对：${singleVariableNote}`,
    "",
    "## 本轮只测什么",
    "",
    `- 基线素材：${compactText(version.baselineCreative || item.baselineCreative)}`,
    `- 唯一变量：${compactText(version.primaryVariable || item.singleVariable)}`,
    `- 本条变量值：${compactText(item.variant)}`,
    `- 测试假设：${compactText(item.hypothesis)}`,
    `- 必须保持不变：${compactText(item.fixedElements)}`,
    "",
    "## 人工投放判断门槛",
    "",
    `- 当前项目目标 ROI：${roi(targetRoi)}`,
    `- 最低测试消耗：${money(version.minSpend ?? item.minSpend)}（达到前不做效果结论）`,
    `- 观察指标：${compactText(item.observationMetrics)}`,
    `- 停止条件：${compactText(item.stopCondition)}`,
    `- 达成后动作：${compactText(item.successAction)}`,
    "",
    "## 结果回填约定",
    "",
    "- 必填：测试编号、消耗；ROI 可直接填写，也可用成交金额与消耗推导。",
    "- 建议同时回填：展示、点击、转化、CTR、CVR、3 秒播放率、完播率。",
    "- 只有操盘手或编导人工标记“已上线”后，系统才会主动提醒回填；不会自动读取账户数据。",
    "",
    "## 交接检查",
    "",
    `- 完整度：${readiness.readyCount} / ${readiness.total}`,
    `- 待处理：${readiness.missing.length ? readiness.missing.map((gap) => gap.label).join("；") : "无"}`,
    "",
    "> 本卡只整理当前浏览器中的人工方案和阈值，不创建广告计划、不设置预算、不自动启停、不读取千川账户，也不预测投放效果；所有平台操作与最终判断均由操盘手人工完成。"
  ];
  return lines.join("\n");
}
