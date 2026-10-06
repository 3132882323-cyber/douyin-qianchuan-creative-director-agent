import { normalizeCreativeTask } from "./core.js";

export const CONTENT_PRIORITY_LANES = Object.freeze({
  now: "立即做",
  week: "本周",
  backlog: "候选",
  paused: "暂停"
});

const PRIORITY_METHOD = "manual";
const PRIORITY_FIELDS = Object.freeze([
  "method",
  "lane",
  "reason",
  "dueOn",
  "manualOrder",
  "contextFingerprint",
  "updatedAt"
]);
const CONTEXT_FIELDS = Object.freeze(["subject", "targetAudience", "creativeGoal", "coreClaim"]);
const MEANINGFUL_TASK_FIELDS = Object.freeze([
  "subject",
  "targetAudience",
  "creativeGoal",
  "audienceProblems",
  "coreClaim",
  "evidence",
  "shootingConstraints",
  "riskNotes"
]);
const PROJECT_ID_PATTERN = /^prj_[a-z0-9-]{8,64}$/iu;
const FINGERPRINT_PATTERN = /^content-priority-context:[0-9a-f]{8}$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CONTROL_GLOBAL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const MAX_PROJECTS = 20;
const MAX_REASON_LENGTH = 200;
const MAX_MANUAL_ORDER = 1_000_000;

const PHASES = Object.freeze({
  no_task: Object.freeze({ phaseLabel: "无任务", nextLabel: "补充创作任务" }),
  review_pending: Object.freeze({ phaseLabel: "待复盘", nextLabel: "完成素材复盘" }),
  reviewed: Object.freeze({ phaseLabel: "已复盘", nextLabel: "生成下一版任务" }),
  plan_pending: Object.freeze({ phaseLabel: "方案待交付", nextLabel: "检查并交付方案" }),
  delivered: Object.freeze({ phaseLabel: "策划已交付", nextLabel: "进入批次拍摄" })
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}包含未知字段：${key}`);
  }
}

function safeProjectId(value) {
  const id = String(value || "").trim();
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error("内容排期项目编号格式无效");
  return id;
}

function safeProjectName(value) {
  const name = String(value || "").replace(CONTROL_GLOBAL_PATTERN, " ").replace(/\s+/gu, " ").trim();
  if (!name || name.length > 60) throw new Error("内容排期项目名称无效");
  return name;
}

function safeIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) {
    throw new Error(`${label}时间格式无效`);
  }
  return candidate;
}

function safeDate(value, { nullable = true, label = "内容排期截止日期" } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const candidate = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) throw new Error(`${label}格式必须为 YYYY-MM-DD`);
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new Error(`${label}不是有效日期`);
  }
  return candidate;
}

function safeReason(value) {
  const reason = String(value || "").replace(/\r\n?/gu, "\n").trim();
  if (reason.length < 4) throw new Error("内容排期理由至少填写 4 个字符");
  if (reason.length > MAX_REASON_LENGTH) throw new Error(`内容排期理由不能超过 ${MAX_REASON_LENGTH} 个字符`);
  if (CONTROL_PATTERN.test(reason)) throw new Error("内容排期理由包含无效控制字符");
  return reason;
}

function safeManualOrder(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MANUAL_ORDER) {
    throw new Error(`内容排期顺序必须是 0–${MAX_MANUAL_ORDER} 的整数`);
  }
  return value;
}

function normalizedProjectTask(project) {
  if (!isRecord(project) || !isRecord(project.workspace)) throw new Error("内容排期项目格式无效");
  return normalizeCreativeTask(isRecord(project.workspace.creativeTask) ? project.workspace.creativeTask : {});
}

function stableFingerprint(value) {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `content-priority-context:${hash.toString(16).padStart(8, "0")}`;
}

function compact(value, limit) {
  const text = String(value || "").replace(CONTROL_GLOBAL_PATTERN, " ").replace(/\s+/gu, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function contextSummary(task) {
  const subject = compact(task.subject, 36) || "未填写主题";
  const audience = compact(task.targetAudience, 42) || "未填写受众";
  const goal = compact(task.creativeGoal || task.coreClaim, 54) || "未填写创作目标";
  return `${subject} · ${audience} · ${goal}`;
}

function projectPhase(project, task) {
  const hasTask = MEANINGFUL_TASK_FIELDS.some((key) => String(task[key] || "").trim());
  if (!hasTask) return PHASES.no_task;
  if (!project.workspace.lastAnalysis) return PHASES.review_pending;
  if (!Array.isArray(project.workspace.creativePlan?.items) || !project.workspace.creativePlan.items.length) return PHASES.reviewed;
  if (!project.workspace.planExportReceipt) return PHASES.plan_pending;
  return PHASES.delivered;
}

function safeProjectSnapshot(project) {
  if (!isRecord(project)) throw new Error("内容排期项目格式无效");
  const projectId = safeProjectId(project.id);
  const name = safeProjectName(project.name);
  const task = normalizedProjectTask(project);
  const priority = sanitizeContentPriority(project.contentPriority, { allowNull: true });
  return {
    projectId,
    name,
    archived: project.archived === true,
    workspace: project.workspace,
    task,
    priority
  };
}

export function contentPriorityContextFingerprint(project) {
  const task = normalizedProjectTask(project);
  return stableFingerprint(Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, task[key]])));
}

export function sanitizeContentPriority(value, { allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error("内容排期不能为空");
  }
  if (!isRecord(value)) throw new Error("内容排期格式无效");
  exactKeys(value, PRIORITY_FIELDS, "内容排期");
  if (value.method !== PRIORITY_METHOD) throw new Error("内容排期必须由人工设置");
  const lane = String(value.lane || "");
  if (!Object.hasOwn(CONTENT_PRIORITY_LANES, lane)) throw new Error("内容排期泳道无效");
  const contextFingerprint = String(value.contextFingerprint || "");
  if (!FINGERPRINT_PATTERN.test(contextFingerprint)) throw new Error("内容排期上下文指纹无效");
  return {
    method: PRIORITY_METHOD,
    lane,
    reason: safeReason(value.reason),
    dueOn: safeDate(value.dueOn),
    manualOrder: safeManualOrder(value.manualOrder),
    contextFingerprint,
    updatedAt: safeIso(value.updatedAt, "内容排期更新")
  };
}

export function createContentPriority({ project, lane, reason, dueOn = null, manualOrder, now } = {}) {
  return sanitizeContentPriority({
    method: PRIORITY_METHOD,
    lane,
    reason,
    dueOn,
    manualOrder,
    contextFingerprint: contentPriorityContextFingerprint(project),
    updatedAt: safeIso(now, "内容排期更新")
  }, { allowNull: false });
}

export function assessContentPriority(project) {
  if (!isRecord(project)) throw new Error("内容排期项目格式无效");
  const priority = sanitizeContentPriority(project.contentPriority, { allowNull: true });
  if (!priority) return { code: "unplanned", label: "待排期", stale: false, priority: null };
  const currentFingerprint = contentPriorityContextFingerprint(project);
  const stale = priority.contextFingerprint !== currentFingerprint;
  return {
    code: stale ? "stale" : "current",
    label: stale ? "排期需重审" : "排期有效",
    stale,
    priority,
    currentFingerprint
  };
}

export function buildContentPriorityBoard(projects, { currentProjectId = "", today } = {}) {
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) throw new Error(`内容排期项目必须是不超过 ${MAX_PROJECTS} 项的数组`);
  const safeToday = safeDate(today, { nullable: false, label: "内容排期今日日期" });
  const selectedProjectId = currentProjectId ? safeProjectId(currentProjectId) : "";
  const snapshots = projects.map(safeProjectSnapshot).filter((project) => !project.archived);
  const ids = new Set();
  for (const project of snapshots) {
    if (ids.has(project.projectId)) throw new Error("内容排期包含重复项目编号");
    ids.add(project.projectId);
  }
  if (selectedProjectId && !ids.has(selectedProjectId)) throw new Error("当前项目不在内容排期项目中");

  const entries = snapshots.map((project) => {
    const assessment = assessContentPriority({
      id: project.projectId,
      name: project.name,
      archived: false,
      workspace: project.workspace,
      contentPriority: project.priority
    });
    const phase = projectPhase(project, project.task);
    const priority = assessment.priority;
    return {
      projectId: project.projectId,
      name: project.name,
      lane: priority?.lane ?? null,
      reason: priority?.reason ?? "",
      dueOn: priority?.dueOn ?? null,
      manualOrder: priority?.manualOrder ?? null,
      status: assessment.code,
      current: project.projectId === selectedProjectId,
      overdue: Boolean(priority?.dueOn && priority.dueOn < safeToday),
      phaseLabel: phase.phaseLabel,
      nextLabel: phase.nextLabel,
      contextSummary: contextSummary(project.task)
    };
  });

  const stableManualSort = (left, right) => left.manualOrder - right.manualOrder || left.projectId.localeCompare(right.projectId);
  const lanes = Object.entries(CONTENT_PRIORITY_LANES).map(([code, label]) => ({
    code,
    label,
    items: entries.filter((entry) => entry.lane === code).sort(stableManualSort)
  }));
  const unplanned = entries.filter((entry) => entry.status === "unplanned").sort((left, right) => left.projectId.localeCompare(right.projectId));
  const orderedEntries = [...lanes.flatMap((lane) => lane.items), ...unplanned];
  const nowLane = lanes.find((lane) => lane.code === "now");
  return {
    entries: orderedEntries,
    lanes,
    topNow: nowLane.items.filter((entry) => entry.status === "current").slice(0, 3),
    total: orderedEntries.length,
    currentCount: orderedEntries.filter((entry) => entry.status === "current").length,
    staleCount: orderedEntries.filter((entry) => entry.status === "stale").length,
    unplannedCount: unplanned.length
  };
}
