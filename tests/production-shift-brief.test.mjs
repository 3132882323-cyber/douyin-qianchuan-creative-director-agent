import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_SHIFT_STATIONS,
  buildProductionShiftBrief
} from "../src/production-shift-brief.js";

const TODAY = "2026-09-02";

function command(index, overrides = {}) {
  return {
    id: `prj_0000000${index}:task_missing:project`,
    projectId: `prj_0000000${index}`,
    name: `项目 ${index}`,
    current: index === 1,
    lane: "now",
    manualOrder: index,
    reason: `内容负责人手工排定第 ${index} 位`,
    dueOn: null,
    overdue: false,
    actionCode: "task_missing",
    actionLabel: "补充创作任务",
    statusLabel: "待补任务",
    detail: "先明确受众和可验证证据。",
    blocked: true,
    testId: null,
    route: { type: "workflow" },
    ...overrides
  };
}

test("keeps the saved manual order and formats every required production field", () => {
  const board = {
    hiddenCount: 2,
    commands: [
      command(1, { name: "先拍真实口播", dueOn: "2026-09-02" }),
      command(2, {
        name: "再补场景证据",
        actionCode: "take_reshoot",
        actionLabel: "按记录完成补拍",
        statusLabel: "待补拍",
        detail: "只补录人工标记的问题镜头。",
        testId: "batch-a01",
        dueOn: "2026-09-01"
      }),
      command(3, {
        name: "最后完成上线交接",
        actionCode: "production_ready",
        actionLabel: "确认上线状态",
        statusLabel: "待投放",
        detail: "确认实际进度后更新状态。",
        dueOn: "2026-09-05",
        blocked: false
      })
    ]
  };
  const before = structuredClone(board);
  const brief = buildProductionShiftBrief(board, { today: TODAY });

  assert.deepEqual(brief.items.map((item) => item.projectName), ["先拍真实口播", "再补场景证据", "最后完成上线交接"]);
  assert.deepEqual(brief.items.map((item) => item.station), ["编导策划", "片场", "投放交接"]);
  assert.equal(brief.items[0].deadlineReminder, "今日截止 · 2026-09-02");
  assert.equal(brief.items[1].deadlineReminder, "已超期 · 原截止 2026-09-01");
  assert.equal(brief.items[1].testId, "batch-a01");
  assert.match(brief.text, /目标版本：batch-a01/u);
  assert.equal(brief.items[2].deadlineReminder, "截止 2026-09-05");
  assert.match(brief.text, /项目顺序来自内容负责人已保存的人工立即做排期/u);
  assert.match(brief.text, /另有 2 个项目未展开/u);
  assert.equal(brief.hiddenCount, 2);
  assert.match(brief.text, /工位仅为流程提示，不代表自动分配具体个人/u);
  assert.match(brief.text, /人工排期理由：内容负责人手工排定第 1 位/u);
  assert.match(brief.text, /唯一下一步：补充创作任务/u);
  assert.match(brief.text, /当前状态：待补任务（阻塞）/u);
  assert.match(brief.text, /完成口径：受众、创作目标/u);
  assert.deepEqual(board, before);
});

test("maps every supported action to a workflow station without assigning a person", () => {
  const expected = {
    task_missing: "编导策划",
    analysis_missing: "编导策划",
    plan_missing: "编导策划",
    plan_stale: "编导策划",
    plan_batch_invalid: "编导策划",
    plan_delivery_pending: "编导策划",
    plan_delivery_stale: "编导策划",
    versions_unsynced: "内容负责人",
    take_order_ambiguous: "片场",
    take_hold: "片场",
    take_reshoot: "片场",
    take_unreviewed: "片场",
    take_needs_primary: "片场",
    take_ready: "剪辑",
    production_untracked: "内容负责人",
    production_planned: "片场",
    production_shooting: "片场",
    production_editing: "剪辑",
    production_ready: "投放交接",
    production_launched: "内容负责人",
    production_paused: "内容负责人",
    snapshot_error: "内容负责人"
  };

  for (const [actionCode, station] of Object.entries(expected)) {
    const brief = buildProductionShiftBrief({ commands: [command(1, { actionCode })] }, { today: TODAY });
    assert.equal(brief.items[0].station, station, actionCode);
    assert.equal(brief.items[0].assignment, null, actionCode);
  }
  assert.deepEqual(PRODUCTION_SHIFT_STATIONS, ["编导策划", "片场", "剪辑", "投放交接", "内容负责人"]);
});

test("defines a persistent completion condition for a paused project", () => {
  const brief = buildProductionShiftBrief({
    commands: [command(1, { actionCode: "production_paused", actionLabel: "将项目移入暂停泳道" })]
  }, { today: TODAY });

  assert.equal(brief.items[0].station, "内容负责人");
  assert.equal(brief.items[0].completionCriteria, "项目已从“立即做”移入“暂停”泳道，不再占用今日执行位。");
  assert.match(brief.text, /完成口径：项目已从“立即做”移入“暂停”泳道/u);
});

test("defines a persistent completion condition for a launched project still scheduled today", () => {
  const brief = buildProductionShiftBrief({
    commands: [command(1, { actionCode: "production_launched", actionLabel: "将项目移出今日执行位" })]
  }, { today: TODAY });

  assert.equal(brief.items[0].station, "内容负责人");
  assert.match(brief.items[0].completionCriteria, /已从“立即做”移出/u);
});

test("carries only explicitly supplied manual assignment details", () => {
  const brief = buildProductionShiftBrief({
    commands: [command(1, {
      actionCode: "take_reshoot",
      assignment: {
        source: "manual_take_review",
        ownerRole: "director",
        ownerLabel: "编导",
        materialCode: "A02-CAM1",
        takeNumber: "Take 04",
        issueTimecode: "00:03.2",
        nextCorrection: "补录完整口播钩子"
      }
    })]
  }, { today: TODAY });

  assert.deepEqual(brief.items[0].assignment, {
    ownerLabel: "编导",
    materialCode: "A02-CAM1",
    takeNumber: "Take 04",
    issueTimecode: "00:03.2",
    nextCorrection: "补录完整口播钩子",
    source: "manual_take_review",
    ownerRole: "director"
  });
  assert.match(brief.text, /人工登记责任：负责人：编导；素材编号：A02-CAM1；Take：Take 04；问题时间码：00:03.2；下一条修正：补录完整口播钩子/u);
});

test("returns deterministic station totals and a content-owner deadline reminder when no due date exists", () => {
  const brief = buildProductionShiftBrief({ commands: [
    command(1),
    command(2, { actionCode: "production_editing" }),
    command(3, { actionCode: "production_editing" })
  ] }, { today: TODAY });

  assert.deepEqual(brief.stationCounts, {
    编导策划: 1,
    片场: 0,
    剪辑: 2,
    投放交接: 0,
    内容负责人: 0
  });
  assert.equal(brief.items[0].deadlineReminder, "无硬性截止日；如有交接时限，请由内容负责人补充。");
});

test("fails closed on empty or oversized queues, unknown actions, invalid dates and malformed fields", () => {
  assert.throws(() => buildProductionShiftBrief({ commands: [] }, { today: TODAY }), /1–3/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1), command(2), command(3), command(4)] }, { today: TODAY }), /1–3/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1)] }, { today: "2026-02-30" }), /不是有效日期/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { dueOn: "02\/09\/2026" })] }, { today: TODAY }), /YYYY-MM-DD/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { actionCode: "auto_rank_by_roi" })] }, { today: TODAY }), /未知生产动作/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { actionCode: "toString" })] }, { today: TODAY }), /未知生产动作/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { lane: "week" })] }, { today: TODAY }), /只能包含人工“立即做”/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { manualOrder: 2 }), command(2, { manualOrder: 1 })] }, { today: TODAY }), /稳定人工顺序/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(2, { manualOrder: 1 }), command(1, { manualOrder: 1 })] }, { today: TODAY }), /稳定人工顺序/u);
  assert.doesNotThrow(() => buildProductionShiftBrief({ commands: [command(1, { manualOrder: 1 }), command(2, { manualOrder: 1 })] }, { today: TODAY }));
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { testId: "版本 A01" })] }, { today: TODAY }), /目标版本格式无效/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { blocked: "yes" })] }, { today: TODAY }), /阻塞状态/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1), command(1)] }, { today: TODAY }), /重复项目/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1)], hiddenCount: -1 }, { today: TODAY }), /未展开项目数/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { assignment: { ownerLabel: "小林", autoAssigned: true } })] }, { today: TODAY }), /当前生产动作不应/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, {
    actionCode: "take_hold",
    assignment: { source: "manual_take_review", ownerRole: "camera", ownerLabel: "编导", materialCode: "A01", takeNumber: "Take 1", issueTimecode: "", nextCorrection: "核对" }
  })] }, { today: TODAY }), /标签不一致/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, {
    actionCode: "take_hold",
    assignment: { source: "manual_take_review", ownerRole: "toString", ownerLabel: "x", materialCode: "A01", takeNumber: "Take 1", issueTimecode: "", nextCorrection: "核对" }
  })] }, { today: TODAY }), /责任角色无效/u);
});

test("removes control characters, rejects local paths and enforces text limits", () => {
  const brief = buildProductionShiftBrief({ commands: [command(1, {
    name: "口播\u0000项目",
    reason: "今天\n优先完成真实口播",
    detail: "先拍\t固定机位"
  })] }, { today: TODAY });
  assert.equal(brief.items[0].projectName, "口播 项目");
  assert.equal(brief.items[0].manualReason, "今天 优先完成真实口播");
  assert.equal(brief.items[0].actionContext, "先拍 固定机位");
  assert.doesNotMatch(brief.text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);

  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { detail: "查看 C:\\Users\\Director\\clip.mp4" })] }, { today: TODAY }), /不要填写本机路径/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, {
    actionCode: "take_reshoot",
    assignment: { source: "manual_take_review", ownerRole: "director", ownerLabel: "编导", materialCode: "file:\/\/\/Users\/director\/clip.mp4", takeNumber: "Take 1", issueTimecode: "00:01", nextCorrection: "补拍" }
  })] }, { today: TODAY }), /不要填写本机路径/u);
  assert.throws(() => buildProductionShiftBrief({ commands: [command(1, { reason: "排".repeat(201) })] }, { today: TODAY }), /不能超过 200/u);
});

test("does not inspect or expose ROI, spend or result fields and returns immutable output", () => {
  const board = {
    roi: 99,
    spend: 100000,
    result: "自动判定胜出",
    commands: [command(1, { roi: 999, spend: 888, result: "爆款" })]
  };
  const before = structuredClone(board);
  const brief = buildProductionShiftBrief(board, { today: TODAY });

  assert.doesNotMatch(JSON.stringify(brief), /999|888|爆款|自动判定胜出/u);
  assert.match(brief.text, /不读取 ROI、消耗或结果数据/u);
  assert.equal(Object.isFrozen(brief), true);
  assert.equal(Object.isFrozen(brief.items), true);
  assert.equal(Object.isFrozen(brief.items[0]), true);
  assert.equal(Object.isFrozen(brief.stationCounts), true);
  assert.deepEqual(board, before);
});
