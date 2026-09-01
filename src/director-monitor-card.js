export const DIRECTOR_MONITOR_LIMITS = Object.freeze({
  maxItems: 100,
  maxFieldLength: 6000,
  denseHookUnits: 24,
  denseSubtitleUnits: 18,
  denseFirstFrameUnits: 90
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function safeText(value, label, maxLength = DIRECTOR_MONITOR_LIMITS.maxFieldLength) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  if (text.length > maxLength) throw new Error(`${label}超过本地监看卡处理上限`);
  return text;
}

function inlineText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function lines(value) {
  return safeText(value, "现场字段")
    .split("\n")
    .map((line) => inlineText(line).replace(/^[•*-]\s*/u, ""))
    .filter(Boolean);
}

function firstMatchingLine(value, pattern) {
  const entries = lines(value);
  return entries.find((line) => pattern.test(line)) || "";
}

function firstLine(value) {
  return lines(value)[0] || "";
}

function visibleUnits(value) {
  return Array.from(inlineText(value).replace(/\s+/gu, "")).length;
}

function comparable(value) {
  return inlineText(value).toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "");
}

function openingExecutesHook(opening, hook) {
  const left = comparable(opening);
  const right = comparable(hook);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function requiredValue(value, label, missing) {
  if (!value) missing.push(label);
  return value;
}

export function buildDirectorMonitorCard(plan, { itemIndex } = {}) {
  const source = record(plan, "拍摄方案");
  if (!Array.isArray(source.items) || !source.items.length || source.items.length > DIRECTOR_MONITOR_LIMITS.maxItems) {
    throw new Error("前三秒监看卡缺少有效拍摄任务");
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= source.items.length) throw new Error("前三秒监看卡任务序号无效");
  const item = record(source.items[itemIndex], "拍摄任务");
  const production = record(item.production, "拍摄任务生产资料");
  const id = safeText(item.id, "测试编号", 128) || `任务 ${itemIndex + 1}`;
  const type = safeText(item.type, "任务类型", 80) || "任务";
  const hook = inlineText(safeText(item.hook, "前三秒钩子", 1000));
  const audience = inlineText(safeText(item.audience, "目标受众", 1000));
  const scene = inlineText(safeText(item.scene, "拍摄场景", 1000));
  const singleVariable = inlineText(safeText(item.singleVariable, "唯一变量", 160));
  const variant = inlineText(safeText(item.variant, "变量值", 1000));
  const fixedElements = inlineText(safeText(item.fixedElements, "保持不变项", 1600));
  const spokenOpening = firstLine(production.spokenScript);
  const firstFrame = firstMatchingLine(production.storyboard, /(?:0\s*[-–—~至到]\s*3\s*秒|前三秒|首帧)/u) || firstLine(production.storyboard);
  const subtitleCue = firstLine(production.subtitleHighlights);
  const proofCue = firstMatchingLine(production.shootingTask, /(?:证据|实测|过程|细节|对比|特写|核验)/u);
  const editingBridge = inlineText(safeText(production.editingNotes, "剪辑要求", 2400));
  const missing = [];
  requiredValue(hook, "前三秒钩子", missing);
  requiredValue(audience, "目标受众", missing);
  requiredValue(scene, "拍摄场景", missing);
  requiredValue(singleVariable, "唯一变量", missing);
  requiredValue(variant, "变量值", missing);
  requiredValue(fixedElements, "保持不变项", missing);
  requiredValue(spokenOpening, "口播首句", missing);
  requiredValue(firstFrame, "0–3 秒分镜", missing);
  requiredValue(subtitleCue, "首屏字幕", missing);
  requiredValue(proofCue, "证据镜头", missing);
  requiredValue(editingBridge, "剪辑承接", missing);
  const warnings = [];
  if (hook && spokenOpening && !openingExecutesHook(spokenOpening, hook)) warnings.push("口播首句没有执行当前钩子；开机前必须统一口播、首帧与字幕。");
  const hookUnits = visibleUnits(hook);
  const subtitleUnits = visibleUnits(subtitleCue);
  const firstFrameUnits = visibleUnits(firstFrame);
  if (hookUnits > DIRECTOR_MONITOR_LIMITS.denseHookUnits) warnings.push(`钩子含 ${hookUnits} 个字/符号，可能超出前三秒信息承载；必须由真人按实际语速盲读计时。`);
  if (subtitleUnits > DIRECTOR_MONITOR_LIMITS.denseSubtitleUnits) warnings.push(`首屏字幕含 ${subtitleUnits} 个字/符号，可能影响扫读；现场需用手机尺寸停帧检查。`);
  if (firstFrameUnits > DIRECTOR_MONITOR_LIMITS.denseFirstFrameUnits) warnings.push("首帧分镜描述较密；现场应确认第一秒只有一个视觉焦点。");
  return {
    code: missing.length ? "incomplete" : warnings.length ? "review" : "ready",
    copyable: missing.length === 0,
    itemIndex,
    id,
    type,
    orderLabel: itemIndex === 0 ? "先拍基线" : `第 ${itemIndex + 1} 条变体`,
    singleVariable,
    variant,
    fixedElements,
    audience,
    scene,
    beats: { firstFrame, hook, spokenOpening, subtitleCue, proofCue, editingBridge },
    density: { hookUnits, subtitleUnits, firstFrameUnits },
    missing,
    warnings
  };
}

export function directorMonitorCardToText(card) {
  const source = record(card, "前三秒监看卡");
  if (source.copyable !== true || !source.beats || !Array.isArray(source.missing) || source.missing.length) {
    throw new Error(`前三秒监看卡仍待补：${Array.isArray(source.missing) && source.missing.length ? source.missing.join("、") : "关键现场字段"}`);
  }
  const warnings = Array.isArray(source.warnings) && source.warnings.length
    ? ["", "## 当前提醒", "", ...source.warnings.map((item) => `- ${inlineText(item)}`)]
    : [];
  return [
    `# 前三秒现场监看卡 · ${inlineText(source.id)}`,
    "",
    `- 拍摄顺序：${inlineText(source.orderLabel)}`,
    `- 本条只改：${inlineText(source.singleVariable)} → ${inlineText(source.variant)}`,
    `- 目标受众：${inlineText(source.audience)}`,
    `- 拍摄场景：${inlineText(source.scene)}`,
    `- 其余保持：${inlineText(source.fixedElements)}`,
    "",
    "## 0.0–1.0 秒 · 首帧停滑",
    "",
    `- 首帧画面：${inlineText(source.beats.firstFrame)}`,
    `- 首屏字幕：${inlineText(source.beats.subtitleCue)}`,
    "- 无声停帧：让未参与创作的人只看一秒，复述‘这是给谁、发生了什么’；答不出就重拍首帧。",
    "",
    "## 1.0–3.0 秒 · 信息闭环",
    "",
    `- 钩子目标：${inlineText(source.beats.hook)}`,
    `- 同步口播：${inlineText(source.beats.spokenOpening)}`,
    `- 真人盲读：当前钩子 ${Number(source.density?.hookUnits || 0)} 个字/符号；必须现场计时，不以字数代替真实语速。`,
    "- 对齐检查：首帧、口播和字幕只能共同表达一个主要信息，不允许各说一件事。",
    "",
    "## 3 秒后 · 证据承接",
    "",
    `- 必拍证据：${inlineText(source.beats.proofCue)}`,
    `- 剪辑承接：${inlineText(source.beats.editingBridge)}`,
    "- 连续性检查：关键证据必须看清条件、过程和结果，不能只靠口播或无来源字幕补结论。",
    "",
    "## 开机前五问",
    "",
    "1. 一秒停帧能否看懂受众、问题或结果中的至少两项？",
    "2. 关掉声音后，画面与首屏字幕是否仍表达同一个钩子？",
    "3. 打开声音后，口播首句是否补充画面，而不是引入第二个主题？",
    "4. 三秒后是否立即进入可拍、可核验的证据动作？",
    "5. 与基线相比，是否真的只改变了声明的唯一变量？",
    "",
    "## 当场返拍触发",
    "",
    "- 首帧主体不清、动作未发生或信息焦点超过一个。",
    "- 口播、字幕、画面表达不同主张，或真人三秒内无法自然说完。",
    "- 证据镜头看不清条件、过程、结果或授权来源。",
    "- 演员、机位、光线、时长、证据或行动引导误改，破坏单变量对照。",
    "- 事实、数据、资质、对比或授权无法现场确认。",
    ...warnings,
    "",
    "> 本卡只重排当前本地方案，不自动评价创意优劣或预测效果；是否通过必须由编导在真实手机画面、真人语速和授权事实下确认。"
  ].join("\n");
}
