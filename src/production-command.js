import { buildContentPriorityBoard } from "./content-priority.js";
import { buildDirectorTakeReview } from "./director-take-review.js";
import { productionStageCode } from "./production-status.js";
import {
  sanitizeProjectRecord,
  sanitizeVersionRecord
} from "./project-model.js";
import {
  TAKE_REVIEW_OWNER_ROLES,
  deriveTakeReviewFollowUps,
  sanitizeTakeReviewRecord,
  summarizeTakeReviewBatch,
  takeReviewPlanMatchesWorkspace,
  takeReviewVersionMatchesPlan
} from "./take-review-record.js";
import { sanitizedCreativePlan } from "./update.js";

export const PRODUCTION_COMMAND_MAX_VISIBLE = 3;

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

const TAKE_BLOCKER_CODES = new Set(["order_ambiguous", "hold", "reshoot"]);
const ACTIVE_STAGE_ORDER = Object.freeze(["untracked", "planned", "shooting", "editing", "ready", "launched"]);
const PRE_EDIT_STAGES = new Set(["planned", "shooting"]);
const POST_HANDOFF_STAGES = new Set(["editing", "ready", "launched", "paused"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeLimit(value) {
  const parsed = Number(value ?? PRODUCTION_COMMAND_MAX_VISIBLE);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("生产指挥台显示数量必须是正整数");
  return Math.min(parsed, PRODUCTION_COMMAND_MAX_VISIBLE);
}

function planFingerprint(plan) {
  const source = JSON.stringify(sanitizedCreativePlan(plan));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function productionCommandPlanFingerprint(plan) {
  return planFingerprint(plan);
}

function hasMeaningfulTask(workspace) {
  const task = workspace?.creativeTask;
  return isRecord(task) && MEANINGFUL_TASK_FIELDS.some((key) => {
    const value = task[key];
    if (Array.isArray(value)) return value.some((item) => String(item || "").trim());
    return Boolean(String(value || "").trim());
  });
}

function hasUsableAnalysis(workspace) {
  return Array.isArray(workspace?.lastAnalysis?.topCreatives) && workspace.lastAnalysis.topCreatives.length > 0;
}

function workflowRoute(targetView, focusId) {
  return { type: "workflow", targetView, focusId };
}

function experimentRoute(testId, target = "production", filter = "all", focusMetric = "") {
  return { type: "experiment", testId, target, filter, focusMetric };
}

function takeReviewRoute(testId) {
  return { type: "take_review", testId };
}

function command(entry, values) {
  const actionCode = String(values.actionCode || "");
  const testId = String(values.testId || "");
  return {
    id: `${entry.projectId}:${actionCode}:${testId || "project"}`,
    projectId: entry.projectId,
    name: entry.name,
    current: entry.current,
    lane: entry.lane,
    manualOrder: entry.manualOrder,
    reason: entry.reason,
    dueOn: entry.dueOn,
    overdue: entry.overdue,
    actionCode,
    actionLabel: String(values.actionLabel || ""),
    statusLabel: String(values.statusLabel || ""),
    detail: String(values.detail || ""),
    blocked: values.blocked === true,
    testId: testId || null,
    assignment: values.assignment ?? null,
    route: values.route
  };
}

function manualTakeAssignment(followUp) {
  if (followUp.hasManualRecord !== true || (followUp.status !== "hold" && followUp.status !== "reshoot")) return null;
  const ownerRole = String(followUp.ownerRole || "none");
  const ownerLabel = TAKE_REVIEW_OWNER_ROLES.find((role) => role.code === ownerRole)?.label;
  if (!ownerLabel) throw new Error("人工过条记录负责人无效");
  return {
    source: "manual_take_review",
    ownerRole,
    ownerLabel,
    materialCode: String(followUp.materialCode || ""),
    takeNumber: String(followUp.takeNumber || ""),
    issueTimecode: String(followUp.issueTimecode || ""),
    nextCorrection: String(followUp.nextCorrection || "")
  };
}

function errorMessage(value) {
  const source = isRecord(value) && "message" in value ? value.message : value;
  const cleaned = String(source || "项目生产快照读取失败")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (cleaned || "项目生产快照读取失败").slice(0, 240);
}

function projectError(projectErrors, projectId) {
  if (!projectErrors) return null;
  if (projectErrors instanceof Map) return projectErrors.has(projectId) ? errorMessage(projectErrors.get(projectId)) : null;
  if (!isRecord(projectErrors)) throw new Error("生产指挥台项目错误集合格式无效");
  return Object.hasOwn(projectErrors, projectId) ? errorMessage(projectErrors[projectId]) : null;
}

function sanitizeSnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new Error("生产指挥台快照格式无效");
  if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.versions) || !Array.isArray(snapshot.takeReviews)) {
    throw new Error("生产指挥台快照缺少项目、版本或人工过条列表");
  }
  const projects = snapshot.projects.map(sanitizeProjectRecord);
  const projectIds = new Set();
  for (const project of projects) {
    if (projectIds.has(project.id)) throw new Error("生产指挥台包含重复项目编号");
    projectIds.add(project.id);
  }

  const versions = snapshot.versions.map(sanitizeVersionRecord);
  const versionIds = new Set();
  const versionKeys = new Set();
  for (const version of versions) {
    if (!projectIds.has(version.projectId)) throw new Error("生产指挥台版本混入了其他项目");
    if (versionIds.has(version.id) || versionKeys.has(`${version.projectId}\u0000${version.testId}`)) {
      throw new Error("生产指挥台包含重复测试版本");
    }
    versionIds.add(version.id);
    versionKeys.add(`${version.projectId}\u0000${version.testId}`);
  }

  const takeReviews = snapshot.takeReviews.map(sanitizeTakeReviewRecord);
  const takeIds = new Set();
  for (const review of takeReviews) {
    const versionKey = `${review.projectId}\u0000${review.source.testId}`;
    if (!projectIds.has(review.projectId) || !versionKeys.has(versionKey)) {
      throw new Error("生产指挥台人工过条记录混入了其他项目或不存在的版本");
    }
    if (takeIds.has(review.id)) throw new Error("生产指挥台包含重复人工过条记录");
    takeIds.add(review.id);
  }
  return { projects, versions, takeReviews };
}

function projectVersionsMatchPlan(versions, plan) {
  if (!Array.isArray(plan?.items) || !plan.items.length) return false;
  const byTestId = new Map();
  for (const version of versions) {
    if (byTestId.has(version.testId)) return false;
    byTestId.set(version.testId, version);
  }
  return plan.items.every((item) => {
    const version = byTestId.get(String(item?.id || ""));
    return Boolean(version && takeReviewVersionMatchesPlan(version, plan));
  });
}

function stageEntry(versions, stage) {
  return versions.find((version) => productionStageCode(version.productionStatus) === stage) || null;
}

function takeAction(entry, followUp, overrides = {}) {
  const definitions = {
    order_ambiguous: {
      actionCode: "take_order_ambiguous",
      actionLabel: "核对并登记最新结论",
      statusLabel: "过条顺序冲突",
      detail: followUp.prompt
    },
    hold: {
      actionCode: "take_hold",
      actionLabel: "完成现场核实",
      statusLabel: "停机核实",
      detail: followUp.prompt
    },
    reshoot: {
      actionCode: "take_reshoot",
      actionLabel: "按记录完成补拍",
      statusLabel: "待补拍",
      detail: followUp.prompt
    },
    unreviewed: {
      actionCode: "take_unreviewed",
      actionLabel: "拍摄并登记过条",
      statusLabel: "待过条",
      detail: followUp.prompt
    },
    needs_primary: {
      actionCode: "take_needs_primary",
      actionLabel: "指定唯一首选 Take",
      statusLabel: "待指定首选",
      detail: followUp.prompt
    }
  };
  const definition = definitions[followUp.status];
  return command(entry, {
    ...definition,
    ...overrides,
    blocked: true,
    testId: followUp.testId,
    assignment: manualTakeAssignment(followUp),
    route: takeReviewRoute(followUp.testId)
  });
}

function productionAction(entry, versions) {
  const allPaused = versions.length > 0
    && versions.every((version) => productionStageCode(version.productionStatus) === "paused");
  const selectedStage = allPaused
    ? "paused"
    : ACTIVE_STAGE_ORDER.find((stage) => stageEntry(versions, stage)) || "untracked";
  const selected = stageEntry(versions, selectedStage) || versions[0];
  const testId = selected?.testId || "";
  const definitions = {
    ready: {
      actionCode: "production_ready",
      actionLabel: "确认上线状态",
      statusLabel: "待投放",
      detail: `${testId} 已人工标记为待投放；确认实际进度后再手动更新状态。`,
      target: "production"
    },
    editing: {
      actionCode: "production_editing",
      actionLabel: "推进剪辑并更新状态",
      statusLabel: "剪辑中",
      detail: `${testId} 正在剪辑；优先完成可交付版本并如实更新制作状态。`,
      target: "production"
    },
    shooting: {
      actionCode: "production_shooting",
      actionLabel: "继续拍摄并更新状态",
      statusLabel: "拍摄中",
      detail: `${testId} 正在拍摄；完成现场动作后由编导手动更新状态。`,
      target: "production"
    },
    planned: {
      actionCode: "production_planned",
      actionLabel: "开始拍摄",
      statusLabel: "待拍",
      detail: `${testId} 已进入待拍队列；按方案顺序开拍并由编导手动更新状态。`,
      target: "production"
    },
    untracked: {
      actionCode: "production_untracked",
      actionLabel: "标记制作状态",
      statusLabel: "待标状态",
      detail: `${testId} 尚未设置人工制作状态；系统不会根据素材或数据自动推断。`,
      target: "production"
    },
    launched: {
      actionCode: "production_launched",
      actionLabel: "将项目移出今日执行位",
      statusLabel: "已上线",
      detail: `${testId} 已由编导标记为上线，但项目仍在“立即做”；请在内容排期台移至合适泳道或清除排期。生产指挥台不读取平台数据判断结果。`
    },
    paused: {
      actionCode: "production_paused",
      actionLabel: "将项目移入暂停泳道",
      statusLabel: "已搁置",
      detail: `${testId} 已由编导标记为搁置，但项目仍在“立即做”；请在内容排期台移入“暂停”。若实际恢复，先把版本制作状态改为实际阶段。`
    }
  };
  const definition = definitions[selectedStage];
  return command(entry, {
    ...definition,
    blocked: selectedStage === "paused",
    testId,
    route: selectedStage === "paused" || selectedStage === "launched"
      ? { type: "priority" }
      : experimentRoute(testId, definition.target, `production_${selectedStage}`)
  });
}

function buildProjectCommand(entry, project, versions, records, snapshotError) {
  if (snapshotError) {
    return command(entry, {
      actionCode: "snapshot_error",
      actionLabel: "重新读取状态",
      statusLabel: "数据待重载",
      detail: snapshotError,
      blocked: true,
      route: { type: "refresh" }
    });
  }

  const workspace = project.workspace;
  if (!hasMeaningfulTask(workspace)) {
    return command(entry, {
      actionCode: "task_missing",
      actionLabel: "补充创作任务",
      statusLabel: "待补任务",
      detail: "先明确受众、创作目标、核心主张或可用证据，再进入复盘与生产。",
      blocked: true,
      route: workflowRoute("task", "creative-task-form")
    });
  }
  if (!hasUsableAnalysis(workspace)) {
    return command(entry, {
      actionCode: "analysis_missing",
      actionLabel: "完成素材复盘",
      statusLabel: "待复盘",
      detail: "当前项目没有可用于生成下一版任务的本地素材复盘。",
      blocked: true,
      route: workflowRoute("review", "report-file-trigger")
    });
  }

  const plan = workspace.creativePlan;
  if (!Array.isArray(plan?.items) || !plan.items.length) {
    return command(entry, {
      actionCode: "plan_missing",
      actionLabel: "生成下一版任务",
      statusLabel: "待生成方案",
      detail: "复盘已具备，但还没有当前上下文对应的拍摄方案。",
      blocked: true,
      route: workflowRoute("next", "generate-plan")
    });
  }
  if (!takeReviewPlanMatchesWorkspace(plan, workspace)) {
    return command(entry, {
      actionCode: "plan_stale",
      actionLabel: "重新生成方案",
      statusLabel: "方案已失效",
      detail: "创作任务、复盘、测试变量或最低消耗已经变化；旧方案只供对照。",
      blocked: true,
      route: workflowRoute("next", "generate-plan")
    });
  }
  if (plan.items.length < 2 || plan.items.length > 20) {
    return command(entry, {
      actionCode: "plan_batch_invalid",
      actionLabel: "重建拍摄批次",
      statusLabel: "批次结构无效",
      detail: "今日生产批次必须包含 2–20 个可核对版本；请拆分或重新生成方案。",
      blocked: true,
      route: workflowRoute("next", "generate-plan")
    });
  }

  const receipt = workspace.planExportReceipt;
  if (!receipt) {
    return command(entry, {
      actionCode: "plan_delivery_pending",
      actionLabel: "检查并交付方案",
      statusLabel: "方案待交付",
      detail: "当前方案尚未留下本地交付完成凭据。",
      blocked: true,
      route: workflowRoute("next", "copy-run-sheet")
    });
  }
  if (receipt.fingerprint !== planFingerprint(plan)) {
    return command(entry, {
      actionCode: "plan_delivery_stale",
      actionLabel: "重新检查并交付",
      statusLabel: "交付凭据已失效",
      detail: "交付后方案内容又发生变化；请重新检查并生成新的本地完成凭据。",
      blocked: true,
      route: workflowRoute("next", "copy-run-sheet")
    });
  }

  if (!projectVersionsMatchPlan(versions, plan)) {
    return command(entry, {
      actionCode: "versions_unsynced",
      actionLabel: "重新同步当前方案版本",
      statusLabel: "版本未同步",
      detail: "当前方案中的一个或多个测试版本尚未完整同步；点击后只在浏览器本地重新保存方案并同步版本。",
      blocked: true,
      route: { type: "sync_versions" }
    });
  }

  const currentVersions = plan.items.map((item) => versions.find((version) => version.testId === item.id));
  const reviews = plan.items.map((_, itemIndex) => buildDirectorTakeReview(plan, { itemIndex }));
  const summary = summarizeTakeReviewBatch({ plan, versions: currentVersions, records, reviews });
  const followUps = deriveTakeReviewFollowUps(summary);
  const blockingFollowUp = followUps.find((followUp) => TAKE_BLOCKER_CODES.has(followUp.status)) || null;
  if (blockingFollowUp) return takeAction(entry, blockingFollowUp);

  const fieldFollowUp = followUps.find((followUp) => {
    if (followUp.status !== "unreviewed") return false;
    const version = currentVersions.find((candidate) => candidate?.testId === followUp.testId);
    const stage = productionStageCode(version?.productionStatus);
    return PRE_EDIT_STAGES.has(stage);
  }) || null;
  if (fieldFollowUp) {
    const version = currentVersions.find((candidate) => candidate?.testId === fieldFollowUp.testId);
    const stage = productionStageCode(version?.productionStatus);
    return takeAction(entry, fieldFollowUp, stage === "shooting"
      ? { actionLabel: "继续拍摄并登记过条", statusLabel: "拍摄中" }
      : stage === "planned"
        ? { actionLabel: "开始拍摄并登记过条", statusLabel: "待拍" }
        : {});
  }

  const primaryFollowUp = followUps.find((followUp) => followUp.status === "needs_primary") || null;
  if (primaryFollowUp) return takeAction(entry, primaryFollowUp);

  const hasPostHandoffStage = currentVersions.some((version) => POST_HANDOFF_STAGES.has(productionStageCode(version.productionStatus)));
  if (summary.ready && !hasPostHandoffStage) {
    const testId = summary.entries[0]?.testId || currentVersions[0]?.testId || "";
    return command(entry, {
      actionCode: "take_ready",
      actionLabel: "完成收工接片",
      statusLabel: "待接片",
      detail: `当前批次 ${summary.batchId} 的所有版本均已由编导指定唯一首选 Take。`,
      blocked: false,
      testId,
      route: takeReviewRoute(testId)
    });
  }

  return productionAction(entry, currentVersions);
}

/**
 * Builds a local-only cross-project command board from one coherent snapshot.
 * Project order comes exclusively from the manually maintained "立即做" lane.
 */
export function buildProductionCommandBoard(snapshot, { today, limit = PRODUCTION_COMMAND_MAX_VISIBLE, currentProjectId } = {}) {
  const visibleLimit = safeLimit(limit);
  const safe = sanitizeSnapshot(snapshot);
  const selectedProjectId = currentProjectId ?? snapshot.currentProjectId ?? "";
  const priorityBoard = buildContentPriorityBoard(safe.projects, { currentProjectId: selectedProjectId, today });
  const nowItems = priorityBoard.lanes.find((lane) => lane.code === "now")?.items || [];
  const activeNow = nowItems.filter((entry) => entry.status === "current");
  const visibleEntries = priorityBoard.topNow.slice(0, visibleLimit);
  const projectMap = new Map(safe.projects.map((project) => [project.id, project]));
  const commands = visibleEntries.map((entry) => {
    const project = projectMap.get(entry.projectId);
    const versions = safe.versions.filter((version) => version.projectId === entry.projectId);
    const records = safe.takeReviews.filter((review) => review.projectId === entry.projectId);
    try {
      return buildProjectCommand(entry, project, versions, records, projectError(snapshot.projectErrors, entry.projectId));
    } catch (error) {
      return buildProjectCommand(entry, project, [], [], errorMessage(error));
    }
  });
  const hiddenCount = Math.max(0, activeNow.length - commands.length);
  const laneCount = (code) => priorityBoard.lanes.find((lane) => lane.code === code)?.items.length || 0;
  const counts = {
    now: laneCount("now"),
    week: laneCount("week"),
    backlog: laneCount("backlog"),
    paused: laneCount("paused"),
    stale: priorityBoard.staleCount,
    unplanned: priorityBoard.unplannedCount
  };
  const blockedCount = commands.filter((entry) => entry.blocked).length;
  return {
    commands,
    total: activeNow.length,
    hiddenCount,
    blockedCount,
    counts,
    staleCount: counts.stale,
    unplannedCount: counts.unplanned,
    summary: `立即做 ${activeNow.length} 个，显示 ${commands.length} 个，显示项中需处理阻塞 ${blockedCount} 个${hiddenCount ? `，另有 ${hiddenCount} 个按人工顺序隐藏` : ""}；本周 ${counts.week} 个，候选 ${counts.backlog} 个，暂停 ${counts.paused} 个，待重审 ${counts.stale} 个，待排期 ${counts.unplanned} 个。`
  };
}
