const MAX_COMMANDS = 3;
const PROJECT_ID_PATTERN = /^prj_[a-z0-9-]{8,64}$/iu;
const TEST_ID_PATTERN = /^[a-z0-9._:-]{1,128}$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/gu;
const LOCAL_PATH_PATTERN = /(?:file:\/\/|[a-z]:[\\/]|(?:^|\s)\\\\|(?:^|\s)\/(?:Users|home|root|tmp|var|private|Volumes|mnt|opt|etc)(?:\/|\s|$))/iu;

export const PRODUCTION_SHIFT_STATIONS = Object.freeze([
  "编导策划",
  "片场",
  "剪辑",
  "投放交接",
  "内容负责人"
]);

const ACTIONS = Object.freeze({
  task_missing: Object.freeze({
    station: "编导策划",
    completion: "受众、创作目标、核心主张或可用证据已补齐并保存。"
  }),
  analysis_missing: Object.freeze({
    station: "编导策划",
    completion: "本地素材复盘已完成，并形成至少一条可用于下一版任务的有效结论。"
  }),
  plan_missing: Object.freeze({
    station: "编导策划",
    completion: "已基于当前任务与复盘生成包含 2–20 个版本的拍摄方案。"
  }),
  plan_stale: Object.freeze({
    station: "编导策划",
    completion: "已按当前任务、复盘和测试条件重新生成方案，旧方案仅保留作对照。"
  }),
  plan_batch_invalid: Object.freeze({
    station: "编导策划",
    completion: "拍摄批次已重建为 2–20 个可逐条核对的版本。"
  }),
  plan_delivery_pending: Object.freeze({
    station: "编导策划",
    completion: "方案检查完成，并生成与当前方案一致的本地交付凭据。"
  }),
  plan_delivery_stale: Object.freeze({
    station: "编导策划",
    completion: "变更后的方案已重新检查，并生成新的本地交付凭据。"
  }),
  versions_unsynced: Object.freeze({
    station: "内容负责人",
    completion: "当前方案的所有测试版本已完整同步到本地版本库。"
  }),
  take_order_ambiguous: Object.freeze({
    station: "片场",
    completion: "最新人工结论已核对并登记，过条先后顺序可以唯一确认。"
  }),
  take_hold: Object.freeze({
    station: "片场",
    completion: "现场核实已完成，并登记了新的人工结论后再继续生产。"
  }),
  take_reshoot: Object.freeze({
    station: "片场",
    completion: "已按人工记录完成修正补拍，并登记新的 Take 过条结论。"
  }),
  take_unreviewed: Object.freeze({
    station: "片场",
    completion: "当前测试版本已完成拍摄，并登记人工过条结论。"
  }),
  take_needs_primary: Object.freeze({
    station: "片场",
    completion: "当前测试版本已人工指定且仅指定一个首选 Take。"
  }),
  take_ready: Object.freeze({
    station: "剪辑",
    completion: "全批次首选 Take 已核对齐全，并完成向剪辑的收工接片。"
  }),
  production_untracked: Object.freeze({
    station: "内容负责人",
    completion: "制作状态已由人工如实设置，未使用自动推断。"
  }),
  production_planned: Object.freeze({
    station: "片场",
    completion: "已按方案开始拍摄，并同步更新当前人工制作状态。"
  }),
  production_shooting: Object.freeze({
    station: "片场",
    completion: "本轮现场动作已完成，并同步更新当前人工制作状态。"
  }),
  production_editing: Object.freeze({
    station: "剪辑",
    completion: "已形成可交付版本，并同步更新当前人工制作状态。"
  }),
  production_ready: Object.freeze({
    station: "投放交接",
    completion: "实际交接状态已由人工确认，并同步更新制作状态。"
  }),
  production_launched: Object.freeze({
    station: "内容负责人",
    completion: "项目已从“立即做”移出，不再占用今日执行位；排产单不据此推断投放结果。"
  }),
  production_paused: Object.freeze({
    station: "内容负责人",
    completion: "项目已从“立即做”移入“暂停”泳道，不再占用今日执行位。"
  }),
  snapshot_error: Object.freeze({
    station: "内容负责人",
    completion: "项目状态已成功重新读取，并基于新快照生成新的生产指令。"
  })
});

const ASSIGNMENT_FIELDS = Object.freeze([
  "source",
  "ownerRole",
  "ownerLabel",
  "materialCode",
  "takeNumber",
  "issueTimecode",
  "nextCorrection"
]);
const ASSIGNMENT_TEXT_FIELDS = Object.freeze(["ownerLabel", "materialCode", "takeNumber", "issueTimecode", "nextCorrection"]);
const OWNER_LABELS = Object.freeze({
  director: "编导",
  camera: "摄影",
  talent: "出镜 / 口播",
  sound: "收音",
  producer: "制片 / 场务",
  compliance: "事实与授权核实",
  editor: "剪辑"
});

const FIELD_LIMITS = Object.freeze({
  projectName: 60,
  manualReason: 200,
  statusLabel: 80,
  nextAction: 120,
  actionContext: 500,
  ownerLabel: 60,
  materialCode: 120,
  takeNumber: 80,
  issueTimecode: 80,
  nextCorrection: 500
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, label, limit, { required = true } = {}) {
  if (typeof value !== "string") throw new Error(`${label}格式无效`);
  const text = value.replace(CONTROL_PATTERN, " ").replace(/\s+/gu, " ").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > limit) throw new Error(`${label}不能超过 ${limit} 个字符`);
  if (text && LOCAL_PATH_PATTERN.test(text)) throw new Error(`${label}不要填写本机路径`);
  return text;
}

function safeDate(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`${label}格式必须为 YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}不是有效日期`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) throw new Error(`${label}格式无效`);
  return value;
}

function safeTestId(value) {
  if (value === null || value === undefined || value === "") return null;
  const testId = cleanText(value, "目标版本", 128);
  if (!TEST_ID_PATTERN.test(testId)) throw new Error("目标版本格式无效");
  return testId;
}

function sanitizeAssignment(value, actionCode) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("人工责任格式无效");
  if (actionCode !== "take_hold" && actionCode !== "take_reshoot") throw new Error("当前生产动作不应包含人工过条责任");
  for (const key of Object.keys(value)) {
    if (!ASSIGNMENT_FIELDS.includes(key)) throw new Error(`人工责任包含未知字段：${key}`);
  }
  if (value.source !== "manual_take_review") throw new Error("人工责任来源无效");
  const ownerRole = String(value.ownerRole || "");
  const expectedOwnerLabel = Object.hasOwn(OWNER_LABELS, ownerRole) ? OWNER_LABELS[ownerRole] : "";
  if (!expectedOwnerLabel) throw new Error("人工责任角色无效");
  const assignment = Object.fromEntries(ASSIGNMENT_TEXT_FIELDS.map((field) => [
    field,
    cleanText(value[field] ?? "", `人工责任${field}`, FIELD_LIMITS[field], { required: false })
  ]));
  if (assignment.ownerLabel !== expectedOwnerLabel) throw new Error("人工责任角色标签不一致");
  if (!assignment.materialCode || !assignment.takeNumber || !assignment.nextCorrection) throw new Error("人工责任缺少素材、Take 或下一条修正");
  assignment.source = "manual_take_review";
  assignment.ownerRole = ownerRole;
  return Object.freeze(assignment);
}

function deadlineReminder(dueOn, today) {
  if (!dueOn) return "无硬性截止日；如有交接时限，请由内容负责人补充。";
  if (dueOn < today) return `已超期 · 原截止 ${dueOn}`;
  if (dueOn === today) return `今日截止 · ${dueOn}`;
  return `截止 ${dueOn}`;
}

function sanitizeCommand(command, index, today) {
  if (!isRecord(command)) throw new Error(`第 ${index + 1} 条生产指令格式无效`);
  const projectId = cleanText(command.projectId, "项目编号", 68);
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("项目编号格式无效");
  if (command.lane !== "now") throw new Error("生产排产单只能包含人工“立即做”项目");
  const actionCode = cleanText(command.actionCode, "动作编号", 64);
  const definition = Object.hasOwn(ACTIONS, actionCode) ? ACTIONS[actionCode] : null;
  if (!definition) throw new Error(`未知生产动作：${actionCode}`);
  if (typeof command.blocked !== "boolean") throw new Error("生产指令阻塞状态格式无效");
  const dueOn = safeDate(command.dueOn, "截止日期", { nullable: true });
  const item = {
    sequence: index + 1,
    projectId,
    projectName: cleanText(command.name, "项目名称", FIELD_LIMITS.projectName),
    testId: safeTestId(command.testId),
    manualOrder: safeInteger(command.manualOrder, "人工排期顺序"),
    station: definition.station,
    manualReason: cleanText(command.reason, "人工排期理由", FIELD_LIMITS.manualReason),
    statusLabel: cleanText(command.statusLabel, "当前状态", FIELD_LIMITS.statusLabel),
    blocked: command.blocked,
    nextAction: cleanText(command.actionLabel, "唯一下一步", FIELD_LIMITS.nextAction),
    actionContext: cleanText(command.detail, "执行提示", FIELD_LIMITS.actionContext),
    completionCriteria: definition.completion,
    dueOn,
    deadlineReminder: deadlineReminder(dueOn, today),
    assignment: sanitizeAssignment(command.assignment, actionCode)
  };
  return Object.freeze(item);
}

function assignmentText(assignment) {
  if (!assignment) return "";
  const labels = {
    ownerLabel: "负责人",
    materialCode: "素材编号",
    takeNumber: "Take",
    issueTimecode: "问题时间码",
    nextCorrection: "下一条修正"
  };
  const parts = ASSIGNMENT_TEXT_FIELDS.filter((field) => assignment[field]).map((field) => `${labels[field]}：${assignment[field]}`);
  return parts.length ? `\n- 人工登记责任：${parts.join("；")}` : "";
}

function briefText(items, stationCounts, today, hiddenCount) {
  const stationSummary = PRODUCTION_SHIFT_STATIONS.map((station) => `${station} ${stationCounts[station]}`).join("｜");
  const scope = hiddenCount
    ? `范围：当前人工“立即做”前 ${items.length} 项；另有 ${hiddenCount} 个项目未展开，请回到内容排期台查看。`
    : `范围：当前人工“立即做” ${items.length} 项。`;
  const sections = items.map((item) => {
    const lines = [
      `${item.sequence}. ${item.projectName}`,
      `- 流程工位：${item.station}`
    ];
    if (item.testId) lines.push(`- 目标版本：${item.testId}`);
    lines.push(
      `- 人工排期理由：${item.manualReason}`,
      `- 当前状态：${item.statusLabel}${item.blocked ? "（阻塞）" : ""}`,
      `- 唯一下一步：${item.nextAction}`,
      `- 执行提示：${item.actionContext}`,
      `- 完成口径：${item.completionCriteria}`,
      `- 截止提醒：${item.deadlineReminder}${assignmentText(item.assignment)}`
    );
    return lines.join("\n");
  }).join("\n\n");
  return [
    `今日素材生产排产单 · ${today}`,
    "说明：项目顺序来自内容负责人已保存的人工立即做排期；工位仅为流程提示，不代表自动分配具体个人。",
    scope,
    `工位汇总：${stationSummary}`,
    "",
    sections,
    "",
    "边界：本排产单不读取 ROI、消耗或结果数据，也不会改变人工排期顺序。"
  ].join("\n");
}

/**
 * Formats the current manual Top 3 production commands as a local, copy-ready shift brief.
 * It does not rank, assign people, read performance data, or mutate its input.
 */
export function buildProductionShiftBrief(board, { today } = {}) {
  if (!isRecord(board) || !Array.isArray(board.commands)) throw new Error("生产指挥台格式无效");
  if (board.commands.length < 1 || board.commands.length > MAX_COMMANDS) {
    throw new Error(`生产排产单必须包含 1–${MAX_COMMANDS} 条当前生产指令`);
  }
  const safeToday = safeDate(today, "排产日期");
  const hiddenCount = board.hiddenCount === undefined ? 0 : safeInteger(board.hiddenCount, "未展开项目数");
  const seenProjects = new Set();
  let previousItem = null;
  const items = board.commands.map((command, index) => {
    const item = sanitizeCommand(command, index, safeToday);
    if (seenProjects.has(item.projectId)) throw new Error("生产排产单包含重复项目");
    if (previousItem) {
      const order = previousItem.manualOrder - item.manualOrder
        || previousItem.projectId.localeCompare(item.projectId);
      if (order >= 0) throw new Error("生产排产单顺序与当前指挥台的稳定人工顺序不一致");
    }
    seenProjects.add(item.projectId);
    previousItem = item;
    return item;
  });
  const stationCounts = Object.fromEntries(PRODUCTION_SHIFT_STATIONS.map((station) => [
    station,
    items.filter((item) => item.station === station).length
  ]));
  Object.freeze(items);
  Object.freeze(stationCounts);
  return Object.freeze({
    items,
    stationCounts,
    hiddenCount,
    text: briefText(items, stationCounts, safeToday, hiddenCount)
  });
}
