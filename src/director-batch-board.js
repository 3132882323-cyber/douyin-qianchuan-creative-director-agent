import { buildDirectorMonitorCard } from "./director-monitor-card.js";

export const DIRECTOR_BATCH_BOARD_LIMITS = Object.freeze({ minItems: 2, maxItems: 20 });

const VARIABLE_DEFINITIONS = Object.freeze({
  hook: {
    label: "前三秒钩子",
    field: "hook",
    assembly: {
      variableWindow: "0.0–3.0 秒的首帧、钩子口播与首屏字幕",
      commonSpine: "第 3 秒确认转接点之后的问题—证据—行动主体段，以及不含钩子的证据补拍与结尾净版",
      guard: "每个版本的首帧、钩子口播和首屏字幕必须成组使用，禁止只换字幕或把其他版本的开场音频接进来。"
    },
    sharedShots: [
      "先按 B00 完整拍一条全流程母版，锁定演员、机位、光线、证据、时长与行动引导。",
      "3 秒后的问题—证据—行动主体段作为共用骨架；确认转接点一致后再拍钩子插条。",
      "共用补拍：无口播证据全程、关键细节特写、环境空镜、结尾净版与至少 2 秒剪辑余量。"
    ],
    uniqueInstruction: (entry) => `只重拍 0–3 秒首帧、钩子口播和首屏字幕：“${entry.value}”；第 3 秒必须接回同一共用证据段。`
  },
  claim: {
    label: "核心主张",
    field: "claim",
    assembly: {
      variableWindow: "主张第一次出现起，直到对应证据条件、过程与结果完整落地",
      commonSpine: "不承载具体主张的场景建立、中性过程、环境声与结尾净版；具体证据是否可共用必须逐条人工确认",
      guard: "主张口播、主张字幕和支持该主张的证据必须成组锁定，禁止把另一主张的结论贴到同一证据上。"
    },
    sharedShots: [
      "先按 B00 完整拍一条全流程母版，锁定前三秒、受众、场景、演员、机位、时长与行动引导。",
      "共用首帧、场景建立、无主张的中性过程镜头、环境声和结尾净版。",
      "不同主张不得共用无法支持该主张的证据镜头；每条主张必须单独核对事实来源。"
    ],
    uniqueInstruction: (entry) => `重拍主张口播、对应字幕和能够支持“${entry.value}”的证据动作；前三秒与场景保持基线一致。`
  },
  scene: {
    label: "拍摄场景",
    field: "scene",
    assembly: {
      variableWindow: "场景建立、人物在场动作、环境声及所有依赖该环境的证据衔接",
      commonSpine: "只有与具体环境无关、连续性可人工证明的证据特写、标准口播音频和结尾净版可列为候选共用素材",
      guard: "不得用裁切、放大或无关特写伪装场景变化；曝光、白平衡、收音或道具连续性不一致时按独立版本处理。"
    },
    sharedShots: [
      "先拍 B00 完整场景母版，锁定受众、钩子、主张、证据口径、时长与行动引导。",
      "只共用不依赖具体环境的证据特写、标准口播音频和结尾净版；场景建立与人物动作不能假装共用。",
      "换场后重新记录机位高度、焦段、曝光、白平衡、收音和道具位置，避免场景变量带入其他变化。"
    ],
    uniqueInstruction: (entry) => `在“${entry.value}”完整重拍场景建立、人物动作和必要证据衔接；钩子、主张与行动引导逐字保持一致。`
  },
  audience: {
    label: "目标受众",
    field: "audience",
    assembly: {
      variableWindow: "受众称呼、问题触发、人物反应和任何直接指向该受众的字幕或口播",
      commonSpine: "不包含特定受众称呼的证据全程、细节特写、环境空镜和结尾净版",
      guard: "称呼、问题、人物反应与首屏字幕必须来自同一受众版本，禁止只替换人群标签而保留不匹配的表演。"
    },
    sharedShots: [
      "先按 B00 完整拍一条母版，锁定钩子、主张、场景、证据、机位、时长与行动引导。",
      "共用不带特定受众称呼的证据全程、细节特写、环境空镜和结尾净版。",
      "受众变化必须体现在称呼、问题触发和表演语气，不得同时更换主张、场景或证据条件。"
    ],
    uniqueInstruction: (entry) => `重拍面向“${entry.value}”的称呼、问题触发和人物反应；证据动作、场景与核心主张保持基线一致。`
  }
});

const VARIABLE_LABELS = Object.freeze({
  "前三秒钩子": "hook",
  hook: "hook",
  "核心主张": "claim",
  sellingPoint: "claim",
  claim: "claim",
  "拍摄场景": "scene",
  scene: "scene",
  "目标受众": "audience",
  audience: "audience"
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function text(value, maxLength = 4000) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (result.length > maxLength) throw new Error("批次镜头字段超过本地处理上限");
  return result;
}

function comparisonKey(value) {
  return text(value).toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]/gu, "");
}

function variableCode(plan, firstItem) {
  return VARIABLE_LABELS[text(plan.testVariable, 80)] || VARIABLE_LABELS[text(firstItem.singleVariable, 80)] || "";
}

function fieldValue(item, code) {
  if (code === "claim") return text(item.coreClaim ?? item.sellingPoint);
  return text(item[code]);
}

function fixedFieldDefinitions(variable) {
  return [
    { code: "hook", label: "前三秒钩子" },
    { code: "claim", label: "核心主张" },
    { code: "scene", label: "拍摄场景" },
    { code: "audience", label: "目标受众" }
  ].filter((definition) => definition.code !== variable);
}

export function buildDirectorBatchBoard(plan) {
  const source = record(plan, "批次拍摄方案");
  if (!Array.isArray(source.items) || source.items.length < DIRECTOR_BATCH_BOARD_LIMITS.minItems || source.items.length > DIRECTOR_BATCH_BOARD_LIMITS.maxItems) {
    throw new Error(`批次共用镜头板只支持 ${DIRECTOR_BATCH_BOARD_LIMITS.minItems}–${DIRECTOR_BATCH_BOARD_LIMITS.maxItems} 条方案`);
  }
  const items = source.items.map((item) => record(item, "批次拍摄任务"));
  const monitors = items.map((_, itemIndex) => buildDirectorMonitorCard(source, { itemIndex }));
  const definitionCode = variableCode(source, items[0]);
  const definition = VARIABLE_DEFINITIONS[definitionCode];
  if (!definition) throw new Error("批次共用镜头板无法识别本轮唯一变量");
  const blockers = monitors.flatMap((monitor) => monitor.missing.map((field) => `${monitor.id}：${field}`));
  const firstId = monitors[0].id;
  if (!/(?:^|[-_.:])B00$/iu.test(firstId) && text(items[0].type, 80) !== "基线") blockers.push(`${firstId}：首条任务不是明确的 B00 基线`);
  const sourceBatchId = text(source.batchId, 160);
  const seenIds = new Set();
  for (let index = 0; index < monitors.length; index += 1) {
    const id = monitors[index].id;
    const idKey = comparisonKey(id);
    if (seenIds.has(idKey)) blockers.push(`${id}：测试编号重复，无法生成唯一场记`);
    seenIds.add(idKey);
    if (sourceBatchId && !id.startsWith(`${sourceBatchId}-`)) blockers.push(`${id}：测试编号不属于当前批次 ${sourceBatchId}`);
    if (index > 0 && (!/(?:^|[-_.:])A\d{2}$/iu.test(id) || text(items[index].type, 80) !== "变体")) blockers.push(`${id}：变体必须使用 A01 起的明确编号并标记为变体`);
  }
  const declaredVariables = new Set(items.map((item) => VARIABLE_LABELS[text(item.singleVariable, 80)] || ""));
  if (declaredVariables.size !== 1 || !declaredVariables.has(definitionCode)) blockers.push("同批方案声明的唯一变量不一致");
  const baseline = items[0];
  for (const field of fixedFieldDefinitions(definitionCode)) {
    const expected = fieldValue(baseline, field.code);
    if (!expected) blockers.push(`${firstId}：缺少基线${field.label}`);
    for (let index = 1; index < items.length; index += 1) {
      const current = fieldValue(items[index], field.code);
      if (!current || comparisonKey(current) !== comparisonKey(expected)) blockers.push(`${monitors[index].id}：非测试字段“${field.label}”与基线不同`);
    }
  }
  const baselineFixed = text(baseline.fixedElements);
  if (!baselineFixed) blockers.push(`${firstId}：缺少保持不变项`);
  for (let index = 1; index < items.length; index += 1) {
    if (comparisonKey(items[index].fixedElements) !== comparisonKey(baselineFixed)) blockers.push(`${monitors[index].id}：保持不变项与基线不同`);
  }
  const valueKeys = new Map();
  const entries = items.map((item, index) => {
    const value = fieldValue(item, definition.field);
    const declaredValue = text(item.variant);
    const key = comparisonKey(value);
    if (!value) blockers.push(`${monitors[index].id}：缺少${definition.label}变量值`);
    if (!declaredValue || comparisonKey(declaredValue) !== key) blockers.push(`${monitors[index].id}：方案变量值与${definition.label}字段不一致`);
    if (key && valueKeys.has(key)) blockers.push(`${monitors[index].id}：与 ${valueKeys.get(key)} 使用了重复变量值`);
    else if (key) valueKeys.set(key, monitors[index].id);
    return {
      id: monitors[index].id,
      type: monitors[index].type,
      orderLabel: monitors[index].orderLabel,
      value,
      firstFrame: monitors[index].beats.firstFrame,
      spokenOpening: monitors[index].beats.spokenOpening,
      subtitleCue: monitors[index].beats.subtitleCue,
      proofCue: monitors[index].beats.proofCue,
      editingBridge: monitors[index].beats.editingBridge,
      warningCount: monitors[index].warnings.length,
      requiresReshoot: index !== 0,
      uniqueInstruction: ""
    };
  });
  for (const entry of entries) {
    entry.uniqueInstruction = entry.requiresReshoot
      ? definition.uniqueInstruction(entry)
      : `在 B00 全流程母版中完整执行“${entry.value}”；通过前三秒监看后锁定为连续性参照，不再单独补拍同一变量插条。`;
  }
  const sharedLocks = fixedFieldDefinitions(definitionCode).map((field) => ({ label: field.label, value: fieldValue(baseline, field.code) }));
  sharedLocks.push({ label: "保持不变项", value: baselineFixed });
  const batchId = text(source.batchId || firstId.replace(/-(?:B00|A\d{2})$/u, ""), 160) || "未记录批次";
  return {
    code: blockers.length ? "blocked" : "ready",
    copyable: blockers.length === 0,
    batchId,
    variableCode: definitionCode,
    variableLabel: definition.label,
    total: entries.length,
    sharedLocks,
    sharedShots: [...definition.sharedShots],
    assembly: { ...definition.assembly },
    entries,
    blockers: [...new Set(blockers)]
  };
}

export function directorBatchBoardToText(board) {
  const source = record(board, "批次共用镜头板");
  if (source.copyable !== true || !Array.isArray(source.entries) || source.entries.length < DIRECTOR_BATCH_BOARD_LIMITS.minItems || source.entries.length > DIRECTOR_BATCH_BOARD_LIMITS.maxItems || !Array.isArray(source.sharedShots) || !Array.isArray(source.sharedLocks)) {
    throw new Error(`批次共用镜头板仍待修正：${Array.isArray(source.blockers) && source.blockers.length ? source.blockers.join("；") : "单变量或现场字段不完整"}`);
  }
  const lines = [
    `# 批次共用镜头板 · ${text(source.batchId, 160)}`,
    "",
    `- 本轮唯一变量：${text(source.variableLabel, 80)}`,
    `- 拍摄任务：${source.entries.length} 条，先拍 B00 全流程，再拍共用骨架与逐版本变量插条。`,
    "- 核心纪律：只有明确列在“逐版本重拍”的内容可以变化；其他条件发现漂移就停机复核。",
    "",
    "## 连续性锁定",
    "",
    ...source.sharedLocks.map((item) => `- ${text(item.label, 80)}：${text(item.value)}`),
    "",
    "## 共用镜头 · 只拍一次",
    "",
    ...source.sharedShots.map((item) => `- ${text(item)}`),
    "",
    "## 变量镜头 · 基线随母版 / 变体逐版本重拍",
    ""
  ];
  for (const entry of source.entries) {
    lines.push(
      `### ${text(entry.orderLabel, 80)} · ${text(entry.id, 160)} · ${text(entry.type, 80)}`,
      "",
      `- 本条变量值：${text(entry.value)}`,
      `- ${entry.requiresReshoot ? "变量插拍" : "基线处理"}：${text(entry.uniqueInstruction)}`,
      `- 首帧场记：${text(entry.firstFrame)}`,
      `- 证据核对：${text(entry.proofCue)}`,
      `- 监看状态：${entry.warningCount ? `${Number(entry.warningCount)} 项开机提醒，拍完立即回看前三秒监看卡。` : "无自动密度提醒，仍需手机停帧和真人语速复核。"}`,
      ""
    );
  }
  lines.push(
    "## 场记命名",
    "",
    "- 文件/场记板建议：批次__测试编号__镜头类型__机位__Take；不得只写‘新版’‘再来一条’。",
    "- 每换一个变量插条，先口头报测试编号和变量值，再开机；拍完立即核对场记与文件序号。",
    "",
    "## 收工前保险镜头",
    "",
    "- 无口播完整证据过程、关键细节特写、环境空镜、人物自然反应、结尾净版、环境声与每段前后至少 2 秒余量。",
    "- 保险镜头只能补剪辑连续性，不得用来偷偷改变本轮主张、受众、场景或证据条件。",
    "",
    "> 本镜头板只重排当前本地方案，不估算节省工时、不自动合并素材，也不修改方案或制作状态；现场是否能够共用仍由编导按真实场景、授权和证据连续性确认。"
  );
  return lines.join("\n");
}

export function directorBatchEditAssemblyToText(board) {
  const source = record(board, "批次剪辑装配单");
  if (
    source.copyable !== true
    || !Array.isArray(source.entries)
    || source.entries.length < DIRECTOR_BATCH_BOARD_LIMITS.minItems
    || source.entries.length > DIRECTOR_BATCH_BOARD_LIMITS.maxItems
    || !Array.isArray(source.sharedLocks)
    || !source.assembly
    || typeof source.assembly !== "object"
    || Array.isArray(source.assembly)
  ) {
    throw new Error(`批次剪辑装配单仍待修正：${Array.isArray(source.blockers) && source.blockers.length ? source.blockers.join("；") : "单变量或现场字段不完整"}`);
  }
  const batchId = text(source.batchId, 160);
  const variableWindow = text(source.assembly.variableWindow);
  const commonSpine = text(source.assembly.commonSpine);
  const guard = text(source.assembly.guard);
  if (!batchId || !variableWindow || !commonSpine || !guard) throw new Error("批次剪辑装配单缺少装配边界");
  const lines = [
    `# 批次剪辑装配单 · ${batchId}`,
    "",
    `- 本轮唯一变量：${text(source.variableLabel, 80)}`,
    `- 版本数量：${source.entries.length} 条；B00 是连续性参照，A 编号版本只替换下列变量窗口。`,
    "- 装配原则：先建立并锁定 B00 时间轴，再复制时间轴生成变体；每次只替换一个版本文件夹中的变量素材，不从聊天记录猜文件。",
    "- 共用素材只是候选；证据条件、人物动作、光线、收音或事实口径无法确认连续时，必须回到独立版本素材。",
    "",
    "## 素材筐与命名",
    "",
    `- 00_REFERENCE/${batchId}__B00__MASTER__T01：完整母版和导演确认参考。`,
    `- 10_SHARED/${batchId}__SHARED__镜头类型__机位__T01：人工确认可以跨版本共用的骨架。`,
    `- 20_VARIANTS/测试编号/测试编号__VAR__镜头类型__T01：只放该测试编号的变量插条。`,
    `- 90_EXPORT/测试编号__V01：每轮导出递增版本号，不使用“最终版”“最后版”等不可追踪命名。`,
    "- 本单只给出命名模板，不读取、移动、重命名或删除本机文件。",
    "",
    "## 时间轴锁定",
    "",
    `- 变量窗口：${variableWindow}。`,
    `- 共用骨架：${commonSpine}。`,
    `- 防串版：${guard}`,
    "- 版本复制后先断开变量片段与 B00 的链接，再替换画面、口播和字幕；未确认替换完成前不得批量导出。",
    "",
    "## 逐版本装配图",
    ""
  ];
  for (const entry of source.entries) {
    lines.push(
      `### ${text(entry.orderLabel, 80)} · ${text(entry.id, 160)} · ${text(entry.type, 80)}`,
      "",
      `- 素材来源：${entry.requiresReshoot ? `20_VARIANTS/${text(entry.id, 160)}/，只允许使用本版本变量插条。` : `00_REFERENCE/${batchId}__B00__MASTER__T01，作为母版锁定。`}`,
      `- 本条变量值：${text(entry.value)}`,
      `- 替换范围：${text(entry.uniqueInstruction)}`,
      `- 首帧/分镜：${text(entry.firstFrame)}`,
      `- 口播首句：${text(entry.spokenOpening)}`,
      `- 首屏字幕：${text(entry.subtitleCue)}`,
      `- 证据镜头：${text(entry.proofCue)}`,
      `- 剪辑承接：${text(entry.editingBridge)}`,
      `- 导出名：${text(entry.id, 160)}__V01`,
      ""
    );
  }
  lines.push(
    "## 首轮导出验收",
    "",
    "1. 从导出文件名、首帧、口播首句和首屏字幕四处核对测试编号，任一处无法对应就停止交付。",
    "2. 与 B00 并排检查，只允许本轮声明的唯一变量及其必要生产呈现发生变化；其他变化退回剪辑修正。",
    "3. 逐帧检查变量窗口接回共用骨架的画面、动作、光线、收音和字幕连续性，不用转场掩盖事实不连续。",
    "4. 证据必须保留条件、过程和结果，主张、字幕与证据不能跨版本错配；事实和授权仍由编导人工核对。",
    "5. 核对时长、画幅、音量、字幕安全区、结尾行动引导和黑帧；本单不替代真实设备预览与发布前合规检查。",
    "6. 随机抽查至少一个 A 编号版本，关闭画面或声音分别核对，确认没有残留 B00 或其他变体的变量片段。",
    "",
    "> 本装配单只重排当前本地方案，不读取或分析媒体、不操作剪辑软件、不批量改名、不自动导出，也不判断创意效果；装配、连续性、事实和授权必须由编导与剪辑师共同确认。"
  );
  return lines.join("\n");
}
