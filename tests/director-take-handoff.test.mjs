import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorTakeHandoff, directorTakeHandoffToText } from "../src/director-take-handoff.js";

function item(index, overrides = {}) {
  const batchId = "BATCH-HOOK";
  const hooks = ["先看结果", "别急着下结论", "三秒看懂差别"];
  const id = index === 0 ? `${batchId}-B00` : `${batchId}-A${String(index).padStart(2, "0")}`;
  const hook = hooks[index];
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "自有母版一",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "首次到店用户",
    hook,
    coreClaim: "过程透明且可核验",
    scene: "门店入口",
    fixedElements: "演员、机位、光线、证据条件、时长与行动引导",
    production: {
      spokenScript: `${hook}\n随后进入可核验过程`,
      storyboard: `0–3 秒｜门店入口结果近景｜${hook}｜单一焦点`,
      shootingTask: `测试编号：${id}\n必拍证据：完整记录条件、过程与结果`,
      editingNotes: "第三秒接入同一段完整证据，保留前后两秒余量。",
      subtitleHighlights: `• ${hook}\n• 过程透明且可核验`,
      complianceChecklist: "核对事实、证据来源与素材授权。"
    },
    ...overrides
  };
}

function plan() {
  return {
    batchId: "BATCH-HOOK",
    testVariable: "hook",
    items: [item(0), item(1), item(2)]
  };
}

function variablePlan(variable) {
  const config = variable === "claim"
    ? { batchId: "BATCH-CLAIM", testVariable: "sellingPoint", label: "核心主张", values: ["主张一", "主张二", "主张三"] }
    : { batchId: "BATCH-SCENE", testVariable: "scene", label: "拍摄场景", values: ["门店入口", "操作台前", "交付现场"] };
  return {
    batchId: config.batchId,
    testVariable: config.testVariable,
    items: config.values.map((value, index) => {
      const entry = item(index);
      entry.id = index === 0 ? `${config.batchId}-B00` : `${config.batchId}-A${String(index).padStart(2, "0")}`;
      entry.singleVariable = config.label;
      entry.variant = value;
      entry.hook = "统一前三秒钩子";
      entry.coreClaim = variable === "claim" ? value : "统一可核验主张";
      entry.scene = variable === "scene" ? value : "统一拍摄场景";
      entry.production = {
        spokenScript: `${entry.hook}\n随后进入${entry.coreClaim}的证据`,
        storyboard: `0–3 秒｜${entry.scene}结果近景｜${entry.hook}｜单一焦点`,
        shootingTask: `测试编号：${entry.id}\n必拍证据：完整记录${entry.coreClaim}的条件、过程与结果`,
        editingNotes: "第三秒接入同一段完整证据，保留前后两秒余量。",
        subtitleHighlights: `• ${entry.hook}\n• ${entry.coreClaim}`,
        complianceChecklist: "核对事实、证据来源与素材授权。"
      };
      return entry;
    })
  };
}

function occurrenceCount(value, needle) {
  return value.split(needle).length - 1;
}

test("builds a deterministic wrap handoff with shared-shot and manual take slots", () => {
  const source = plan();
  const first = buildDirectorTakeHandoff(source);
  const second = buildDirectorTakeHandoff(source);
  assert.deepEqual(first, second);
  assert.equal(first.code, "ready");
  assert.equal(first.entries[0].id, "BATCH-HOOK-B00");
  assert.ok(first.sharedRules.length > 0);
  assert.deepEqual(first.sharedCaptureSlots.map((slot) => slot.label), ["完整证据全程", "关键细节特写", "场景与环境空镜", "结尾净版", "环境声与同步声", "剪辑余量"]);
  const output = directorTakeHandoffToText(first);
  assert.match(output, /批次收工接片单/u);
  assert.match(output, /当前批次共用边界/u);
  assert.match(output, /保险素材接片区/u);
  assert.match(output, /C01 · 完整证据全程/u);
  assert.match(output, /C06 · 剪辑余量/u);
  assert.match(output, /逐版本接片与最终剪辑映射/u);
  assert.match(output, /实际文件序号\/文件名：________/u);
  assert.match(output, /首选 Take：________/u);
  assert.match(output, /备选 Take：________/u);
  assert.match(output, /声音条\/同步声：________/u);
  assert.match(output, /连续性异常：________/u);
  assert.match(output, /缺失项：________/u);
  assert.match(output, /可交剪.*需补拍.*必须二选一/u);
  assert.match(output, /批次收工闸门/u);
  assert.match(output, /不扫描或读取媒体、不自动选择最佳 Take、不修改方案或制作状态/u);
  const sharedSection = output.slice(output.indexOf("## 保险素材接片区"), output.indexOf("## 逐版本接片与最终剪辑映射"));
  assert.doesNotMatch(sharedSection, /计划 B00 母版|先按 B00 完整拍/u);
  assert.equal(occurrenceCount(output, "实际文件序号/文件名：________"), first.sharedCaptureSlots.length + first.entries.length);
});

test("marks variable-sensitive insurance shots as per-version instead of pretending they are shareable", () => {
  const hookHandoff = buildDirectorTakeHandoff(plan());
  assert.ok(hookHandoff.sharedCaptureSlots.every((slot) => slot.sharingMode === "candidate"));

  const claimHandoff = buildDirectorTakeHandoff(variablePlan("claim"));
  assert.deepEqual(claimHandoff.sharedCaptureSlots.filter((slot) => slot.sharingMode === "per_version").map((slot) => slot.code), ["C01", "C02"]);
  const claimOutput = directorTakeHandoffToText(claimHandoff);
  assert.match(claimOutput, /C01 · 完整证据全程[\s\S]*?不得共用，必须逐版本归档/u);
  assert.match(claimOutput, /不得共用，已按版本归档/u);

  const sceneHandoff = buildDirectorTakeHandoff(variablePlan("scene"));
  assert.deepEqual(sceneHandoff.sharedCaptureSlots.filter((slot) => slot.sharingMode === "per_version").map((slot) => slot.code), ["C01", "C03", "C05"]);
  const sceneOutput = directorTakeHandoffToText(sceneHandoff);
  assert.match(sceneOutput, /C01 · 完整证据全程[\s\S]*?完整证据的条件、过程和结果通常依赖当前场景/u);
  assert.match(sceneOutput, /C03 · 场景与环境空镜[\s\S]*?场景本身是本轮变量/u);
  assert.match(sceneOutput, /C05 · 环境声与同步声[\s\S]*?环境声属于场景连续性/u);
  assert.match(sceneOutput, /不得共用，已归入对应版本/u);
  assert.match(sceneOutput, /基线：实际文件 ________；首选 Take ________；备选 Take ________；声音条 ________/u);
  assert.match(sceneOutput, /变体 2：实际文件 ________；首选 Take ________；备选 Take ________；声音条 ________/u);
});

test("keeps B00 first and emits every test id exactly once in plan order", () => {
  const source = plan();
  const output = directorTakeHandoffToText(buildDirectorTakeHandoff(source));
  const ids = source.items.map((entry) => entry.id);
  for (const id of ids) assert.equal(occurrenceCount(output, id), 1, id);
  const positions = ids.map((id) => output.indexOf(id));
  assert.ok(positions[0] >= 0);
  assert.ok(positions[0] < positions[1]);
  assert.ok(positions[1] < positions[2]);
  assert.match(output, /01 · BATCH-HOOK-B00 · 基线/u);
  assert.match(output, /02 · BATCH-HOOK-A01 · 变体/u);
  assert.match(output, /03 · BATCH-HOOK-A02 · 变体/u);
});

test("does not mutate the source plan while deriving or formatting the handoff", () => {
  const source = plan();
  const snapshot = structuredClone(source);
  const handoff = buildDirectorTakeHandoff(source);
  directorTakeHandoffToText(handoff);
  assert.deepEqual(source, snapshot);
});

test("fails closed for malformed, drifted, duplicate and non-B00 batches", () => {
  const tooSmall = plan();
  tooSmall.items = [tooSmall.items[0]];
  assert.throws(() => buildDirectorTakeHandoff(tooSmall), /2–20/u);

  const drifted = plan();
  drifted.items[1].scene = "另一处场景";
  assert.throws(() => buildDirectorTakeHandoff(drifted), /仍待修正|基线不同/u);

  const duplicate = plan();
  duplicate.items[2].id = duplicate.items[1].id;
  assert.throws(() => buildDirectorTakeHandoff(duplicate), /重复/u);

  const notB00 = plan();
  notB00.items[0].id = "BATCH-HOOK-BASE";
  notB00.items[0].production.shootingTask = "必拍证据：完整记录条件、过程与结果";
  assert.throws(() => buildDirectorTakeHandoff(notB00), /B00/u);

  const tampered = buildDirectorTakeHandoff(plan());
  tampered.entries[2].id = tampered.entries[1].id;
  assert.throws(() => directorTakeHandoffToText(tampered), /重复/u);

  const foreignBatch = buildDirectorTakeHandoff(plan());
  foreignBatch.entries[0].id = "FOREIGN-B00";
  assert.throws(() => directorTakeHandoffToText(foreignBatch), /编号顺序无效/u);

  const skippedNumber = buildDirectorTakeHandoff(plan());
  skippedNumber.entries[2].id = "BATCH-HOOK-A99";
  assert.throws(() => directorTakeHandoffToText(skippedNumber), /应为 BATCH-HOOK-A02/u);

  const swappedType = buildDirectorTakeHandoff(plan());
  swappedType.entries[0].type = "变体";
  assert.throws(() => directorTakeHandoffToText(swappedType), /类型必须为基线/u);

  const reshootIdentity = buildDirectorTakeHandoff(plan());
  reshootIdentity.entries[1].requiresReshoot = false;
  assert.throws(() => directorTakeHandoffToText(reshootIdentity), /补拍身份/u);

  const sharedSlot = buildDirectorTakeHandoff(plan());
  sharedSlot.sharedCaptureSlots[0].label = "模糊共用素材";
  assert.throws(() => directorTakeHandoffToText(sharedSlot), /已被篡改/u);

  const changedInstruction = buildDirectorTakeHandoff(plan());
  changedInstruction.sharedCaptureSlots[0].instruction = "允许自动跨版本共用";
  assert.throws(() => directorTakeHandoffToText(changedInstruction), /已被篡改/u);
});
