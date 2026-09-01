import { buildLatestOperatorBatchHandoff } from "./operator-batch-handoff.js";

export const MAX_INSPIRATION_RELAY_CARDS = 6;

const VARIABLE_KEYS = Object.freeze({
  "前三秒钩子": "hook",
  "核心主张": "claim",
  "拍摄场景": "scene",
  "目标受众": "audience",
  hook: "hook",
  sellingPoint: "claim",
  scene: "scene",
  audience: "audience"
});

const VARIABLE_LABELS = Object.freeze({
  hook: "开场叙事",
  claim: "价值表达",
  scene: "场景表达",
  audience: "受众切片",
  unknown: "创意表达"
});

const ORIGINALITY_MOVES = Object.freeze({
  hook: ["更换受众的需求触发时刻", "改用另一种可核验画面证据", "重新设计前三秒之后的承接节奏"],
  claim: ["只保留能够核验的事实", "换到另一种真实使用情境", "重新写行动引导与表达语气"],
  scene: ["更换人物和需求发生时刻", "重新设计机位与证据动作", "保持事实主张不变再做验证"],
  audience: ["重新定义需求触发条件", "更换场景、口吻与视觉符号", "保持同一事实口径避免混测"],
  unknown: ["更换目标受众", "更换真实场景", "更换证据、节奏与行动引导"]
});

const PATTERNS = Object.freeze({
  hook: [
    { code: "result_first", pattern: /(?:结果|变化|前后|先看)/u, label: "结果前置", mechanism: "先让观众看到可观察的结果，再解释过程和条件。", question: "如果第一秒先展示结果，随后再补充原因与证据，理解成本会不会更低？" },
    { code: "proof_first", pattern: /(?:证据|实测|验证|数据|对比)/u, label: "证据前置", mechanism: "把可核验的过程、演示或对比放到开场。", question: "哪一个真实动作能够在不依赖口号的情况下证明主张？" },
    { code: "contrast_first", pattern: /(?:反差|没想到|竟然|却|但是)/u, label: "反差开场", mechanism: "用预期与事实之间的反差制造继续观看的理由。", question: "哪些反差来自真实情境，而不是夸张承诺？" },
    { code: "problem_first", pattern: /(?:困扰|问题|痛|还在|为什么|怎么)/u, label: "问题前置", mechanism: "先呈现受众熟悉的问题时刻，再进入解决过程。", question: "受众在哪一个具体时刻最容易意识到这个问题？" },
    { code: "number_first", pattern: /\d/u, label: "数量线索", mechanism: "用明确数量或步骤降低信息模糊度，但数字必须可核验。", question: "这个数字是否有真实来源，能否换成更直观的演示？" },
    { code: "hook_reframe", pattern: /[\s\S]*/u, label: "叙事起点重构", mechanism: "保持事实不变，只改变观众最先接收到的信息。", question: "如果不复用原句，还能从结果、问题、证据或反差中的哪一个角度开场？" }
  ],
  claim: [
    { code: "proof_claim", pattern: /(?:证据|实测|验证|对比|真实)/u, label: "证据型主张", mechanism: "让事实证据承担说服任务，减少抽象形容。", question: "哪一个可重复验证的事实最能支撑这条表达？" },
    { code: "efficiency_claim", pattern: /(?:省时|效率|更快|方便|步骤)/u, label: "效率价值", mechanism: "从时间、步骤或操作负担说明价值。", question: "用户实际少做了哪一步，节省发生在什么场景？" },
    { code: "trust_claim", pattern: /(?:安心|安全|可靠|放心|稳定)/u, label: "信任价值", mechanism: "把信任建立在边界、条件和证据上。", question: "哪些限制条件必须同时说清，才能避免过度承诺？" },
    { code: "experience_claim", pattern: /(?:体验|舒适|轻松|感受)/u, label: "体验价值", mechanism: "用可观察的使用过程解释主观体验。", question: "什么画面能够让体验被看见，而不只靠口播形容？" },
    { code: "claim_reframe", pattern: /[\s\S]*/u, label: "价值焦点重构", mechanism: "围绕同一事实寻找不同的用户价值解释。", question: "同一事实可以从效率、体验、信任或行动成本中的哪一面重新表达？" }
  ],
  scene: [
    { code: "comparison_scene", pattern: /(?:对比|前后|变化)/u, label: "对比验证场景", mechanism: "在同条件下展示前后或两种做法的可观察差异。", question: "如何固定机位、光线和动作，让对比不引入额外变量？" },
    { code: "moment_scene", pattern: /(?:通勤|上班|居家|户外|出门|睡前|早晨)/u, label: "需求时刻场景", mechanism: "把表达放进需求真正发生的日常时刻。", question: "用户何时最需要解决问题，现场有什么可见动作？" },
    { code: "demo_scene", pattern: /(?:真实|使用|演示|实测)/u, label: "真实演示场景", mechanism: "通过连续动作展示使用过程与边界。", question: "哪些步骤必须完整呈现，才能避免剪辑造成误解？" },
    { code: "scene_transfer", pattern: /[\s\S]*/u, label: "情境迁移", mechanism: "保持主张不变，把它放入另一种真实需求场景。", question: "换一个场景后，哪些事实必须保持不变，哪些画面证据需要重拍？" }
  ],
  audience: [
    { code: "newcomer_audience", pattern: /(?:首次|新人|第一次|刚开始)/u, label: "新接触者视角", mechanism: "降低背景知识要求，从第一次理解和使用出发。", question: "一个完全不了解主题的人，最先需要知道什么？" },
    { code: "problem_audience", pattern: /(?:困扰|问题|正在解决|急需)/u, label: "问题状态切片", mechanism: "按正在经历的问题状态定义受众，而不是只按人口属性。", question: "问题发生前、发生中和发生后，受众的关注点分别是什么？" },
    { code: "intent_audience", pattern: /(?:高意向|准备|考虑|比较)/u, label: "决策阶段切片", mechanism: "根据认知、比较或行动阶段调整信息密度。", question: "这个阶段的受众还缺事实、信任还是行动理由？" },
    { code: "audience_reframe", pattern: /[\s\S]*/u, label: "受众触发切片", mechanism: "从需求触发时刻重新定义谁最需要这条内容。", question: "除了原有人群，还有谁会在相同情境下产生同一问题？" }
  ],
  unknown: [
    { code: "creative_reframe", pattern: /[\s\S]*/u, label: "创意问题重构", mechanism: "先抽象问题和证据，再从新的受众或场景重新作答。", question: "如果不能复用原句、原镜头和原人物，仍然成立的创意机制是什么？" }
  ]
});

const EVIDENCE = Object.freeze({
  pending: { rank: 1, code: "untested", label: "尚未验证", note: "只是一条待验证方向，不应被描述为有效经验。" },
  insufficient: { rank: 2, code: "insufficient", label: "样本不足", note: "已有本地结果但未达到最低观察门槛。" },
  metric_missing: { rank: 2, code: "incomplete", label: "指标不完整", note: "结果缺少关键指标，暂不能形成判断。" },
  below_target: { rank: 3, code: "observed", label: "已有结果观察", note: "版本结果未达到本项目目标，只适合用来提出新问题。" },
  below_parent: { rank: 3, code: "observed", label: "已有版本对照", note: "结果低于父版本；这是描述性差异，不证明机制因果。" },
  above_parent: { rank: 4, code: "observed", label: "已有正向观察", note: "结果高于父版本但未达到目标；不能据此宣称机制有效。" },
  target_met: { rank: 5, code: "target_met", label: "达到本地目标", note: "该来源版本达到本项目目标，但仍不能证明此创意机制导致结果。" }
});

const CHALLENGE_EVIDENCE = Object.freeze({
  untested: { label: "尚未验证", note: "把它当作待验证假设，不要当成有效经验。" },
  insufficient: { label: "样本不足", note: "已有观察未达到最低门槛，挑战题必须保留验证条件。" },
  incomplete: { label: "指标不完整", note: "关键结果缺失，只能用来提出问题。" },
  observed: { label: "已有描述性观察", note: "只说明来源版本之间存在差异，不证明机制因果。" },
  target_met: { label: "来源版本达到本地目标", note: "仍需把新方向作为独立实验重新验证。" },
  quality_review: { label: "口径待核对", note: "在口径问题解决前，不得用来源结果支持任何创意结论。" }
});

const COUNTER_PROMPTS = Object.freeze({
  result_first: "反过来先呈现问题或证据，比较哪种信息顺序更容易被理解。",
  proof_first: "暂不展示证据结论，先让真实问题发生，再让证据自然出现。",
  contrast_first: "去掉反差表达，只用连续真实动作建立观看理由。",
  problem_first: "不先描述问题，改为先展示可观察结果或解决过程。",
  number_first: "去掉数字线索，尝试用一次完整演示表达同一事实。",
  hook_reframe: "从结果、问题、证据和反差中选择与当前不同的叙事起点。",
  proof_claim: "保留同一事实，分别从体验价值和行动成本重新解释。",
  efficiency_claim: "不强调速度，改从可靠性、体验或使用边界表达价值。",
  trust_claim: "不使用安心形容词，改用条件、过程和限制建立信任。",
  experience_claim: "去掉主观形容，改用动作、环境和前后状态让体验可见。",
  claim_reframe: "选择一个相反的价值视角，但事实与证据口径必须保持一致。",
  comparison_scene: "取消并排对比，改在单一真实流程中连续展示证据。",
  moment_scene: "换到另一个需求发生时刻，检查主张是否仍然成立。",
  demo_scene: "减少演示步骤，改用结果或人物反应承接，但不能省略关键条件。",
  scene_transfer: "选择与当前完全不同的时间、空间和人物关系重新组织画面。",
  newcomer_audience: "改为面向已有经验的人，减少解释并增加验证细节。",
  problem_audience: "不按问题状态分组，改按决策阶段或使用频率切分。",
  intent_audience: "换到低认知阶段，重新判断第一条必要信息。",
  audience_reframe: "选择一个不同的需求触发条件，重写场景与表达语气。",
  creative_reframe: "保留问题本身，但同时更换受众、场景和证据形式。"
});

function normalized(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function variableKey(entry) {
  return VARIABLE_KEYS[normalized(entry?.version?.primaryVariable || entry?.version?.planItem?.singleVariable)] || "unknown";
}

function variableValue(entry, key) {
  const item = entry.version.planItem;
  if (key === "hook") return normalized(item.hook || item.variant);
  if (key === "claim") return normalized(item.coreClaim || item.sellingPoint || item.variant);
  if (key === "scene") return normalized(item.scene || item.variant);
  if (key === "audience") return normalized(item.audience || item.variant);
  return normalized(item.variant);
}

function patternFor(entry, key) {
  const value = variableValue(entry, key);
  return PATTERNS[key].find((candidate) => candidate.pattern.test(value));
}

function evidenceFor(entry) {
  if (entry?.result?.qualityWarnings?.length) {
    return { rank: 0, code: "quality_review", label: "口径待核对", note: "来源结果存在本地口径提醒，不能用于支持灵感方向。" };
  }
  return EVIDENCE[entry?.evaluation?.code] || EVIDENCE.pending;
}

export function buildInspirationRelay(timeline = [], { targetRoi } = {}) {
  const batch = buildLatestOperatorBatchHandoff(timeline, { targetRoi });
  if (batch.code === "empty") return { code: "empty", cards: [], sourceVersionCount: 0, omittedCount: 0 };
  if (!batch.copyable) return { code: "too_large", cards: [], sourceVersionCount: batch.total, omittedCount: batch.total };
  const cards = [];
  const indexByKey = new Map();
  for (const item of batch.entries) {
    const key = variableKey(item.entry);
    const pattern = patternFor(item.entry, key);
    const evidence = evidenceFor(item.entry);
    const identity = `${key}:${pattern.code}`;
    const existingIndex = indexByKey.get(identity);
    if (existingIndex !== undefined) {
      const existing = cards[existingIndex];
      existing.sourceCount += 1;
      if (evidence.code === "quality_review" || (existing.evidenceCode !== "quality_review" && evidence.rank > existing.evidenceRank)) {
        existing.evidenceCode = evidence.code;
        existing.evidenceLabel = evidence.label;
        existing.evidenceNote = evidence.note;
        existing.evidenceRank = evidence.rank;
      }
      continue;
    }
    if (cards.length >= MAX_INSPIRATION_RELAY_CARDS) continue;
    indexByKey.set(identity, cards.length);
    cards.push({
      variableCode: key,
      variableLabel: VARIABLE_LABELS[key],
      mechanismCode: pattern.code,
      mechanismLabel: pattern.label,
      mechanism: pattern.mechanism,
      question: pattern.question,
      originalityMoves: [...ORIGINALITY_MOVES[key]],
      evidenceCode: evidence.code,
      evidenceLabel: evidence.label,
      evidenceNote: evidence.note,
      evidenceRank: evidence.rank,
      sourceCount: 1
    });
  }
  return {
    code: cards.length ? "ready" : "empty",
    cards,
    sourceVersionCount: batch.total,
    omittedCount: Math.max(0, batch.total - cards.reduce((sum, card) => sum + card.sourceCount, 0)),
    testedCount: cards.filter((card) => !["untested", "quality_review"].includes(card.evidenceCode)).length
  };
}

export function inspirationRelayToText(relay) {
  if (!relay || !Array.isArray(relay.cards) || !relay.cards.length) throw new Error("当前没有可分享的脱敏灵感方向");
  const lines = [
    "# 创意灵感接力包",
    "",
    `- 灵感方向：${relay.cards.length} 个`,
    `- 来源范围：用户自有或已授权方案中的 ${relay.sourceVersionCount} 个本地版本`,
    "- 已移除：项目名、测试编号、批次编号、素材名、指标数值、完整脚本和具体品牌主张",
    "- 使用方式：任选一个机制重新创作，并至少改写受众、场景、证据、节奏与行动引导中的三项",
    "",
    "> 这些内容只用于启发原创思考，不是可直接发布的脚本、效果预测或因果结论；不得据此复制他人素材、虚构证据或绕过授权。",
    ""
  ];
  relay.cards.forEach((card, index) => {
    lines.push(
      `## 灵感 ${String(index + 1).padStart(2, "0")} · ${card.mechanismLabel}`,
      "",
      `- 可迁移维度：${card.variableLabel}`,
      `- 创意机制：${card.mechanism}`,
      `- 启发问题：${card.question}`,
      `- 原创改写：${card.originalityMoves.join("；")}`,
      `- 证据状态：${card.evidenceLabel}。${card.evidenceNote}`,
      `- 聚合来源：${card.sourceCount} 个本地版本使用了相近机制`,
      ""
    );
  });
  return lines.join("\n").trim();
}

export function inspirationCardToChallenge(card) {
  const variableCode = String(card?.variableCode || "");
  const mechanismCode = String(card?.mechanismCode || "");
  const pattern = PATTERNS[variableCode]?.find((candidate) => candidate.code === mechanismCode);
  const evidence = CHALLENGE_EVIDENCE[String(card?.evidenceCode || "")];
  if (!pattern || !evidence || !Object.hasOwn(ORIGINALITY_MOVES, variableCode)) throw new Error("灵感卡格式无效，无法生成共创挑战");
  const moves = ORIGINALITY_MOVES[variableCode];
  const counterPrompt = COUNTER_PROMPTS[mechanismCode] || COUNTER_PROMPTS.creative_reframe;
  return [
    `# 创意共创挑战 · ${pattern.label}`,
    "",
    `- 共创命题：${pattern.mechanism}`,
    `- 起始追问：${pattern.question}`,
    `- 证据边界：${evidence.label}。${evidence.note}`,
    "",
    "## 三路发散",
    "",
    `1. 同机制异情境：${moves[0]}，同时${moves[1]}。`,
    `2. 反向机制：${counterPrompt}`,
    `3. 新证据路线：${moves[2]}，并设计一个能够被现场拍摄和人工核对的证据动作。`,
    "",
    "## 每一路必须交付",
    "",
    "- 一句话测试假设：只声明一个主要变量。",
    "- 前三秒信息：观众第一眼看到或听到什么。",
    "- 真实场景与受众：需求在何时、何地、对谁发生。",
    "- 可核验证据：现场需要拍到什么，授权和事实来源是什么。",
    "- 承接节奏与行动引导：如何继续观看，下一步希望观众做什么。",
    "- 失败条件：出现什么情况就放弃该方向，不事后修改判断口径。",
    "",
    "## 原创检查",
    "",
    "- 不复用来源素材的原句、镜头、人物、品牌表达或完整结构。",
    "- 至少改变受众、场景、证据、节奏与行动引导中的三项。",
    "- 不虚构体验、数据、资质、对比或效果承诺。",
    "- 产出只是待验证方案，不得标记为爆款公式或有效结论。",
    "",
    "> 本挑战题由本地固定规则从脱敏灵感机制生成，不包含来源项目、素材、编号、指标数值或完整脚本。"
  ].join("\n");
}
