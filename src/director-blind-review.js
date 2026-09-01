import { buildDirectorMonitorCard } from "./director-monitor-card.js";

export const DIRECTOR_BLIND_REVIEW_LIMITS = Object.freeze({
  minItems: 2,
  maxItems: 12,
  maxPublicFieldLength: 800
});

const LABELS = "ABCDEFGHIJKL";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function inlineText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactReviewBias(value, identifiers) {
  let output = inlineText(value);
  for (const identifier of identifiers) {
    if (identifier.length < 3) continue;
    output = output.replace(new RegExp(escaped(identifier), "giu"), "[已隐藏来源]");
  }
  output = output
    .replace(/(?:支付\s*)?(?:ROI|CTR|CVR|CPA|GMV|消耗|转化率|点击率|完播率|留存率)\s*(?:为|达|达到|[:：=><≥≤])?\s*[-+]?\d+(?:\.\d+)?%?/giu, "[已隐藏指标]")
    .replace(/[¥￥]\s*\d[\d,]*(?:\.\d+)?/gu, "[已隐藏金额]");
  if (output.length > DIRECTOR_BLIND_REVIEW_LIMITS.maxPublicFieldLength) throw new Error("盲审字段过长，请先压缩为一个主要信息");
  return output;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function shuffledIndexes(length, seed) {
  const indexes = Array.from({ length }, (_, index) => index);
  let state = seed || 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [indexes[index], indexes[target]] = [indexes[target], indexes[index]];
  }
  if (indexes[0] === 0 && indexes.length > 1) [indexes[0], indexes[1]] = [indexes[1], indexes[0]];
  return indexes;
}

function knownIdentifiers(plan) {
  return [...new Set([
    inlineText(plan.batchId),
    ...plan.items.flatMap((item) => [inlineText(item?.id), inlineText(item?.baselineCreative)])
  ].filter(Boolean))].sort((left, right) => right.length - left.length);
}

export function buildDirectorBlindReview(plan) {
  const source = record(plan, "盲审方案");
  if (!Array.isArray(source.items) || source.items.length < DIRECTOR_BLIND_REVIEW_LIMITS.minItems || source.items.length > DIRECTOR_BLIND_REVIEW_LIMITS.maxItems) {
    throw new Error(`拍前盲审只支持 ${DIRECTOR_BLIND_REVIEW_LIMITS.minItems}–${DIRECTOR_BLIND_REVIEW_LIMITS.maxItems} 条同批方案`);
  }
  const monitors = source.items.map((_, itemIndex) => buildDirectorMonitorCard(source, { itemIndex }));
  const blockers = monitors.flatMap((monitor) => monitor.missing.map((field) => `${monitor.id}：${field}`));
  const signature = stableSerialize(monitors.map((monitor) => ({
    id: monitor.id,
    audience: monitor.audience,
    scene: monitor.scene,
    hook: monitor.beats.hook,
    firstFrame: monitor.beats.firstFrame,
    subtitleCue: monitor.beats.subtitleCue,
    proofCue: monitor.beats.proofCue
  })));
  const seed = fnv1a(`director-blind-review-v1|${signature}`);
  const reviewId = `BR-${seed.toString(16).padStart(8, "0").toUpperCase()}`;
  if (blockers.length) return { code: "incomplete", copyable: false, reviewId, cards: [], answerKey: [], blockers };
  const identifiers = knownIdentifiers(source);
  const order = shuffledIndexes(monitors.length, seed);
  const cards = order.map((originalIndex, position) => {
    const monitor = monitors[originalIndex];
    const card = {
      label: LABELS[position],
      audience: redactReviewBias(monitor.audience, identifiers),
      scene: redactReviewBias(monitor.scene, identifiers),
      firstFrame: redactReviewBias(monitor.beats.firstFrame, identifiers),
      hook: redactReviewBias(monitor.beats.hook, identifiers),
      subtitleCue: redactReviewBias(monitor.beats.subtitleCue, identifiers),
      proofCue: redactReviewBias(monitor.beats.proofCue, identifiers)
    };
    if (Object.values(card).some((value) => !value)) throw new Error("匿名处理后出现空白盲审字段，请改写来源标识后重试");
    return card;
  });
  const answerKey = order.map((originalIndex, position) => ({
    label: LABELS[position],
    testId: monitors[originalIndex].id,
    type: monitors[originalIndex].type,
    originalIndex,
    warningCount: monitors[originalIndex].warnings.length,
    singleVariable: monitors[originalIndex].singleVariable,
    fixedElements: monitors[originalIndex].fixedElements
  }));
  return { code: "ready", copyable: true, reviewId, cards, answerKey, blockers: [] };
}

export function directorBlindReviewPackToText(review) {
  const source = record(review, "拍前盲审包");
  if (source.copyable !== true || !Array.isArray(source.cards) || source.cards.length < DIRECTOR_BLIND_REVIEW_LIMITS.minItems) {
    throw new Error(`拍前盲审仍待补：${Array.isArray(source.blockers) && source.blockers.length ? source.blockers.join("；") : "至少两条完整方案"}`);
  }
  const lines = [
    `# 前三秒拍前盲审 · ${inlineText(source.reviewId)}`,
    "",
    `- 匿名方案：${source.cards.length} 条`,
    "- 评审纪律：不询问作者、基线身份和历史表现；看完全部方案后再选择。",
    "- 判断范围：只评估前三秒是否容易理解、是否愿意继续看、以及下一步证据是否符合预期。",
    "",
    "> 仅用于团队自有或已授权方案的拍前讨论。盲审反馈是创作输入，不是效果预测、版权许可或自动决策。",
    ""
  ];
  for (const card of source.cards) {
    lines.push(
      `## 盲审方案 ${inlineText(card.label)}`,
      "",
      `- 目标受众：${inlineText(card.audience)}`,
      `- 拍摄场景：${inlineText(card.scene)}`,
      `- 首帧画面：${inlineText(card.firstFrame)}`,
      `- 三秒钩子：${inlineText(card.hook)}`,
      `- 首屏字幕：${inlineText(card.subtitleCue)}`,
      `- 预期证据：${inlineText(card.proofCue)}`,
      "",
      "请填写：",
      "- 一秒复述：我看到的是______，它是给______看的。",
      "- 继续看理由：______。",
      "- 我期待下一镜证明：______。",
      "- 最大歧义或不信任点：______。",
      "- 不复用原句的一个新开场：______。",
      ""
    );
  }
  lines.push(
    "## 最终提交",
    "",
    "- 第一选择及原因：______。",
    "- 建议淘汰及原因：______。",
    "- 最值得合并进新方向的一个机制：______。",
    "",
    "> 请先锁定全部反馈，再向评审者揭示方案身份，避免根据结果倒推理由。"
  );
  return lines.join("\n");
}

export function directorBlindReviewKeyToText(review) {
  const source = record(review, "导演盲审映射");
  if (source.copyable !== true || !Array.isArray(source.answerKey) || source.answerKey.length < DIRECTOR_BLIND_REVIEW_LIMITS.minItems) {
    throw new Error("当前没有可用的导演盲审映射");
  }
  return [
    `# 导演盲审映射 · ${inlineText(source.reviewId)}`,
    "",
    "- 必须在反馈锁定后查看；不要把本映射发给评审者。",
    "- 编辑任一方案后盲审编号会变化，请只使用相同盲审编号的映射。",
    "",
    ...source.answerKey.map((entry) => `- 方案 ${inlineText(entry.label)} → ${inlineText(entry.testId)} · ${inlineText(entry.type)} · 原顺序 ${Number(entry.originalIndex) + 1}${entry.warningCount ? ` · ${Number(entry.warningCount)} 项开机提醒` : ""}`),
    "",
    "> 映射只存在于当前页面计算和用户主动复制的文本中，不保存评审选择或自动修改方案。"
  ].join("\n");
}

export function directorBlindReviewDecisionSheetToText(review) {
  const source = record(review, "导演合议单");
  if (source.copyable !== true || !Array.isArray(source.cards) || !Array.isArray(source.answerKey) || source.cards.length < DIRECTOR_BLIND_REVIEW_LIMITS.minItems || source.cards.length !== source.answerKey.length) {
    throw new Error("当前没有完整且匹配的盲审方案与导演映射");
  }
  const keyByLabel = new Map();
  for (const entry of source.answerKey) {
    const label = inlineText(entry?.label);
    if (!label || keyByLabel.has(label)) throw new Error("导演合议单包含无效或重复的盲审标签");
    keyByLabel.set(label, entry);
  }
  const lines = [
    `# 盲审后导演合议单 · ${inlineText(source.reviewId)}`,
    "",
    "- 使用顺序：先锁定匿名反馈，再由导演打开本合议单完成映射和动作选择。",
    "- 动作只允许三种：保留开拍、单变量重写、本轮淘汰。",
    "- 评审票数只描述理解与偏好，不代表真实投放效果、因果或统计结论。",
    ""
  ];
  for (const card of source.cards) {
    const label = inlineText(card?.label);
    const key = keyByLabel.get(label);
    if (!key) throw new Error(`盲审方案 ${label || "?"} 缺少对应导演映射`);
    lines.push(
      `## 方案 ${label} → ${inlineText(key.testId)} · ${inlineText(key.type)}`,
      "",
      `- 首帧：${inlineText(card.firstFrame)}`,
      `- 钩子：${inlineText(card.hook)}`,
      `- 证据预期：${inlineText(card.proofCue)}`,
      `- 本条唯一变量：${inlineText(key.singleVariable)}`,
      `- 其余保持：${inlineText(key.fixedElements)}`,
      key.warningCount ? `- 开机提醒：${Number(key.warningCount)} 项，需回到前三秒监看卡逐项核对。` : "- 开机提醒：当前字段未触发密度或同步提醒，仍需真人复核。",
      "",
      "### 回收事实（先填，不下结论）",
      "",
      "- 有效评审人数：______。",
      "- 能在一秒内复述受众与事件的人数：______。",
      "- 明确愿意继续看的人数：______。",
      "- 对下一镜证据的共同预期：______。",
      "- 重复出现的最大歧义或不信任点：______。",
      "- 值得保留的原创新开场：______。",
      "",
      "### 导演动作（必须三选一）",
      "",
      "- [ ] 保留开拍：信息已清楚，继续按当前单变量方案验证。",
      "- [ ] 单变量重写：只改本条声明的唯一变量，其余条件保持一致。",
      "- [ ] 本轮淘汰：当前问题不值得消耗拍摄与投放资源继续验证。",
      "- 选择理由：基于哪些重复反馈，而不是作者身份或历史指标：______。",
      "- 若重写，新值是什么：______。",
      "- 开拍/重写后的失败条件：______。",
      ""
    );
  }
  lines.push(
    "## 合议后执行",
    "",
    "- 第一拍仍为批次基线；盲审偏好不能改变单变量对照顺序。",
    "- 同一轮最多保留一个主要学习目标；不要把多个高票建议拼成多变量版本。",
    "- 淘汰项记录具体理解障碍，不写‘感觉不好’或‘大家不喜欢’。",
    "- 所有事实、证据、授权与合规表达在开机前再次人工核对。",
    "",
    "> 本合议单只提供人工决策结构，不保存反馈、不自动选优、不修改方案或制作状态。"
  );
  return lines.join("\n");
}
