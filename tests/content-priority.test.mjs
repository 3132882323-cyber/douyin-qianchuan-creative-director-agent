import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_PRIORITY_LANES,
  assessContentPriority,
  buildContentPriorityBoard,
  contentPriorityContextFingerprint,
  createContentPriority,
  sanitizeContentPriority
} from "../src/content-priority.js";
import { createProjectRecord } from "../src/project-model.js";

const NOW = "2026-09-02T08:00:00.000Z";

function project(id, overrides = {}) {
  const workspace = {
    creativeTask: {
      subject: "通勤真实体验",
      targetAudience: "每天通勤的人",
      creativeGoal: "让受众理解使用过程",
      coreClaim: "完整展示过程",
      evidence: "连续实拍"
    },
    targetRoi: 1.5,
    ...overrides.workspace
  };
  return createProjectRecord({
    id,
    name: overrides.name || id,
    workspace,
    contentPriority: overrides.contentPriority ?? null,
    now: NOW
  });
}

function schedule(source, { lane = "now", reason = "本周必须验证这条内容命题", dueOn = null, manualOrder = 0 } = {}) {
  return {
    ...source,
    contentPriority: createContentPriority({ project: source, lane, reason, dueOn, manualOrder, now: NOW })
  };
}

test("exposes exactly four manual priority lanes", () => {
  assert.deepEqual(CONTENT_PRIORITY_LANES, {
    now: "立即做",
    week: "本周",
    backlog: "候选",
    paused: "暂停"
  });
  assert.equal(Object.isFrozen(CONTENT_PRIORITY_LANES), true);
});

test("context fingerprint binds only the four content-alignment fields", () => {
  const original = project("prj_11111111");
  const fingerprint = contentPriorityContextFingerprint(original);
  const unrelated = {
    ...original,
    workspace: {
      ...original.workspace,
      targetRoi: 99,
      creativeTask: {
        ...original.workspace.creativeTask,
        evidence: "替换证据",
        riskNotes: "新增风险",
        duration: 60
      }
    }
  };
  assert.equal(contentPriorityContextFingerprint(unrelated), fingerprint);
  for (const field of ["subject", "targetAudience", "creativeGoal", "coreClaim"]) {
    const changed = {
      ...original,
      workspace: {
        ...original.workspace,
        creativeTask: { ...original.workspace.creativeTask, [field]: `${original.workspace.creativeTask[field]}（更新）` }
      }
    };
    assert.notEqual(contentPriorityContextFingerprint(changed), fingerprint, field);
  }
});

test("creates a deterministic bounded manual priority without mutating the project", () => {
  const source = project("prj_22222222");
  const before = structuredClone(source);
  const first = createContentPriority({
    project: source,
    lane: "week",
    reason: "  等待周三场地后统一开拍  ",
    dueOn: "2026-09-05",
    manualOrder: 12,
    now: NOW
  });
  const second = createContentPriority({
    project: source,
    lane: "week",
    reason: "等待周三场地后统一开拍",
    dueOn: "2026-09-05",
    manualOrder: 12,
    now: NOW
  });
  assert.deepEqual(first, second);
  assert.equal(first.method, "manual");
  assert.equal(first.reason, "等待周三场地后统一开拍");
  assert.deepEqual(source, before);
});

test("rejects malformed priorities and supports explicit nullable restoration", () => {
  const source = project("prj_33333333");
  const valid = createContentPriority({ project: source, lane: "now", reason: "优先验证首帧内容方向", manualOrder: 0, now: NOW });
  assert.equal(sanitizeContentPriority(null), null);
  assert.throws(() => sanitizeContentPriority(null, { allowNull: false }), /不能为空/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, unknown: true }), /未知字段/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, method: "auto" }), /人工/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, lane: "urgent" }), /泳道/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, reason: "短" }), /至少/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, reason: "长".repeat(201) }), /200/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, dueOn: "2026-02-30" }), /有效日期/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, manualOrder: "1" }), /整数/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, manualOrder: 1.5 }), /整数/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, manualOrder: 1_000_001 }), /整数/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, contextFingerprint: "bad" }), /指纹/u);
  assert.throws(() => sanitizeContentPriority({ ...valid, updatedAt: "today" }), /时间格式/u);
});

test("assesses unplanned, current and stale priorities from content context", () => {
  const source = project("prj_44444444");
  assert.equal(assessContentPriority(source).code, "unplanned");
  const planned = schedule(source);
  assert.equal(assessContentPriority(planned).code, "current");
  const changed = {
    ...planned,
    workspace: {
      ...planned.workspace,
      creativeTask: { ...planned.workspace.creativeTask, creativeGoal: "改为推动另一种行动" }
    }
  };
  const result = assessContentPriority(changed);
  assert.equal(result.code, "stale");
  assert.equal(result.stale, true);
  assert.equal(result.priority.reason, planned.contentPriority.reason);
});

test("builds four bounded lanes using only manual order and excludes stale priorities from Top3", () => {
  const first = schedule(project("prj_55555555", { name: "后创建但先执行" }), { manualOrder: 20, dueOn: "2026-09-01" });
  const second = schedule(project("prj_66666666", { name: "人工第一" }), { manualOrder: 1 });
  const thirdBase = project("prj_77777777", { name: "目标已变化" });
  const third = schedule(thirdBase, { manualOrder: 0 });
  third.workspace.creativeTask.coreClaim = "新的内容主张";
  const fourth = schedule(project("prj_88888888", { name: "本周任务" }), { lane: "week", manualOrder: 0 });
  const fifth = project("prj_99999999", { name: "尚未排期" });
  const input = [first, second, third, fourth, fifth];
  const before = structuredClone(input);
  const board = buildContentPriorityBoard(input, { currentProjectId: second.id, today: "2026-09-02" });

  assert.deepEqual(board.lanes.map(({ code, label }) => [code, label]), Object.entries(CONTENT_PRIORITY_LANES));
  assert.deepEqual(board.lanes.find((lane) => lane.code === "now").items.map((entry) => entry.projectId), [third.id, second.id, first.id]);
  assert.deepEqual(board.topNow.map((entry) => entry.projectId), [second.id, first.id]);
  assert.equal(board.topNow[0].current, true);
  assert.equal(board.entries.find((entry) => entry.projectId === first.id).overdue, true);
  assert.equal(board.entries.find((entry) => entry.projectId === third.id).status, "stale");
  assert.equal(board.total, 5);
  assert.equal(board.currentCount, 3);
  assert.equal(board.staleCount, 1);
  assert.equal(board.unplannedCount, 1);
  assert.deepEqual(input, before);
});

test("derives only reliable saved workflow phases and never reads ROI for ordering", () => {
  const noTask = project("prj_a1111111", { name: "无任务", workspace: { creativeTask: {} } });
  const pending = project("prj_b2222222", { name: "待复盘" });
  const reviewed = project("prj_c3333333", { name: "已复盘", workspace: { lastAnalysis: { generatedAt: NOW, summary: {}, topCreatives: [] } } });
  const planShape = {
    generatedAt: NOW,
    version: "1.4.0",
    batchId: "MAT1234567-HOOK-20260902T080000000",
    creativeTask: {},
    sourceSummary: {},
    testVariable: "hook",
    items: [{
      id: "MAT1234567-HOOK-20260902T080000000-B00",
      type: "基线",
      baselineCreative: "历史素材",
      singleVariable: "前三秒钩子",
      variant: "直接提出问题",
      audience: "通勤人群",
      hook: "直接提出问题",
      coreClaim: "真实体验",
      scene: "通勤",
      hypothesis: "保持其他项不变",
      fixedElements: "受众、主张、场景",
      observationMetrics: "CTR",
      minSpend: 300,
      stopCondition: "人工判断",
      successAction: "保留变量",
      production: {}
    }],
    notice: "本地规则"
  };
  const planPending = project("prj_d4444444", { name: "方案待交付", workspace: { lastAnalysis: { generatedAt: NOW, summary: {}, topCreatives: [] }, creativePlan: planShape } });
  const delivered = project("prj_e5555555", { name: "策划已交付", workspace: { lastAnalysis: { generatedAt: NOW, summary: {}, topCreatives: [] }, creativePlan: planShape, planExportReceipt: { fingerprint: "plan:1234", completedAt: NOW } } });
  const scheduled = [noTask, pending, reviewed, planPending, delivered].map((entry, index) => schedule(entry, { lane: "backlog", manualOrder: index }));
  const board = buildContentPriorityBoard(scheduled, { currentProjectId: delivered.id, today: "2026-09-02" });
  assert.deepEqual(board.entries.map((entry) => entry.phaseLabel), ["无任务", "待复盘", "已复盘", "方案待交付", "策划已交付"]);
  assert.deepEqual(board.entries.map((entry) => entry.nextLabel), ["补充创作任务", "完成素材复盘", "生成下一版任务", "检查并交付方案", "进入批次拍摄"]);

  const changedRoi = scheduled.map((entry, index) => ({ ...entry, workspace: { ...entry.workspace, targetRoi: 100 - index } }));
  const secondBoard = buildContentPriorityBoard(changedRoi.reverse(), { currentProjectId: delivered.id, today: "2026-09-02" });
  assert.deepEqual(secondBoard.entries.map((entry) => entry.projectId), board.entries.map((entry) => entry.projectId));
});

test("fails closed on duplicate, oversized or ambiguous project collections", () => {
  const source = schedule(project("prj_f6666666"));
  assert.throws(() => buildContentPriorityBoard([source, structuredClone(source)], { currentProjectId: source.id, today: "2026-09-02" }), /重复/u);
  assert.throws(() => buildContentPriorityBoard(Array.from({ length: 21 }, () => source), { today: "2026-09-02" }), /不超过 20/u);
  assert.throws(() => buildContentPriorityBoard([source], { currentProjectId: "prj_deadbeef", today: "2026-09-02" }), /不在/u);
  assert.throws(() => buildContentPriorityBoard([source], { currentProjectId: source.id, today: "09/02/2026" }), /YYYY-MM-DD/u);
});
