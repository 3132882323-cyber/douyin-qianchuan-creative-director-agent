import { assessPlanShootReadiness } from "./core.js";
import { buildDirectorMonitorCard } from "./director-monitor-card.js";

export const DIRECTOR_TAKE_REVIEW_LIMITS = Object.freeze({
  maxItems: 100,
  maxFieldLength: 6000,
  checkCount: 5
});

const REVIEW_KEYS = Object.freeze([
  "code",
  "copyable",
  "itemIndex",
  "itemCount",
  "batchId",
  "idPrefix",
  "id",
  "type",
  "orderLabel",
  "singleVariable",
  "variant",
  "fixedElements",
  "audience",
  "scene",
  "beats",
  "warnings",
  "checks"
]);
const BEAT_KEYS = Object.freeze(["firstFrame", "hook", "spokenOpening", "subtitleCue", "proofCue", "editingBridge"]);
const CHECK_KEYS = Object.freeze(["code", "label", "reference", "instruction", "failureAction"]);

const CHECK_DEFINITIONS = Object.freeze([
  Object.freeze({
    code: "silent_first_frame",
    label: "静音首帧",
    reference: (source) => `计划首帧：${source.beats.firstFrame}；计划首屏字幕：${source.beats.subtitleCue}`,
    instruction: "在真实手机尺寸静音回放 0–1 秒，确认主体清楚、动作已发生、字幕可扫读且只有一个主要信息焦点。",
    failureAction: "首帧主体、动作或字幕任一不清，立即重拍首帧，不依赖后期放大或补字掩盖。"
  }),
  Object.freeze({
    code: "audible_hook",
    label: "有声钩子",
    reference: (source) => `计划钩子：${source.beats.hook}；计划口播首句：${source.beats.spokenOpening}`,
    instruction: "打开声音回放 0–3 秒，确认画面、口播和字幕表达同一个钩子，真人语速自然且没有引入第二个主题。",
    failureAction: "表达错位、口播卡顿或三秒内说不完时，统一画面、口播和字幕后立即重拍。"
  }),
  Object.freeze({
    code: "proof_continuity",
    label: "证据连续",
    reference: (source) => `计划证据：${source.beats.proofCue}；计划承接：${source.beats.editingBridge}`,
    instruction: "从第三秒继续回放，确认事实条件、过程和结果连续可见，钩子自然进入证据而不是只靠口播或字幕补结论。",
    failureAction: "证据条件、过程或结果缺失时标出缺口并补拍，不跨版本借用不匹配的证据。"
  }),
  Object.freeze({
    code: "fixed_continuity",
    label: "固定项连续",
    reference: (source) => `本条只改：${source.singleVariable} → ${source.variant}；其余锁定：${source.fixedElements}`,
    instruction: "与 B00 连续性参照核对演员、机位、光线、场景、证据条件、时长和行动引导，只允许声明变量及其必要呈现变化。",
    failureAction: "出现第二个创意变量或固定项漂移时停止沿用本 Take，恢复连续性后重新拍摄。"
  }),
  Object.freeze({
    code: "audio_handles",
    label: "声音与剪辑余量",
    reference: (source) => `拍摄场景：${source.scene}；计划剪辑承接：${source.beats.editingBridge}`,
    instruction: "戴耳机检查口播、动作声和环境底噪是否可用，并确认关键动作入点前、出点后各有至少 2 秒稳定剪辑余量。",
    failureAction: "爆音、串音、环境声跳变或剪辑余量不足时，先修正收音与动作节奏再补拍对应段落。"
  })
]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(record(value, label));
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`${label}结构已被篡改`);
}

function text(value, label, maxLength = DIRECTOR_TAKE_REVIEW_LIMITS.maxFieldLength) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!result) throw new Error(`${label}缺失`);
  if (result.length > maxLength) throw new Error(`${label}超过本地拍后快检处理上限`);
  return result;
}

function optionalText(value, label, maxLength = 160) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length > maxLength) throw new Error(`${label}超过本地拍后快检处理上限`);
  return result;
}

function integer(value, label, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${label}无效`);
  return result;
}

function warningRank(value) {
  if (value === "口播首句没有执行当前钩子;开机前必须统一口播、首帧与字幕。") return 1;
  if (/^钩子含 \d+ 个字\/符号,可能超出前三秒信息承载;必须由真人按实际语速盲读计时。$/u.test(value)) return 2;
  if (/^首屏字幕含 \d+ 个字\/符号,可能影响扫读;现场需用手机尺寸停帧检查。$/u.test(value)) return 3;
  if (value === "首帧分镜描述较密;现场应确认第一秒只有一个视觉焦点。") return 4;
  return 0;
}

function safeWarnings(value) {
  if (!Array.isArray(value) || value.length > 4) throw new Error("拍后快检提醒结构已被篡改");
  const seen = new Set();
  let previousRank = 0;
  return value.map((candidate, index) => {
    const warning = text(candidate, `拍后快检提醒 ${index + 1}`, 1000);
    const rank = warningRank(warning);
    if (!rank || rank <= previousRank || seen.has(warning)) throw new Error(`拍后快检提醒已被篡改：${warning}`);
    seen.add(warning);
    previousRank = rank;
    return warning;
  });
}

function expectedChecks(source) {
  return CHECK_DEFINITIONS.map((definition, index) => Object.fromEntries(CHECK_KEYS.map((key) => {
    const raw = key === "reference" ? definition.reference(source) : definition[key];
    return [key, text(raw, `固定拍后快检项 ${index + 1} ${key}`)];
  })));
}

function identityForPlan(plan) {
  const firstId = text(plan.items[0]?.id, "B00 测试编号", 160);
  if (firstId === "B00") return { idPrefix: "", batchId: optionalText(plan.batchId, "测试批次") || "未记录" };
  const match = firstId.match(/^(.+)-B00$/u);
  if (!match) throw new Error("全批版本身份与顺序异常，请重新生成方案");
  const idPrefix = text(match[1], "测试编号前缀", 156);
  const batchId = optionalText(plan.batchId, "测试批次") || idPrefix;
  if (batchId !== idPrefix) throw new Error("全批版本身份与顺序异常，请重新生成方案");
  return { idPrefix, batchId };
}

function sanitizeReview(review) {
  const source = record(review, "单条拍后快检卡");
  exactKeys(source, REVIEW_KEYS, "单条拍后快检卡");
  if (source.copyable !== true) throw new Error("单条拍后快检卡尚不可使用");
  const itemCount = integer(source.itemCount, "方案条数", 1, DIRECTOR_TAKE_REVIEW_LIMITS.maxItems);
  const itemIndex = integer(source.itemIndex, "拍后快检任务序号", 0, itemCount - 1);
  const idPrefix = optionalText(source.idPrefix, "测试编号前缀", 156);
  const batchId = text(source.batchId, "测试批次", 160);
  if (idPrefix && batchId !== idPrefix) throw new Error("单条拍后快检卡批次身份已被篡改");
  const token = itemIndex === 0 ? "B00" : `A${String(itemIndex).padStart(2, "0")}`;
  const expectedId = idPrefix ? `${idPrefix}-${token}` : token;
  const id = text(source.id, "测试编号", 160);
  if (id !== expectedId) throw new Error(`单条拍后快检卡版本身份已被篡改：应为 ${expectedId}`);
  const expectedType = itemIndex === 0 ? "基线" : "变体";
  const type = text(source.type, `${id} 类型`, 80);
  if (type !== expectedType) throw new Error(`${id} 类型必须为${expectedType}`);
  const expectedOrder = itemIndex === 0 ? "先拍基线" : `第 ${itemIndex + 1} 条变体`;
  const orderLabel = text(source.orderLabel, `${id} 拍摄顺序`, 80);
  if (orderLabel !== expectedOrder) throw new Error(`${id} 拍摄顺序已被篡改`);
  exactKeys(source.beats, BEAT_KEYS, "拍后快检时间轴");
  const beats = Object.fromEntries(BEAT_KEYS.map((key) => [key, text(source.beats[key], `${id} ${key}`)]));
  const sanitized = {
    code: "",
    copyable: true,
    itemIndex,
    itemCount,
    batchId,
    idPrefix,
    id,
    type,
    orderLabel,
    singleVariable: text(source.singleVariable, `${id} 唯一变量`, 160),
    variant: text(source.variant, `${id} 变量值`, 1000),
    fixedElements: text(source.fixedElements, `${id} 固定项`, 1600),
    audience: text(source.audience, `${id} 目标受众`, 1000),
    scene: text(source.scene, `${id} 拍摄场景`, 1000),
    beats,
    warnings: safeWarnings(source.warnings),
    checks: []
  };
  sanitized.code = sanitized.warnings.length ? "review" : "ready";
  if (source.code !== sanitized.code) throw new Error("单条拍后快检卡提醒状态已被篡改");
  if (!Array.isArray(source.checks) || source.checks.length !== DIRECTOR_TAKE_REVIEW_LIMITS.checkCount) throw new Error("单条拍后快检项结构已被篡改");
  const expected = expectedChecks(sanitized);
  sanitized.checks = source.checks.map((candidate, index) => {
    exactKeys(candidate, CHECK_KEYS, `拍后快检项 ${index + 1}`);
    const check = Object.fromEntries(CHECK_KEYS.map((key) => [key, text(candidate[key], `拍后快检项 ${index + 1} ${key}`)]));
    const mismatch = CHECK_KEYS.find((key) => check[key] !== expected[index][key]);
    if (mismatch) throw new Error(`拍后快检项 ${index + 1} 已被篡改：${mismatch}`);
    return check;
  });
  return sanitized;
}

export function buildDirectorTakeReview(plan, { itemIndex } = {}) {
  const source = record(plan, "拍摄方案");
  if (!Array.isArray(source.items) || !source.items.length || source.items.length > DIRECTOR_TAKE_REVIEW_LIMITS.maxItems) {
    throw new Error("单条拍后快检缺少有效拍摄任务");
  }
  const index = integer(itemIndex, "拍后快检任务序号", 0, source.items.length - 1);
  const readiness = assessPlanShootReadiness(source);
  const selected = readiness.items[index];
  if (!selected || selected.index !== index) throw new Error("拍后快检任务序号与方案不一致");
  if (selected.missing.includes("版本身份与顺序")) throw new Error("全批版本身份与顺序异常，请重新生成方案");
  const missing = selected.missing.filter((label) => label !== "版本身份与顺序");
  if (missing.length) throw new Error(`${selected.id} 拍后快检仍待补：${missing.join("、")}`);
  const monitor = buildDirectorMonitorCard(source, { itemIndex: index });
  if (!monitor.copyable || monitor.missing.length) throw new Error(`${monitor.id} 拍后快检仍待补：${monitor.missing.join("、") || "关键现场字段"}`);
  const identity = identityForPlan(source);
  const review = {
    code: monitor.warnings.length ? "review" : "ready",
    copyable: true,
    itemIndex: index,
    itemCount: source.items.length,
    batchId: identity.batchId,
    idPrefix: identity.idPrefix,
    id: monitor.id,
    type: monitor.type,
    orderLabel: monitor.orderLabel,
    singleVariable: monitor.singleVariable,
    variant: monitor.variant,
    fixedElements: monitor.fixedElements,
    audience: monitor.audience,
    scene: monitor.scene,
    beats: { ...monitor.beats },
    warnings: [...monitor.warnings],
    checks: []
  };
  review.checks = expectedChecks(review);
  return sanitizeReview(review);
}

export function directorTakeReviewToText(review) {
  const source = sanitizeReview(review);
  const warnings = source.warnings.length
    ? [
        "## 当前方案提醒 · 不自动下结论",
        "",
        ...source.warnings.map((warning) => `- ${warning}`),
        "- 上述提醒只决定现场应重点回看什么，不代表这个 Take 自动通过或必须重拍。",
        ""
      ]
    : [];
  const lines = [
    `# 单条拍后快检卡 · ${source.id}`,
    "",
    `- 测试批次：${source.batchId}`,
    `- 拍摄顺序：${source.orderLabel}`,
    `- 本条只改：${source.singleVariable} → ${source.variant}`,
    `- 目标受众：${source.audience}`,
    `- 拍摄场景：${source.scene}`,
    `- 其余锁定：${source.fixedElements}`,
    "- 实际文件序号/文件名：________",
    "- Take 编号：________",
    "- 声音条/同步声：________（没有则写“无”）",
    "",
    ...warnings,
    "## 五项人工快检",
    ""
  ];
  source.checks.forEach((check, index) => {
    lines.push(
      `### ${index + 1} · ${check.label}`,
      "",
      `- 计划参考：${check.reference}`,
      `- [ ] ${check.instruction}`,
      `- 未通过时：${check.failureAction}`,
      ""
    );
  });
  lines.push(
    "## 人工结论 · 必须三选一",
    "",
    "- [ ] 保留本 Take：五项已在真实手机回放和耳机监听下逐项确认。",
    "- [ ] 立即重拍：当前问题可以在保持本条变量与固定项不变的前提下修正。",
    "- [ ] 停机核实事实或授权：事实、数据、资质、对比、肖像、音乐或素材授权尚不能确认。",
    "- 问题时间码：________",
    "- 下一条修正：________",
    "- 复核人：________；复核时间：________",
    "",
    "> 本卡只把当前本地方案重排为单条人工回看步骤；不读取或识别媒体、不自动评分或选择 Take、不修改方案、接片映射或制作状态。"
  );
  return lines.join("\n");
}
