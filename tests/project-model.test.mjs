import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_PORTFOLIO_SCHEMA_VERSION,
  buildVersionTimeline,
  createProjectRecord,
  createResultRecord,
  sanitizeProjectWorkspace,
  sanitizeVersionRecord,
  validateProjectPortfolio,
  versionRecordsFromPlan
} from "../src/project-model.js";
import { createExperimentDecision } from "../src/experiment-decision.js";
import { createContentPriority } from "../src/content-priority.js";
import { createProductionStatus } from "../src/production-status.js";
import { sanitizeTakeReviewRecord } from "../src/take-review-record.js";

const projectId = "prj_12345678";

function item(id, variant = "直接提出问题") {
  return {
    id,
    type: id.endsWith("B00") ? "基线" : "变体",
    baselineCreative: "历史素材 A",
    singleVariable: "前三秒钩子",
    variant,
    audience: "通勤人群",
    hook: variant,
    coreClaim: "真实体验",
    scene: "地铁",
    hypothesis: "只修改钩子并观察结果",
    fixedElements: "受众、主张、场景",
    observationMetrics: "CTR、ROI",
    minSpend: 300,
    stopCondition: "达到最低消耗后判断",
    successAction: "保留有效变量",
    production: {
      spokenScript: "口播",
      storyboard: "分镜",
      shootingTask: "任务",
      editingNotes: "剪辑",
      subtitleHighlights: "字幕",
      complianceChecklist: "核验事实"
    }
  };
}

function plan(batchId, generatedAt, suffix = "B00") {
  return {
    generatedAt,
    version: "1.3.0",
    batchId,
    creativeTask: {},
    sourceSummary: { targetRoi: 1.5 },
    testVariable: "hook",
    items: [item(`${batchId}-${suffix}`)],
    notice: "本地规则"
  };
}

function takeReviewRecord({ id = "take_12345678", project = projectId, testId, batchId, materialCode = "C001", takeNumber = "T01", handoffRole = "none", createdOrder } = {}) {
  return sanitizeTakeReviewRecord({
    schemaVersion: 1,
    id,
    projectId: project,
    source: {
      batchId,
      testId,
      type: "基线",
      orderLabel: "先拍基线",
      singleVariable: "前三秒钩子",
      variant: "先看结果",
      fixedElements: "演员、机位、光线",
      planFingerprint: "take-plan:11111111",
      versionFingerprint: "take-version:22222222",
      reviewFingerprint: "take-review:33333333"
    },
    materialCode,
    takeNumber,
    checks: ["silent_first_frame", "audible_hook", "proof_continuity", "fixed_continuity", "audio_handles"].map((code) => ({ code, status: "pass" })),
    outcome: "keep",
    handoffRole,
    issueTimecode: "",
    nextCorrection: "",
    ownerRole: "none",
    createdAt: "2026-08-23T02:00:00.000Z",
    updatedAt: "2026-08-23T02:00:00.000Z",
    revision: 1,
    ...(createdOrder ? { createdOrder } : {})
  });
}

test("creates bounded local projects and sanitizes only restorable workspace data", () => {
  const project = createProjectRecord({
    id: projectId,
    name: "  春季 素材计划  ",
    now: "2026-08-23T01:00:00.000Z",
    workspace: { creativeTask: { subject: "通勤" }, targetRoi: 1.8, unknownSecret: "drop" }
  });
  assert.equal(project.name, "春季 素材计划");
  assert.equal(project.workspace.creativeTask.subject, "通勤");
  assert.equal(project.workspace.targetRoi, 1.8);
  assert.equal(project.contentPriority, null);
  assert.equal("unknownSecret" in project.workspace, false);
  assert.throws(() => createProjectRecord({ id: "bad", name: "项目" }), /项目编号/);
  assert.throws(() => sanitizeProjectWorkspace([]), /工作区/);
});

test("restores old projects without priority and preserves optional manual content priority in backups", () => {
  const legacy = createProjectRecord({ id: projectId, name: "旧项目", now: "2026-08-23T01:00:00.000Z", workspace: { creativeTask: { subject: "旧选题" } } });
  const { contentPriority: _omitted, ...oldRecord } = legacy;
  const oldPortfolio = validateProjectPortfolio({ schemaVersion: 1, currentProjectId: projectId, projects: [oldRecord], versions: [], results: [] });
  assert.equal(oldPortfolio.schemaVersion, PROJECT_PORTFOLIO_SCHEMA_VERSION);
  assert.deepEqual(oldPortfolio.takeReviews, []);
  assert.equal(oldPortfolio.projects[0].contentPriority, null);

  const priority = createContentPriority({
    project: legacy,
    lane: "now",
    reason: "本周优先完成这一内容验证",
    dueOn: "2026-08-28",
    manualOrder: 2,
    now: "2026-08-23T02:00:00.000Z"
  });
  const currentPortfolio = validateProjectPortfolio({
    schemaVersion: 1,
    currentProjectId: projectId,
    projects: [{ ...legacy, contentPriority: priority }],
    versions: [],
    results: []
  });
  assert.deepEqual(currentPortfolio.projects[0].contentPriority, priority);
  assert.deepEqual(currentPortfolio.takeReviews, []);
});

test("keeps explicit parent lineage and evaluates only backfilled descriptive results", () => {
  const firstPlan = plan("MAT1234567-HOOK-20260823T010000000", "2026-08-23T01:00:00.000Z");
  const [first] = versionRecordsFromPlan({ projectId, plan: firstPlan, existingVersions: [], parentVersionId: null, now: "2026-08-23T01:00:01.000Z" });
  const secondPlan = plan("MAT1234567-HOOK-20260824T010000000", "2026-08-24T01:00:00.000Z", "A01");
  const [second] = versionRecordsFromPlan({ projectId, plan: secondPlan, existingVersions: [first], parentVersionId: first.testId, now: "2026-08-24T01:00:01.000Z" });
  assert.equal(second.parentVersionId, first.testId);

  const results = [
    createResultRecord({ projectId, testId: first.testId, importedAt: "2026-08-25T01:00:00.000Z", metrics: { spend: 400, roi: 1.4 } }),
    createResultRecord({ projectId, testId: second.testId, importedAt: "2026-08-25T01:00:00.000Z", metrics: { spend: 350, gmv: 560 } })
  ];
  const timeline = buildVersionTimeline([first, second], results, 1.5);
  const child = timeline.find((entry) => entry.version.testId === second.testId);
  assert.equal(child.result.metrics.roi, 1.6);
  assert.equal(child.evaluation.code, "target_met");

  const decision = createExperimentDecision({ outcome: "keep", primaryMetric: "roi", guardrailMetrics: ["ctr"], reason: "达到最低消耗和目标 ROI，暂时保留此版本。" }, {
    version: second,
    result: child.result,
    evaluation: child.evaluation,
    targetRoi: 1.5
  }, { decidedAt: "2026-08-25T03:00:00.000Z" });
  const decidedSecond = sanitizeVersionRecord({ ...second, decision });
  const [resynced] = versionRecordsFromPlan({ projectId, plan: secondPlan, existingVersions: [first, decidedSecond], parentVersionId: first.testId, now: "2026-08-25T04:00:00.000Z" });
  assert.equal(resynced.decision.outcome, "keep");
  const changedResult = createResultRecord({ projectId, testId: second.testId, importedAt: "2026-08-26T01:00:00.000Z", metrics: { spend: 500, roi: 1.2 } });
  assert.equal(buildVersionTimeline([first, resynced], [results[0], changedResult], 1.5).find((entry) => entry.version.testId === second.testId).decisionState.code, "stale");

  const insufficient = buildVersionTimeline([second], [createResultRecord({ projectId, testId: second.testId, importedAt: "2026-08-25T02:00:00.000Z", metrics: { spend: 20, roi: 5 } })], 1.5)[0];
  assert.equal(insufficient.evaluation.code, "insufficient");
  assert.throws(() => versionRecordsFromPlan({ projectId, plan: secondPlan, existingVersions: [first], parentVersionId: "UNKNOWN" }), /父版本/);
});

test("keeps production progress explicitly untracked until a director marks it", () => {
  const firstPlan = plan("MAT1234567-HOOK-20260823T010000000", "2026-08-23T01:00:00.000Z");
  const [first] = versionRecordsFromPlan({ projectId, plan: firstPlan, existingVersions: [], parentVersionId: null, now: "2026-08-23T01:00:01.000Z" });
  assert.equal(first.productionStatus, null);
  const marked = sanitizeVersionRecord({
    ...first,
    productionStatus: createProductionStatus("shooting", "2026-08-23T02:00:00.000Z")
  });
  assert.equal(marked.productionStatus.stage, "shooting");
  const [resynced] = versionRecordsFromPlan({ projectId, plan: firstPlan, existingVersions: [marked], parentVersionId: null, now: "2026-08-23T03:00:00.000Z" });
  assert.deepEqual(resynced.productionStatus, marked.productionStatus);
  assert.throws(() => sanitizeVersionRecord({ ...first, productionStatus: { stage: "published", updatedAt: "2026-08-23T02:00:00.000Z" } }), /状态代码/u);
});

test("validates a complete multi-project backup and rejects broken references", () => {
  const project = createProjectRecord({ id: projectId, name: "项目 A", now: "2026-08-23T01:00:00.000Z" });
  const [version] = versionRecordsFromPlan({
    projectId,
    plan: plan("MAT1234567-HOOK-20260823T010000000", "2026-08-23T01:00:00.000Z"),
    existingVersions: [],
    parentVersionId: null,
    now: "2026-08-23T01:00:01.000Z"
  });
  const markedVersion = { ...version, productionStatus: createProductionStatus("ready", "2026-08-24T01:00:00.000Z") };
  const result = createResultRecord({ projectId, testId: version.testId, importedAt: "2026-08-25T01:00:00.000Z", metrics: { spend: 400, roi: 1.6 } });
  const takeReview = takeReviewRecord({ testId: version.testId, batchId: version.batchId, handoffRole: "primary" });
  const portfolio = validateProjectPortfolio({ schemaVersion: 2, currentProjectId: projectId, projects: [project], versions: [markedVersion], results: [result], takeReviews: [takeReview] });
  assert.equal(portfolio.projects.length, 1);
  assert.equal(portfolio.results[0].testId, version.testId);
  assert.equal(portfolio.versions[0].productionStatus.stage, "ready");
  assert.deepEqual(portfolio.takeReviews, [takeReview]);
  assert.deepEqual(validateProjectPortfolio(portfolio), portfolio);
  assert.throws(() => validateProjectPortfolio({ ...portfolio, results: [{ ...result, testId: "UNKNOWN", id: `${projectId}:UNKNOWN` }] }), /结果记录/);
  assert.throws(() => validateProjectPortfolio({ ...portfolio, takeReviews: [{ ...takeReview, source: { ...takeReview.source, testId: "UNKNOWN" } }] }), /过条记录引用/u);
  assert.throws(() => validateProjectPortfolio({ ...portfolio, takeReviews: [{ ...takeReview, source: { ...takeReview.source, batchId: "OTHER-BATCH" } }] }), /测试批次与版本不一致/u);
  assert.throws(() => validateProjectPortfolio({ ...portfolio, takeReviews: [takeReview, { ...takeReview }] }), /重复的人工过条/u);
  assert.throws(() => validateProjectPortfolio({ ...portfolio, takeReviews: undefined }), /缺少人工过条/u);
});

test("rejects duplicate take identities, duplicate manual handoff roles and per-version overflow", () => {
  const project = createProjectRecord({ id: projectId, name: "项目 A", now: "2026-08-23T01:00:00.000Z" });
  const [version] = versionRecordsFromPlan({
    projectId,
    plan: plan("MAT1234567-HOOK-20260823T010000000", "2026-08-23T01:00:00.000Z"),
    existingVersions: [],
    parentVersionId: null,
    now: "2026-08-23T01:00:01.000Z"
  });
  const base = { schemaVersion: 2, currentProjectId: projectId, projects: [project], versions: [version], results: [] };
  const first = takeReviewRecord({ testId: version.testId, batchId: version.batchId, handoffRole: "primary" });
  const duplicateIdentity = takeReviewRecord({ id: "take_87654321", testId: version.testId, batchId: version.batchId, handoffRole: "none" });
  assert.throws(() => validateProjectPortfolio({ ...base, takeReviews: [first, duplicateIdentity] }), /重复的素材编号/u);

  const duplicateRole = takeReviewRecord({ id: "take_87654321", testId: version.testId, batchId: version.batchId, materialCode: "C002", handoffRole: "primary" });
  assert.throws(() => validateProjectPortfolio({ ...base, takeReviews: [first, duplicateRole] }), /只能指定一个/u);

  const orderedFirst = takeReviewRecord({ testId: version.testId, batchId: version.batchId, handoffRole: "none", createdOrder: 1 });
  const duplicateOrder = takeReviewRecord({ id: "take_87654321", testId: version.testId, batchId: version.batchId, materialCode: "C002", takeNumber: "T02", handoffRole: "none", createdOrder: 1 });
  assert.throws(() => validateProjectPortfolio({ ...base, takeReviews: [orderedFirst, duplicateOrder] }), /重复的人工过条创建顺序/u);

  const overflow = Array.from({ length: 21 }, (_, index) => takeReviewRecord({
    id: `take_${String(index).padStart(8, "0")}`,
    testId: version.testId,
    batchId: version.batchId,
    materialCode: `C${index}`,
    takeNumber: `T${index}`
  }));
  assert.throws(() => validateProjectPortfolio({ ...base, takeReviews: overflow }), /单版本.*20/u);
});

test("enforces the aggregate 1000-take project boundary across version history", () => {
  const project = createProjectRecord({ id: projectId, name: "项目 A", now: "2026-08-23T01:00:00.000Z" });
  const versions = Array.from({ length: 51 }, (_, index) => {
    const batchId = `HISTORY-${String(index).padStart(2, "0")}`;
    return versionRecordsFromPlan({
      projectId,
      plan: plan(batchId, "2026-08-23T01:00:00.000Z"),
      existingVersions: [],
      parentVersionId: null,
      now: "2026-08-23T01:00:01.000Z"
    })[0];
  });
  const takeReviews = Array.from({ length: 1001 }, (_, index) => {
    const version = versions[Math.floor(index / 20)];
    return takeReviewRecord({
      id: `take_${String(index).padStart(8, "0")}`,
      testId: version.testId,
      batchId: version.batchId,
      materialCode: `C${String(index).padStart(4, "0")}`,
      takeNumber: `T${String(index % 20).padStart(2, "0")}`
    });
  });
  assert.throws(() => validateProjectPortfolio({
    schemaVersion: 2,
    currentProjectId: projectId,
    projects: [project],
    versions,
    results: [],
    takeReviews
  }), /单项目人工过条记录超过 1000/u);
});

test("rejects cyclic parent lineage and isolates identical test ids by project", () => {
  const projectA = createProjectRecord({ id: projectId, name: "项目 A", now: "2026-08-23T01:00:00.000Z" });
  const projectB = createProjectRecord({ id: "prj_87654321", name: "项目 B", now: "2026-08-23T01:00:00.000Z" });
  const firstPlan = plan("MAT1234567-HOOK-20260823T010000000", "2026-08-23T01:00:00.000Z");
  const [versionA] = versionRecordsFromPlan({ projectId: projectA.id, plan: firstPlan, existingVersions: [], parentVersionId: null, now: "2026-08-23T01:00:01.000Z" });
  const [versionB] = versionRecordsFromPlan({ projectId: projectB.id, plan: firstPlan, existingVersions: [], parentVersionId: null, now: "2026-08-23T01:00:01.000Z" });
  const resultA = createResultRecord({ projectId: projectA.id, testId: versionA.testId, importedAt: "2026-08-25T01:00:00.000Z", metrics: { spend: 400, roi: 1.8 } });
  const resultB = createResultRecord({ projectId: projectB.id, testId: versionB.testId, importedAt: "2026-08-25T01:00:00.000Z", metrics: { spend: 400, roi: 0.8 } });
  const timeline = buildVersionTimeline([versionA, versionB], [resultA, resultB], 1.5);
  assert.equal(timeline.find((entry) => entry.version.projectId === projectA.id).evaluation.code, "target_met");
  assert.equal(timeline.find((entry) => entry.version.projectId === projectB.id).evaluation.code, "below_target");

  const secondPlan = plan("MAT1234567-HOOK-20260824T010000000", "2026-08-24T01:00:00.000Z", "A01");
  const [secondVersion] = versionRecordsFromPlan({ projectId: projectA.id, plan: secondPlan, existingVersions: [versionA], parentVersionId: versionA.testId, now: "2026-08-24T01:00:01.000Z" });
  const cyclicFirstVersion = { ...versionA, parentVersionId: secondVersion.testId };
  assert.throws(() => validateProjectPortfolio({
    schemaVersion: 1,
    currentProjectId: projectA.id,
    projects: [projectA],
    versions: [cyclicFirstVersion, secondVersion],
    results: []
  }), /循环引用/u);
});

test("rejects impossible funnel counts in stored or restored result records", () => {
  assert.throws(() => createResultRecord({ projectId, testId: "TEST-1", metrics: { spend: 100, impressions: 10, clicks: 11 } }), /点击量/u);
  assert.throws(() => createResultRecord({ projectId, testId: "TEST-1", metrics: { spend: 100, clicks: 10, conversions: 11 } }), /转化量/u);
  assert.throws(() => createResultRecord({ projectId, testId: "TEST-1", metrics: { spend: 100 }, qualityWarnings: ["unknown"] }), /提醒代码/u);
  assert.deepEqual(createResultRecord({ projectId, testId: "TEST-1", metrics: { spend: 100 }, qualityWarnings: ["roi_mismatch"] }).qualityWarnings, ["roi_mismatch"]);
});
