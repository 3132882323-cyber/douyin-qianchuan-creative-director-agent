import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeReport,
  generateCreativePlan,
  parseCsv
} from "../src/core.js";
import { createContentPriority } from "../src/content-priority.js";
import { buildDirectorTakeReview } from "../src/director-take-review.js";
import {
  createProjectRecord,
  versionRecordsFromPlan
} from "../src/project-model.js";
import {
  buildProductionCommandBoard,
  productionCommandPlanFingerprint
} from "../src/production-command.js";
import { buildProductionShiftBrief } from "../src/production-shift-brief.js";
import { createProductionStatus } from "../src/production-status.js";
import {
  TAKE_REVIEW_CHECKS,
  createTakeReviewRecord
} from "../src/take-review-record.js";

const NOW = "2026-09-02T08:00:00.000Z";
const TODAY = "2026-09-02";
const TASK = Object.freeze({
  subject: "通勤证据素材",
  targetAudience: "每天乘地铁通勤的人",
  creativeGoal: "让受众理解完整使用过程",
  audienceProblems: ["担心展示只截取局部"],
  coreClaim: "完整过程可以连续核验",
  evidence: "固定机位连续实拍",
  shootingConstraints: "同一机位、光线与演员",
  riskNotes: "不作无法核验的效果承诺",
  duration: 30
});

const REPORT = `素材名称,消耗,展示量,点击量,成交订单,成交金额,ROI,人群,钩子,卖点,场景
历史素材A,800,10000,800,80,1600,2,通勤人群,先看完整过程,过程可核验,地铁口`;

function analysis() {
  return analyzeReport(parseCsv(REPORT), 1.5);
}

function planFor(task = TASK, sourceAnalysis = analysis()) {
  return generateCreativePlan(task, sourceAnalysis, { testVariable: "hook", minSpend: 300 });
}

function workspace({ task = TASK, sourceAnalysis = null, plan = null, receipt = null, targetRoi = 1.5 } = {}) {
  return {
    creativeTask: structuredClone(task),
    targetRoi,
    lastAnalysis: sourceAnalysis,
    creativePlan: plan,
    planExportReceipt: receipt
  };
}

function scheduledProject(id, {
  name = id,
  lane = "now",
  manualOrder = 0,
  dueOn = null,
  reason = "今天按人工排期推进这个内容项目",
  projectWorkspace = workspace(),
  updatedAt = NOW
} = {}) {
  const project = createProjectRecord({ id, name, workspace: projectWorkspace, now: updatedAt });
  project.contentPriority = createContentPriority({ project, lane, reason, dueOn, manualOrder, now: NOW });
  return project;
}

function deliveredProject(id, options = {}) {
  const sourceAnalysis = options.sourceAnalysis || analysis();
  const plan = options.plan || planFor(options.task || TASK, sourceAnalysis);
  const receipt = options.receipt === undefined
    ? { fingerprint: productionCommandPlanFingerprint(plan), completedAt: NOW }
    : options.receipt;
  const project = scheduledProject(id, {
    ...options,
    projectWorkspace: workspace({
      task: options.task || TASK,
      sourceAnalysis,
      plan,
      receipt,
      targetRoi: options.targetRoi ?? 1.5
    })
  });
  return { project, plan };
}

function versionsFor(project, plan, stage = null) {
  return versionRecordsFromPlan({ projectId: project.id, plan, existingVersions: [], now: NOW })
    .map((version) => ({
      ...version,
      productionStatus: stage ? createProductionStatus(stage, NOW) : null
    }));
}

function snapshot(projects, versions = [], takeReviews = [], projectErrors) {
  return {
    currentProjectId: projects[0]?.id || "",
    projects,
    versions,
    takeReviews,
    ...(projectErrors ? { projectErrors } : {})
  };
}

function commandFor(source, options = {}) {
  return buildProductionCommandBoard(source, { today: TODAY, ...options }).commands[0];
}

function passingChecks() {
  return TAKE_REVIEW_CHECKS.map(({ code }) => ({ code, status: "pass" }));
}

let takeSequence = 0;

function takeRecord({
  project,
  plan,
  version,
  existing = [],
  outcome = "keep",
  handoffRole = "none",
  ambiguous = false,
  ownerRole,
  materialCode,
  takeNumber,
  issueTimecode,
  nextCorrection
} = {}) {
  takeSequence += 1;
  const checks = passingChecks();
  if (outcome === "reshoot") checks[2] = { ...checks[2], status: "issue" };
  const itemIndex = plan.items.findIndex((item) => item.id === version.testId);
  const record = createTakeReviewRecord({
    projectId: project.id,
    version,
    plan,
    review: buildDirectorTakeReview(plan, { itemIndex }),
    draft: {
      expectedRevision: 0,
      materialCode: materialCode || `CAM-${takeSequence}`,
      takeNumber: takeNumber || `Take ${takeSequence}`,
      checks,
      outcome,
      handoffRole,
      issueTimecode: issueTimecode ?? (outcome === "reshoot" ? "00:02.4" : ""),
      nextCorrection: nextCorrection ?? (outcome === "reshoot" ? "补拍连续证据" : outcome === "hold" ? "核对现场授权" : ""),
      ownerRole: ownerRole || (outcome === "reshoot" || outcome === "hold" ? "director" : "none")
    },
    existing,
    now: NOW,
    randomUUID: () => `${String(takeSequence).padStart(8, "0")}-1234-1234-1234-123456789abc`
  });
  if (ambiguous) delete record.createdOrder;
  return record;
}

test("uses only current manual-now order, caps visible commands at three and counts every excluded lane", () => {
  const noTask = scheduledProject("prj_90000009", {
    name: "动作最严重但人工排最后",
    manualOrder: 9,
    dueOn: "2026-09-01",
    projectWorkspace: workspace({ task: {} }),
    targetRoi: 999
  });
  const first = deliveredProject("prj_10000001", { name: "Z 名称", manualOrder: 1, dueOn: "2026-12-31", targetRoi: 99 });
  const tie = deliveredProject("prj_10000002", { name: "A 名称", manualOrder: 1, dueOn: "2026-08-01", targetRoi: 0.1 });
  const fourth = deliveredProject("prj_40000004", { name: "人工第四", manualOrder: 4 });
  const stale = scheduledProject("prj_50000005", { manualOrder: 0 });
  stale.workspace.creativeTask.coreClaim = "排期后换了新的内容主张";
  const week = scheduledProject("prj_60000006", { lane: "week" });
  const backlog = scheduledProject("prj_70000007", { lane: "backlog" });
  const paused = scheduledProject("prj_80000008", { lane: "paused" });
  const unplanned = createProjectRecord({ id: "prj_a000000a", name: "待排期", workspace: workspace(), now: NOW });
  const projects = [noTask, paused, fourth.project, stale, tie.project, unplanned, first.project, week, backlog].reverse();
  const versions = [
    ...versionsFor(first.project, first.plan),
    ...versionsFor(tie.project, tie.plan),
    ...versionsFor(fourth.project, fourth.plan)
  ];
  const before = structuredClone({ projects, versions });
  const board = buildProductionCommandBoard(snapshot(projects, versions), { today: TODAY, limit: 99, currentProjectId: first.project.id });

  assert.deepEqual(board.commands.map((entry) => entry.projectId), [first.project.id, tie.project.id, fourth.project.id]);
  assert.equal(board.commands[0].current, true);
  assert.equal(board.total, 4);
  assert.equal(board.hiddenCount, 1);
  assert.deepEqual(board.counts, { now: 5, week: 1, backlog: 1, paused: 1, stale: 1, unplanned: 1 });
  assert.match(board.summary, /人工顺序/u);
  assert.deepEqual({ projects, versions }, before);
});

test("returns exactly one reliable prerequisite action for every workflow state", () => {
  const sourceAnalysis = analysis();
  const plan = planFor(TASK, sourceAnalysis);
  const receipt = { fingerprint: productionCommandPlanFingerprint(plan), completedAt: NOW };
  const cases = [
    {
      label: "no task",
      code: "task_missing",
      project: scheduledProject("prj_b0000001", { projectWorkspace: workspace({ task: {} }) }),
      versions: []
    },
    {
      label: "no review",
      code: "analysis_missing",
      project: scheduledProject("prj_b0000002", { projectWorkspace: workspace({ task: TASK }) }),
      versions: []
    },
    {
      label: "no plan",
      code: "plan_missing",
      project: scheduledProject("prj_b0000003", { projectWorkspace: workspace({ task: TASK, sourceAnalysis }) }),
      versions: []
    },
    {
      label: "stale plan",
      code: "plan_stale",
      project: (() => {
        const project = scheduledProject("prj_b0000004", { projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan, receipt }) });
        project.workspace.creativeTask.evidence = "方案生成后替换了证据条件";
        return project;
      })(),
      versions: []
    },
    {
      label: "missing receipt",
      code: "plan_delivery_pending",
      project: scheduledProject("prj_b0000005", { projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan }) }),
      versions: []
    },
    {
      label: "mismatched receipt",
      code: "plan_delivery_stale",
      project: scheduledProject("prj_b0000006", { projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan, receipt: { fingerprint: "deadbeef", completedAt: NOW } }) }),
      versions: []
    },
    {
      label: "invalid one-item batch",
      code: "plan_batch_invalid",
      project: (() => {
        const oneItemPlan = { ...plan, items: plan.items.slice(0, 1) };
        return scheduledProject("prj_b0000008", {
          projectWorkspace: workspace({
            task: TASK,
            sourceAnalysis,
            plan: oneItemPlan,
            receipt: { fingerprint: productionCommandPlanFingerprint(oneItemPlan), completedAt: NOW }
          })
        });
      })(),
      versions: []
    },
    {
      label: "versions not synced",
      code: "versions_unsynced",
      routeType: "sync_versions",
      project: scheduledProject("prj_b0000009", { projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan, receipt }) }),
      versions: []
    }
  ];

  for (const candidate of cases) {
    const board = buildProductionCommandBoard(snapshot([candidate.project], candidate.versions), { today: TODAY });
    assert.equal(board.commands.length, 1, candidate.label);
    assert.equal(board.commands[0].actionCode, candidate.code, candidate.label);
    assert.equal(board.commands[0].blocked, true, candidate.label);
    assert.equal(board.commands[0].assignment, null, candidate.label);
    assert.match(board.commands[0].id, new RegExp(`^${candidate.project.id}:${candidate.code}:`, "u"), candidate.label);
    assert.equal(board.commands[0].route.type, candidate.routeType || "workflow", candidate.label);
    if (candidate.code === "versions_unsynced") assert.equal(board.commands[0].actionLabel, "重新同步当前方案版本");
  }
});

test("keeps the production command Take priority identical to the field follow-up order", () => {
  const { project, plan } = deliveredProject("prj_c9000001");
  const versions = versionsFor(project, plan, "shooting");
  const records = [takeRecord({ project, plan, version: versions[0] })];
  const action = commandFor(snapshot([project], versions, records));

  assert.equal(action.actionCode, "take_unreviewed");
  assert.equal(action.testId, versions[1].testId);
  assert.equal(action.actionLabel, "继续拍摄并登记过条");

  const plannedFirst = versions.map((version, index) => ({
    ...version,
    productionStatus: createProductionStatus(index === 0 ? "planned" : "shooting", NOW)
  }));
  const plannedAction = commandFor(snapshot([project], plannedFirst, []));
  assert.equal(plannedAction.testId, plannedFirst[0].testId);
  assert.equal(plannedAction.actionLabel, "开始拍摄并登记过条");

  const pausedFirst = versions.map((version, index) => ({
    ...version,
    productionStatus: createProductionStatus(index === 0 ? "paused" : "shooting", NOW)
  }));
  const pausedAction = commandFor(snapshot([project], pausedFirst, []));
  assert.equal(pausedAction.actionCode, "take_unreviewed");
  assert.equal(pausedAction.testId, pausedFirst[1].testId);
  assert.equal(pausedAction.actionLabel, "继续拍摄并登记过条");
});

test("derives order conflicts, hold, reshoot, unreviewed, primary selection and handoff only from saved manual Take records", () => {
  const cases = [
    { label: "unreviewed", expected: "take_unreviewed", stage: "shooting", records: () => [] },
    {
      label: "hold",
      expected: "take_hold",
      stage: "shooting",
      assignment: {
        source: "manual_take_review",
        ownerRole: "compliance",
        ownerLabel: "事实与授权核实",
        materialCode: "HOLD-A",
        takeNumber: "Take H1",
        issueTimecode: "00:04.0",
        nextCorrection: "核对现场授权"
      },
      records: ({ project, plan, versions }) => [takeRecord({
        project,
        plan,
        version: versions[0],
        outcome: "hold",
        ownerRole: "compliance",
        materialCode: "HOLD-A",
        takeNumber: "Take H1",
        issueTimecode: "00:04.0",
        nextCorrection: "核对现场授权"
      })]
    },
    {
      label: "reshoot",
      expected: "take_reshoot",
      stage: "shooting",
      assignment: {
        source: "manual_take_review",
        ownerRole: "camera",
        ownerLabel: "摄影",
        materialCode: "RESHOOT-B",
        takeNumber: "Take R2",
        issueTimecode: "00:02.4",
        nextCorrection: "补拍连续证据"
      },
      records: ({ project, plan, versions }) => [takeRecord({
        project,
        plan,
        version: versions[0],
        outcome: "reshoot",
        ownerRole: "camera",
        materialCode: "RESHOOT-B",
        takeNumber: "Take R2"
      })]
    },
    {
      label: "needs primary",
      expected: "take_needs_primary",
      stage: "shooting",
      records: ({ project, plan, versions }) => {
        const records = [];
        versions.forEach((version, index) => records.push(takeRecord({
          project,
          plan,
          version,
          existing: records,
          handoffRole: index === 0 ? "none" : "primary"
        })));
        return records;
      }
    },
    {
      label: "ambiguous order",
      expected: "take_order_ambiguous",
      stage: "shooting",
      records: ({ project, plan, versions }) => {
        const first = takeRecord({ project, plan, version: versions[0], outcome: "hold", ownerRole: "producer", ambiguous: true });
        const second = takeRecord({ project, plan, version: versions[0], existing: [first], outcome: "hold", ownerRole: "producer", ambiguous: true });
        return [first, second];
      }
    },
    {
      label: "ready handoff",
      expected: "take_ready",
      stage: "shooting",
      records: ({ project, plan, versions }) => {
        const records = [];
        for (const version of versions) records.push(takeRecord({ project, plan, version, existing: records, handoffRole: "primary" }));
        return records;
      }
    }
  ];

  cases.forEach((candidate, index) => {
    const { project, plan } = deliveredProject(`prj_c000000${index + 1}`);
    const versions = versionsFor(project, plan, candidate.stage);
    const records = candidate.records({ project, plan, versions });
    const action = commandFor(snapshot([project], versions, records));
    assert.equal(action.actionCode, candidate.expected, candidate.label);
    assert.equal(action.route.type, "take_review", candidate.label);
    assert.equal(action.testId, action.route.testId, candidate.label);
    assert.deepEqual(action.assignment, candidate.assignment || null, candidate.label);
    if (candidate.label === "unreviewed") {
      assert.equal(action.statusLabel, "拍摄中");
      assert.equal(action.actionLabel, "继续拍摄并登记过条");
    }
  });
});

test("keeps an unresolved manual Take blocker ahead of administrative project pausing", () => {
  const { project, plan } = deliveredProject("prj_c9000002");
  const versions = versionsFor(project, plan, "paused");
  const hold = takeRecord({
    project,
    plan,
    version: versions[0],
    outcome: "hold",
    ownerRole: "compliance",
    materialCode: "HOLD-PAUSED",
    takeNumber: "Take P1",
    nextCorrection: "先核对现场授权记录"
  });
  const action = commandFor(snapshot([project], versions, [hold]));

  assert.equal(action.actionCode, "take_hold");
  assert.equal(action.testId, versions[0].testId);
  assert.equal(action.actionLabel, "完成现场核实");
});

test("does not infer an untracked version is ready for field review from another version's Take", () => {
  const { project, plan } = deliveredProject("prj_c9000003");
  const versions = versionsFor(project, plan, null);
  versions[0].productionStatus = createProductionStatus("shooting", NOW);
  const firstPrimary = takeRecord({
    project,
    plan,
    version: versions[0],
    handoffRole: "primary"
  });
  const action = commandFor(snapshot([project], versions, [firstPrimary]));

  assert.equal(action.actionCode, "production_untracked");
  assert.equal(action.testId, versions[1].testId);
  assert.equal(action.actionLabel, "标记制作状态");
});

test("keeps manual project order while exposing only explicit hold and reshoot ownership", () => {
  const hold = deliveredProject("prj_c1000001", { manualOrder: 2 });
  const reshoot = deliveredProject("prj_c1000002", { manualOrder: 0 });
  const unreviewed = deliveredProject("prj_c1000003", { manualOrder: 1 });
  const holdVersions = versionsFor(hold.project, hold.plan, "shooting");
  const reshootVersions = versionsFor(reshoot.project, reshoot.plan, "shooting");
  const unreviewedVersions = versionsFor(unreviewed.project, unreviewed.plan, "shooting");
  const records = [
    takeRecord({ project: hold.project, plan: hold.plan, version: holdVersions[0], outcome: "hold", ownerRole: "producer" }),
    takeRecord({ project: reshoot.project, plan: reshoot.plan, version: reshootVersions[0], outcome: "reshoot", ownerRole: "camera" })
  ];
  const board = buildProductionCommandBoard(snapshot(
    [hold.project, unreviewed.project, reshoot.project],
    [...holdVersions, ...unreviewedVersions, ...reshootVersions],
    records
  ), { today: TODAY });

  assert.deepEqual(board.commands.map((entry) => entry.projectId), [reshoot.project.id, unreviewed.project.id, hold.project.id]);
  assert.deepEqual(board.commands.map((entry) => entry.assignment?.ownerRole || null), ["camera", null, "producer"]);
  const brief = buildProductionShiftBrief(board, { today: TODAY });
  assert.deepEqual(brief.items.map((entry) => entry.projectId), board.commands.map((entry) => entry.projectId));
  assert.match(brief.text, /负责人：摄影/u);
  assert.match(brief.text, /负责人：制片 \/ 场务/u);
  assert.doesNotMatch(brief.text, /负责人：暂不指定/u);
});

test("detects a locally stored version whose content no longer matches the current plan", () => {
  const { project, plan } = deliveredProject("prj_c0000009");
  const versions = versionsFor(project, plan, "shooting");
  versions[0].planItem = { ...versions[0].planItem, hook: "被意外改写的钩子" };
  const action = commandFor(snapshot([project], versions));
  assert.equal(action.actionCode, "versions_unsynced");
  assert.equal(action.blocked, true);
});

test("falls back to deterministic human production stages when no relevant Take work exists", () => {
  const cases = [
    ["ready", "production_ready"],
    ["editing", "production_editing"],
    ["untracked", "production_untracked"],
    ["launched", "production_launched"],
    ["paused", "production_paused"]
  ];
  cases.forEach(([stage, expected], index) => {
    const { project, plan } = deliveredProject(`prj_d000000${index + 1}`);
    const versions = versionsFor(project, plan, stage === "untracked" ? null : stage);
    const action = commandFor(snapshot([project], versions));
    assert.equal(action.actionCode, expected, stage);
    assert.equal(action.assignment, null, stage);
    assert.equal(action.route.type, stage === "paused" || stage === "launched" ? "priority" : "experiment", stage);
    if (stage !== "paused" && stage !== "launched") assert.equal(action.route.filter, `production_${stage}`, stage);
  });

  const mixed = deliveredProject("prj_d0000009");
  const versions = versionsFor(mixed.project, mixed.plan, "editing");
  versions[versions.length - 1].productionStatus = createProductionStatus("ready", NOW);
  assert.equal(commandFor(snapshot([mixed.project], versions)).actionCode, "production_editing");

  const paused = deliveredProject("prj_d000000a");
  const pausedVersions = versionsFor(paused.project, paused.plan, "ready");
  pausedVersions[pausedVersions.length - 1].productionStatus = createProductionStatus("paused", NOW);
  assert.equal(commandFor(snapshot([paused.project], pausedVersions)).actionCode, "production_ready");

  const fullyPausedVersions = versionsFor(paused.project, paused.plan, "paused");
  const fullyPausedAction = commandFor(snapshot([paused.project], fullyPausedVersions));
  assert.equal(fullyPausedAction.actionCode, "production_paused");
  assert.equal(fullyPausedAction.actionLabel, "将项目移入暂停泳道");
  assert.deepEqual(fullyPausedAction.route, { type: "priority" });

  const terminal = deliveredProject("prj_d000000c");
  const editingWithLaunched = versionsFor(terminal.project, terminal.plan, "editing");
  editingWithLaunched[editingWithLaunched.length - 1].productionStatus = createProductionStatus("launched", NOW);
  assert.equal(commandFor(snapshot([terminal.project], editingWithLaunched)).actionCode, "production_editing");

  const launchedWithPaused = versionsFor(terminal.project, terminal.plan, "launched");
  launchedWithPaused[launchedWithPaused.length - 1].productionStatus = createProductionStatus("paused", NOW);
  const terminalAction = commandFor(snapshot([terminal.project], launchedWithPaused));
  assert.equal(terminalAction.actionCode, "production_launched");
  assert.equal(terminalAction.actionLabel, "将项目移出今日执行位");
  assert.deepEqual(terminalAction.route, { type: "priority" });
});

test("moves beyond handoff after the director explicitly advances production", () => {
  const { project, plan } = deliveredProject("prj_d000000b");
  const shootingVersions = versionsFor(project, plan, "shooting");
  const records = [];
  for (const version of shootingVersions) records.push(takeRecord({ project, plan, version, existing: records, handoffRole: "primary" }));
  assert.equal(commandFor(snapshot([project], shootingVersions, records)).actionCode, "take_ready");

  const editingVersions = shootingVersions.map((version) => ({ ...version, productionStatus: createProductionStatus("editing", NOW) }));
  assert.equal(commandFor(snapshot([project], editingVersions, records)).actionCode, "production_editing");
});

test("contains one project snapshot failure without hiding commands for the other manually ordered projects", () => {
  const failed = deliveredProject("prj_e0000001", { manualOrder: 0 });
  const healthy = deliveredProject("prj_e0000002", { manualOrder: 1 });
  const versions = versionsFor(healthy.project, healthy.plan, "ready");
  const board = buildProductionCommandBoard(snapshot(
    [healthy.project, failed.project],
    versions,
    [],
    { [failed.project.id]: new Error("IndexedDB 事务被中断") }
  ), { today: TODAY });

  assert.deepEqual(board.commands.map((entry) => entry.actionCode), ["snapshot_error", "production_ready"]);
  assert.equal(board.commands[0].blocked, true);
  assert.equal(board.commands[0].assignment, null);
  assert.match(board.commands[0].detail, /IndexedDB/u);
  assert.equal(board.commands[0].actionLabel, "重新读取状态");
  assert.deepEqual(board.commands[0].route, { type: "refresh" });
  assert.equal(board.commands[1].blocked, false);
  assert.equal(board.commands[1].assignment, null);
});

test("keeps same-id plan batches isolated by project and never lets one project's Take records close another project", () => {
  const sourceAnalysis = analysis();
  const sharedPlan = planFor(TASK, sourceAnalysis);
  const receipt = { fingerprint: productionCommandPlanFingerprint(sharedPlan), completedAt: NOW };
  const first = scheduledProject("prj_f0000001", {
    manualOrder: 0,
    projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan: sharedPlan, receipt })
  });
  const second = scheduledProject("prj_f0000002", {
    manualOrder: 1,
    projectWorkspace: workspace({ task: TASK, sourceAnalysis, plan: sharedPlan, receipt })
  });
  const firstVersions = versionsFor(first, sharedPlan, "shooting");
  const secondVersions = versionsFor(second, sharedPlan, "shooting");
  const firstRecords = [];
  for (const version of firstVersions) firstRecords.push(takeRecord({ project: first, plan: sharedPlan, version, existing: firstRecords, handoffRole: "primary" }));
  const board = buildProductionCommandBoard(snapshot(
    [second, first],
    [...secondVersions, ...firstVersions],
    firstRecords
  ), { today: TODAY });

  assert.deepEqual(board.commands.map((entry) => [entry.projectId, entry.actionCode]), [
    [first.id, "take_ready"],
    [second.id, "take_unreviewed"]
  ]);
});

test("fails closed on malformed partial snapshots while accepting explicit today and bounded limit", () => {
  const { project, plan } = deliveredProject("prj_abcd1234");
  const versions = versionsFor(project, plan);
  const foreign = { ...versions[0], id: "prj_deadbeef:" + versions[0].testId, projectId: "prj_deadbeef" };

  assert.throws(() => buildProductionCommandBoard(null, { today: TODAY }), /快照/u);
  assert.throws(() => buildProductionCommandBoard({ projects: [project], versions: [], takeReviews: null }, { today: TODAY }), /缺少/u);
  assert.throws(() => buildProductionCommandBoard(snapshot([project], [foreign]), { today: TODAY }), /其他项目/u);
  assert.throws(() => buildProductionCommandBoard(snapshot([project], [versions[0], structuredClone(versions[0])]), { today: TODAY }), /重复测试版本/u);
  assert.throws(() => buildProductionCommandBoard(snapshot([project], versions), { today: "09/02/2026" }), /YYYY-MM-DD/u);
  assert.throws(() => buildProductionCommandBoard(snapshot([project], versions), { today: TODAY, limit: 0 }), /正整数/u);
});
