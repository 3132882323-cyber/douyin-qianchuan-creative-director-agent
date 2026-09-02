import { buildDirectorBatchBoard, DIRECTOR_BATCH_BOARD_LIMITS } from "./director-batch-board.js";

export const DIRECTOR_TAKE_HANDOFF_LIMITS = Object.freeze({
  minItems: DIRECTOR_BATCH_BOARD_LIMITS.minItems,
  maxItems: DIRECTOR_BATCH_BOARD_LIMITS.maxItems,
  maxFieldLength: 4000
});

const SHARED_CAPTURE_DEFINITIONS = Object.freeze([
  Object.freeze({ code: "C01", label: "完整证据全程", instruction: "完整记录证据条件、过程与结果的无口播或中性过程镜头；是否可跨版本共用必须人工确认。" }),
  Object.freeze({ code: "C02", label: "关键细节特写", instruction: "补齐支撑事实判断的关键动作、材质、刻度、前后状态或结果细节。" }),
  Object.freeze({ code: "C03", label: "场景与环境空镜", instruction: "记录场景建立、环境关系和不承载变量表达的过渡空镜。" }),
  Object.freeze({ code: "C04", label: "结尾净版", instruction: "保留没有临时口令、穿帮或多余贴纸的结尾画面与固定行动引导。" }),
  Object.freeze({ code: "C05", label: "环境声与同步声", instruction: "单独记录可用于连续性修复的环境底噪、动作声和已获授权的同步声。" }),
  Object.freeze({ code: "C06", label: "剪辑余量", instruction: "关键动作入点前和出点后各保留至少 2 秒稳定画面，记录对应文件。" })
]);

const VARIABLE_RESTRICTED_SLOTS = Object.freeze({
  hook: Object.freeze({}),
  claim: Object.freeze({
    C01: "核心主张变化时，证据条件、过程和结果必须逐版本对应，不能跨主张共用。",
    C02: "支撑不同主张的关键细节必须逐版本对应，不能用另一主张的细节补结论。"
  }),
  scene: Object.freeze({
    C01: "完整证据的条件、过程和结果通常依赖当前场景，必须逐版本拍摄和归档。",
    C03: "场景本身是本轮变量，场景建立与环境空镜必须逐版本归档。",
    C05: "环境声属于场景连续性，换场后必须逐版本记录和归档。"
  }),
  audience: Object.freeze({})
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

function text(value, label, maxLength = DIRECTOR_TAKE_HANDOFF_LIMITS.maxFieldLength) {
  const result = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!result) throw new Error(`${label}缺失`);
  if (result.length > maxLength) throw new Error(`${label}超过本地接片单处理上限`);
  return result;
}

function assertReadyBoard(board) {
  const source = record(board, "批次接片来源");
  if (
    source.copyable !== true
    || !Array.isArray(source.entries)
    || source.entries.length < DIRECTOR_TAKE_HANDOFF_LIMITS.minItems
    || source.entries.length > DIRECTOR_TAKE_HANDOFF_LIMITS.maxItems
    || !Array.isArray(source.sharedShots)
    || !source.sharedShots.length
    || !Array.isArray(source.sharedLocks)
    || !source.sharedLocks.length
  ) {
    const reason = Array.isArray(source.blockers) && source.blockers.length
      ? source.blockers.join("；")
      : "单变量、连续性或现场字段尚未通过批次检查";
    throw new Error(`批次收工接片单仍待修正：${reason}`);
  }
  return source;
}

function assertReadyHandoff(handoff) {
  const source = record(handoff, "批次收工接片单");
  if (
    source.copyable !== true
    || source.code !== "ready"
    || !Object.hasOwn(VARIABLE_RESTRICTED_SLOTS, source.variableCode)
    || !Array.isArray(source.entries)
    || source.entries.length < DIRECTOR_TAKE_HANDOFF_LIMITS.minItems
    || source.entries.length > DIRECTOR_TAKE_HANDOFF_LIMITS.maxItems
    || !Array.isArray(source.sharedRules)
    || source.sharedRules.length !== 2
    || !Array.isArray(source.sharedCaptureSlots)
    || source.sharedCaptureSlots.length !== SHARED_CAPTURE_DEFINITIONS.length
    || !Array.isArray(source.sharedLocks)
    || source.sharedLocks.length !== 4
  ) {
    throw new Error("批次收工接片单结构不完整");
  }
  return source;
}

function sharedCaptureSlot(definition, variableCode) {
  const restriction = VARIABLE_RESTRICTED_SLOTS[variableCode]?.[definition.code] || "";
  return {
    ...definition,
    sharingMode: restriction ? "per_version" : "candidate",
    sharingReason: restriction || "只有画面、声音、动作和事实条件连续时才可候选共用；无法确认就归回独立版本。"
  };
}

function expectedEntryIdentity(batchId, index) {
  return {
    id: index === 0 ? `${batchId}-B00` : `${batchId}-A${String(index).padStart(2, "0")}`,
    type: index === 0 ? "基线" : "变体",
    orderLabel: index === 0 ? "先拍基线" : `第 ${index + 1} 条变体`,
    requiresReshoot: index !== 0
  };
}

function assertEntryIdentity(entry, batchId, index) {
  const expected = expectedEntryIdentity(batchId, index);
  const id = text(entry.id, "测试编号", 160);
  const type = text(entry.type, `${id} 类型`, 80);
  const orderLabel = text(entry.orderLabel, `${id} 拍摄顺序`, 80);
  if (id !== expected.id) throw new Error(`批次收工接片单编号顺序无效：应为 ${expected.id}`);
  if (type !== expected.type) throw new Error(`${id} 类型必须为${expected.type}`);
  if (orderLabel !== expected.orderLabel) throw new Error(`${id} 拍摄顺序必须为“${expected.orderLabel}”`);
  if (entry.requiresReshoot !== expected.requiresReshoot) throw new Error(`${id} 补拍身份与基线/变体不一致`);
  return { id, type, orderLabel, requiresReshoot: expected.requiresReshoot };
}

/**
 * Builds an immutable-by-convention handoff model from a plan. The existing
 * batch-board validator remains the single source of truth for batch safety.
 * No media, local path, production state or clock is read here.
 */
export function buildDirectorTakeHandoff(plan) {
  const board = assertReadyBoard(buildDirectorBatchBoard(plan));
  const batchId = text(board.batchId, "测试批次", 160);
  const variableCode = text(board.variableCode, "唯一变量代码", 32);
  if (!Object.hasOwn(VARIABLE_RESTRICTED_SLOTS, variableCode)) throw new Error("批次收工接片单无法识别唯一变量");
  const variableLabel = text(board.variableLabel, "唯一变量", 80);
  const seenIds = new Set();
  const entries = board.entries.map((candidate, index) => {
    const entry = record(candidate, "逐版本接片项");
    const rawId = text(entry.id, "测试编号", 160);
    const key = rawId.toLocaleLowerCase("zh-CN");
    if (seenIds.has(key)) throw new Error(`批次收工接片单包含重复测试编号：${rawId}`);
    seenIds.add(key);
    const identity = assertEntryIdentity(entry, batchId, index);
    const { id } = identity;
    return {
      order: index + 1,
      id,
      type: identity.type,
      orderLabel: identity.orderLabel,
      variableValue: text(entry.value, `${id} 变量值`),
      plannedCapture: text(entry.uniqueInstruction, `${id} 计划拍摄内容`),
      firstFrame: text(entry.firstFrame, `${id} 首帧场记`),
      spokenOpening: text(entry.spokenOpening, `${id} 口播首句`),
      subtitleCue: text(entry.subtitleCue, `${id} 首屏字幕`),
      proofCue: text(entry.proofCue, `${id} 证据镜头`),
      requiresReshoot: identity.requiresReshoot
    };
  });
  return {
    code: "ready",
    copyable: true,
    batchId,
    variableCode,
    variableLabel,
    sharedLocks: board.sharedLocks.map((candidate) => {
      const lock = record(candidate, "连续性锁定项");
      return {
        label: text(lock.label, "连续性锁定项名称", 80),
        value: text(lock.value, "连续性锁定项内容")
      };
    }),
    sharedRules: board.sharedShots.slice(1).map((rule, index) => text(rule, `共用边界 ${index + 1}`)),
    sharedCaptureSlots: SHARED_CAPTURE_DEFINITIONS.map((slot) => sharedCaptureSlot(slot, variableCode)),
    entries
  };
}

export function directorTakeHandoffToText(handoff) {
  const source = assertReadyHandoff(handoff);
  const batchId = text(source.batchId, "测试批次", 160);
  const variableCode = text(source.variableCode, "唯一变量代码", 32);
  const variableLabel = text(source.variableLabel, "唯一变量", 80);
  const seenIds = new Set();
  const entries = source.entries.map((candidate, index) => {
    const entry = record(candidate, "逐版本接片项");
    const rawId = text(entry.id, "测试编号", 160);
    const key = rawId.toLocaleLowerCase("zh-CN");
    if (seenIds.has(key)) throw new Error(`批次收工接片单包含重复测试编号：${rawId}`);
    seenIds.add(key);
    const identity = assertEntryIdentity(entry, batchId, index);
    const { id } = identity;
    return {
      order: index + 1,
      id,
      type: identity.type,
      orderLabel: identity.orderLabel,
      variableValue: text(entry.variableValue, `${id} 变量值`),
      plannedCapture: text(entry.plannedCapture, `${id} 计划拍摄内容`),
      firstFrame: text(entry.firstFrame, `${id} 首帧场记`),
      spokenOpening: text(entry.spokenOpening, `${id} 口播首句`),
      subtitleCue: text(entry.subtitleCue, `${id} 首屏字幕`),
      proofCue: text(entry.proofCue, `${id} 证据镜头`),
      requiresReshoot: identity.requiresReshoot
    };
  });
  const sharedLocks = source.sharedLocks.map((candidate) => {
    const lock = record(candidate, "连续性锁定项");
    return `${text(lock.label, "连续性锁定项名称", 80)}：${text(lock.value, "连续性锁定项内容")}`;
  });
  if (new Set(sharedLocks.map((item) => item.split("：", 1)[0])).size !== sharedLocks.length) throw new Error("连续性锁定项重复");
  const sharedRules = source.sharedRules.map((rule, index) => text(rule, `共用边界 ${index + 1}`));
  const sharedCaptureSlots = source.sharedCaptureSlots.map((candidate, index) => {
    const slot = record(candidate, "共用保险素材接片项");
    const expected = SHARED_CAPTURE_DEFINITIONS[index];
    const expectedSlot = sharedCaptureSlot(expected, variableCode);
    const code = text(slot.code, `共用保险素材 ${index + 1} 编号`, 16);
    const label = text(slot.label, `共用保险素材 ${index + 1} 名称`, 80);
    const instruction = text(slot.instruction, `共用保险素材 ${index + 1} 内容`);
    const sharingMode = text(slot.sharingMode, `共用保险素材 ${index + 1} 归档模式`, 32);
    const sharingReason = text(slot.sharingReason, `共用保险素材 ${index + 1} 归档边界`);
    if (
      code !== expected.code
      || label !== expected.label
      || instruction !== text(expected.instruction, `共用保险素材 ${index + 1} 固定内容`)
      || sharingMode !== expectedSlot.sharingMode
      || sharingReason !== text(expectedSlot.sharingReason, `共用保险素材 ${index + 1} 固定边界`)
    ) throw new Error(`共用保险素材槽 ${expected.code} 已被篡改`);
    return {
      code,
      label,
      instruction,
      sharingMode,
      sharingReason
    };
  });
  const lines = [
    `# 批次收工接片单 · ${batchId}`,
    "",
    `- 本轮唯一变量：${variableLabel}`,
    `- 接片顺序：先确认 B00 全流程母版，再清点 ${sharedCaptureSlots.length} 类保险素材，最后逐条核对 ${Math.max(0, entries.length - 1)} 个 A 编号变体。`,
    "- 使用原则：场记只填写真实拍到的文件与人工选定 Take；没有拍到就明确标记需补拍，不得让剪辑师猜文件或跨版本借镜头。",
    "",
    "## 连续性锁定",
    "",
    ...sharedLocks.map((item) => `- ${item}`),
    "",
    "## 当前批次共用边界",
    ""
  ];
  lines.push(...sharedRules.map((rule) => `- ${rule}`), "", "## 保险素材接片区", "", "> 以下六类必须逐项清点；系统会按本轮变量标明候选共用或必须逐版本归档，但实际连续性和可用性仍由编导人工确认。", "");
  for (const slot of sharedCaptureSlots) {
    const versionTakeLines = entries.map((_, index) => `- ${index === 0 ? "基线" : `变体 ${index}`}：实际文件 ________；首选 Take ________；备选 Take ________；声音条 ________`);
    lines.push(
      `### ${slot.code} · ${slot.label}`,
      "",
      `- 清点要求：${slot.instruction}`,
      `- 归档边界：${slot.sharingMode === "candidate" ? "候选共用" : "不得共用，必须逐版本归档"}；${slot.sharingReason}`,
      ...(slot.sharingMode === "candidate"
        ? ["- 实际文件序号/文件名：________", "- 首选 Take：________", "- 备选 Take：________（没有则写“无”）", "- 声音条/同步声：________（没有则写“无”）"]
        : versionTakeLines),
      "- 连续性异常：________（无则写“无”）",
      "- 缺失项：________（无则写“无”）",
      slot.sharingMode === "candidate"
        ? "- 人工结论：[ ] 可作为候选共用  [ ] 不得共用，已归入对应版本  [ ] 需补拍（必须三选一）"
        : "- 人工结论：[ ] 不得共用，已按版本归档  [ ] 需补拍（必须二选一）",
      "- 补拍原因/负责人/期限：________",
      ""
    );
  }
  lines.push("## 逐版本接片与最终剪辑映射", "");
  for (const entry of entries) {
    lines.push(
      `### ${String(entry.order).padStart(2, "0")} · ${entry.id} · ${entry.type}`,
      "",
      `- 拍摄顺序：${entry.orderLabel}`,
      `- 本条变量值：${entry.variableValue}`,
      `- ${entry.requiresReshoot ? "计划变量插拍" : "计划 B00 母版"}：${entry.plannedCapture}`,
      `- 首帧场记：${entry.firstFrame}`,
      `- 计划口播首句：${entry.spokenOpening}`,
      `- 计划首屏字幕：${entry.subtitleCue}`,
      `- 证据镜头：${entry.proofCue}`,
      "- 实际文件序号/文件名：________",
      "- 首选 Take：________",
      "- 备选 Take：________（没有则写“无”）",
      "- 声音条/同步声：________（没有则写“无”）",
      "- 连续性异常：________（无则写“无”）",
      "- 缺失项：________（无则写“无”）",
      "- 人工结论：[ ] 可交剪  [ ] 需补拍（必须二选一）",
      "- 补拍原因/负责人/期限：________",
      "- 最终剪辑映射：仅使用本区人工填写的首选 Take；首选不可用时才回退到备选 Take，二者都不可用则停止装配并补拍。",
      ""
    );
  }
  lines.push(
    "## 批次收工闸门",
    "",
    "- [ ] B00 全流程母版已确认可用，首帧、口播、证据与结尾均能独立成立。",
    "- [ ] 每个 A 编号变体都已填写实际文件与人工结论，没有用 B00 或其他变体冒充变量插条。",
    "- [ ] 共用骨架的画面、声音、光线、动作和事实条件已人工确认连续；无法确认的素材已移回对应独立版本。",
    "- [ ] 所有“需补拍”项都已写明原因、负责人和期限；未关闭前不得把整批标记为可交剪。",
    "- 批次结论：[ ] 齐全可交剪  [ ] 必须补拍（必须二选一）",
    "- 场记/导演：________；交接剪辑师：________；交接时间：________",
    "",
    "> 本单只重排已通过校验的本地方案并提供人工填写槽位；不扫描或读取媒体、不自动选择最佳 Take、不修改方案或制作状态，也不证明素材授权与事实合规。"
  );
  return lines.join("\n");
}
