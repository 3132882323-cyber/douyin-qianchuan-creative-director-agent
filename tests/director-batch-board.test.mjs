import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorBatchBoard, directorBatchBoardToText, directorBatchEditAssemblyToText } from "../src/director-batch-board.js";

const VARIABLE_CONFIG = Object.freeze({
  hook: { label: "前三秒钩子", field: "hook", values: ["先看结果", "别急着下结论", "三秒看懂差别"] },
  claim: { label: "核心主张", field: "coreClaim", values: ["过程更透明", "结果可核验", "步骤更省心"] },
  scene: { label: "拍摄场景", field: "scene", values: ["门店入口", "操作台前", "交付现场"] },
  audience: { label: "目标受众", field: "audience", values: ["首次到店用户", "复购用户", "时间紧的用户"] }
});

function batchItem(index, variable = "hook", overrides = {}) {
  const config = VARIABLE_CONFIG[variable];
  const value = config.values[index];
  const fields = {
    audience: "首次到店用户",
    hook: "先看结果",
    coreClaim: "过程更透明",
    scene: "门店入口"
  };
  fields[config.field] = value;
  const batchId = `BATCH-${variable.toUpperCase()}`;
  const id = index === 0 ? `${batchId}-B00` : `${batchId}-A${String(index).padStart(2, "0")}`;
  const production = {
    spokenScript: `${fields.hook}\n随后进入可核验过程`,
    storyboard: `0–3 秒｜${fields.scene}的结果近景｜${fields.hook}｜单一焦点`,
    shootingTask: `测试编号：${id}\n必拍证据：完整记录${fields.coreClaim}的条件、过程与结果`,
    editingNotes: "第三秒接入同一段完整证据，保留前后两秒余量。",
    subtitleHighlights: `• ${fields.hook}\n• ${fields.coreClaim}`,
    complianceChecklist: "核对事实、证据来源与素材授权。",
    ...(overrides.production || {})
  };
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "自有母版一",
    singleVariable: config.label,
    variant: value,
    fixedElements: "演员、机位、光线、证据条件、时长与行动引导",
    ...fields,
    ...overrides,
    production
  };
}

function samplePlan(variable = "hook", count = 3) {
  return {
    batchId: `BATCH-${variable.toUpperCase()}`,
    testVariable: variable === "claim" ? "sellingPoint" : variable,
    items: Array.from({ length: count }, (_, index) => batchItem(index, variable))
  };
}

test("builds a non-mutating hook batch board with shared shots before ordered variable inserts", () => {
  const plan = samplePlan();
  const original = structuredClone(plan);
  const board = buildDirectorBatchBoard(plan);
  assert.equal(board.code, "ready");
  assert.equal(board.copyable, true);
  assert.equal(board.variableLabel, "前三秒钩子");
  assert.deepEqual(board.entries.map((entry) => entry.id), ["BATCH-HOOK-B00", "BATCH-HOOK-A01", "BATCH-HOOK-A02"]);
  assert.equal(board.entries[0].requiresReshoot, false);
  assert.match(board.entries[0].uniqueInstruction, /不再单独补拍/u);
  assert.match(board.entries[1].uniqueInstruction, /只重拍 0–3 秒/u);
  const output = directorBatchBoardToText(board);
  assert.match(output, /共用镜头 · 只拍一次/u);
  assert.match(output, /变量镜头 · 基线随母版 \/ 变体逐版本重拍/u);
  assert.match(output, /连续性锁定/u);
  assert.match(output, /收工前保险镜头/u);
  assert.match(output, /不估算节省工时、不自动合并素材，也不修改方案或制作状态/u);
  assert.deepEqual(plan, original);
});

test("blocks fixed-field drift, stale declared values and duplicate test values", () => {
  const plan = samplePlan();
  plan.items[1].scene = "另一处场景";
  plan.items[1].variant = "没有同步到钩子字段";
  plan.items[2].hook = plan.items[0].hook;
  plan.items[2].variant = plan.items[0].hook;
  const board = buildDirectorBatchBoard(plan);
  assert.equal(board.code, "blocked");
  assert.equal(board.copyable, false);
  assert.ok(board.blockers.some((item) => /拍摄场景.*基线不同/u.test(item)));
  assert.ok(board.blockers.some((item) => /方案变量值与前三秒钩子字段不一致/u.test(item)));
  assert.ok(board.blockers.some((item) => /重复变量值/u.test(item)));
  assert.throws(() => directorBatchBoardToText(board), /仍待修正/u);
});

test("uses variable-specific shared and reshoot rules for claim, scene and audience batches", () => {
  const cases = [
    ["claim", "主张口播", /事实来源/u],
    ["scene", "完整重拍场景建立", /换场后重新记录/u],
    ["audience", "称呼、问题触发和人物反应", /受众变化必须体现/u]
  ];
  for (const [variable, uniqueCue, sharedCue] of cases) {
    const board = buildDirectorBatchBoard(samplePlan(variable));
    assert.equal(board.code, "ready", variable);
    assert.match(board.entries[1].uniqueInstruction, new RegExp(uniqueCue, "u"));
    assert.ok(board.sharedShots.some((item) => sharedCue.test(item)));
    assert.match(directorBatchBoardToText(board), new RegExp(board.variableLabel, "u"));
  }
});

test("fails closed for invalid batch size, variable declarations, missing production fields and excessive text", () => {
  assert.throws(() => buildDirectorBatchBoard(samplePlan("hook", 1)), /2–20/u);
  const unknown = samplePlan();
  unknown.testVariable = "unknown";
  unknown.items.forEach((item) => { item.singleVariable = "未知变量"; });
  assert.throws(() => buildDirectorBatchBoard(unknown), /无法识别/u);
  const incomplete = samplePlan();
  incomplete.items[1].production.shootingTask = "普通说明";
  const incompleteBoard = buildDirectorBatchBoard(incomplete);
  assert.equal(incompleteBoard.copyable, false);
  assert.ok(incompleteBoard.blockers.some((item) => /证据镜头/u.test(item)));
  const ambiguousSlate = samplePlan();
  ambiguousSlate.items[2].id = ambiguousSlate.items[1].id;
  const ambiguousBoard = buildDirectorBatchBoard(ambiguousSlate);
  assert.equal(ambiguousBoard.copyable, false);
  assert.ok(ambiguousBoard.blockers.some((item) => /测试编号重复/u.test(item)));
  const excessive = samplePlan();
  excessive.items[0].hook = "长".repeat(1001);
  excessive.items[0].variant = excessive.items[0].hook;
  excessive.items[0].production.spokenScript = excessive.items[0].hook;
  assert.throws(() => buildDirectorBatchBoard(excessive), /处理上限/u);
});

test("builds an editor-ready assembly map without touching files or project state", () => {
  const plan = samplePlan();
  const original = structuredClone(plan);
  const board = buildDirectorBatchBoard(plan);
  const output = directorBatchEditAssemblyToText(board);
  assert.match(output, /批次剪辑装配单/u);
  assert.match(output, /00_REFERENCE\/BATCH-HOOK__B00__MASTER__T01/u);
  assert.match(output, /10_SHARED\/BATCH-HOOK__SHARED__/u);
  assert.match(output, /20_VARIANTS\/BATCH-HOOK-A01/u);
  assert.match(output, /0\.0–3\.0 秒的首帧、钩子口播与首屏字幕/u);
  assert.match(output, /版本复制后先断开变量片段与 B00 的链接/u);
  assert.match(output, /首轮导出验收/u);
  assert.match(output, /不读取或分析媒体、不操作剪辑软件、不批量改名、不自动导出/u);
  assert.deepEqual(plan, original);
});

test("uses variable-specific anti-contamination rules and refuses blocked or tampered boards", () => {
  const cases = [
    ["claim", /主张口播、主张字幕和支持该主张的证据必须成组锁定/u],
    ["scene", /不得用裁切、放大或无关特写伪装场景变化/u],
    ["audience", /称呼、问题、人物反应与首屏字幕必须来自同一受众版本/u]
  ];
  for (const [variable, expected] of cases) {
    assert.match(directorBatchEditAssemblyToText(buildDirectorBatchBoard(samplePlan(variable))), expected);
  }
  const blockedPlan = samplePlan();
  blockedPlan.items[1].scene = "固定场景发生漂移";
  assert.throws(() => directorBatchEditAssemblyToText(buildDirectorBatchBoard(blockedPlan)), /仍待修正/u);
  const tampered = buildDirectorBatchBoard(samplePlan());
  tampered.assembly.guard = "";
  assert.throws(() => directorBatchEditAssemblyToText(tampered), /缺少装配边界/u);
});
