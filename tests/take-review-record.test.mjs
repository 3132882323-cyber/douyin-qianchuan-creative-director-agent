import test from "node:test";
import assert from "node:assert/strict";
import { buildDirectorTakeReview } from "../src/director-take-review.js";
import {
  TAKE_REVIEW_CHECKS,
  assessTakeReviewRecord,
  createTakeReviewRecord,
  deriveTakeReviewFollowUps,
  sanitizeTakeReviewRecord,
  summarizeTakeReviewBatch,
  summarizeTakeReviewHistory,
  takeReviewBatchHandoffToText,
  takeReviewFollowUpsToText,
  takeReviewPlanFingerprint,
  takeReviewRecordSnapshot,
  takeReviewVersionFingerprint
} from "../src/take-review-record.js";

const PROJECT_ID = "prj_12345678";
const NOW = "2026-09-02T01:00:00.000Z";

function planItem(index) {
  const id = index === 0 ? "TAKE-BATCH-B00" : `TAKE-BATCH-A${String(index).padStart(2, "0")}`;
  const hook = index === 0 ? "先看结果" : "别急着下结论";
  return {
    id,
    type: index === 0 ? "基线" : "变体",
    baselineCreative: "历史素材 A",
    singleVariable: "前三秒钩子",
    variant: hook,
    audience: "首次到店用户",
    hook,
    coreClaim: "过程透明且可核验",
    scene: "门店入口",
    hypothesis: "只改钩子",
    fixedElements: "演员、机位、光线、证据条件、时长与行动引导",
    observationMetrics: "CTR、ROI",
    minSpend: 300,
    stopCondition: "达到最低消耗后判断",
    successAction: "保留有效变量",
    production: {
      spokenScript: `${hook}\n随后进入完整证据`,
      storyboard: `0–3 秒｜结果近景｜${hook}｜单一焦点`,
      shootingTask: `测试编号：${id}\n必拍证据：完整记录条件、过程与结果`,
      editingNotes: "第三秒接入同一证据段，动作前后各保留两秒余量。",
      subtitleHighlights: `• ${hook}\n• 完整过程证据`,
      complianceChecklist: "核对事实、证据来源与素材授权。"
    }
  };
}

function samplePlan() {
  return { generatedAt: NOW, batchId: "TAKE-BATCH", testVariable: "hook", items: [planItem(0), planItem(1)] };
}

function version(plan, index) {
  const item = plan.items[index];
  return {
    id: `${PROJECT_ID}:${item.id}`,
    projectId: PROJECT_ID,
    testId: item.id,
    batchId: plan.batchId,
    sourceGeneratedAt: plan.generatedAt,
    primaryVariable: item.singleVariable,
    baselineCreative: item.baselineCreative,
    minSpend: item.minSpend,
    planItem: structuredClone(item)
  };
}

function passingChecks() {
  return TAKE_REVIEW_CHECKS.map(({ code }) => ({ code, status: "pass" }));
}

function draft(overrides = {}) {
  return {
    expectedRevision: 0,
    materialCode: "CAM1-0042",
    takeNumber: "Take 03",
    checks: passingChecks(),
    outcome: "keep",
    handoffRole: "primary",
    issueTimecode: "",
    nextCorrection: "",
    ownerRole: "none",
    ...overrides
  };
}

function createFor(plan, index, overrides = {}, options = {}) {
  return createTakeReviewRecord({
    projectId: PROJECT_ID,
    version: version(plan, index),
    plan,
    review: buildDirectorTakeReview(plan, { itemIndex: index }),
    draft: draft(overrides),
    existing: options.existing || [],
    id: options.id,
    now: options.now || NOW,
    randomUUID: () => options.uuid || `${index + 1}2345678-1234-1234-1234-123456789abc`
  });
}

test("stores only an explicit manual verdict and all five ordered checks", () => {
  const plan = samplePlan();
  const record = createFor(plan, 0);
  assert.equal(record.outcome, "keep");
  assert.equal(record.handoffRole, "primary");
  assert.deepEqual(record.checks.map(({ code }) => code), TAKE_REVIEW_CHECKS.map(({ code }) => code));
  assert.equal(record.revision, 1);
  assert.match(record.source.planFingerprint, /^take-plan:[0-9a-f]{8}$/u);
  assert.equal("media" in record, false);
  assert.throws(() => createFor(plan, 0, { outcome: "" }), /人工结论/u);
  assert.throws(() => createFor(plan, 0, { checks: [] }), /五项快检/u);
});

test("blocks keep and handoff roles when any check has an issue", () => {
  const plan = samplePlan();
  const checks = passingChecks();
  checks[2] = { ...checks[2], status: "issue" };
  assert.throws(() => createFor(plan, 0, { checks }), /不能保留/u);
  assert.throws(() => createFor(plan, 0, { checks, outcome: "reshoot", handoffRole: "none" }), /时间码/u);
  const reshoot = createFor(plan, 0, {
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:02.4",
    nextCorrection: "补拍证据转场",
    ownerRole: "director"
  });
  assert.equal(reshoot.outcome, "reshoot");
});

test("requires a named action owner for hold without inventing a verdict", () => {
  const plan = samplePlan();
  assert.throws(() => createFor(plan, 0, { outcome: "hold", handoffRole: "none" }), /核实动作/u);
  const held = createFor(plan, 0, { outcome: "hold", handoffRole: "none", nextCorrection: "制片确认肖像授权", ownerRole: "compliance" });
  assert.equal(held.issueTimecode, "");
  assert.equal(held.ownerRole, "compliance");
});

test("uses a revision CAS and rejects duplicate manual material/take identities", () => {
  const plan = samplePlan();
  const first = createFor(plan, 0);
  assert.throws(() => createFor(plan, 0, {}, { existing: [first], uuid: "92345678-1234-1234-1234-123456789abc" }), /已存在/u);
  assert.throws(() => createFor(plan, 0, { expectedRevision: 0, takeNumber: "Take 04" }, { existing: [first], id: first.id }), /其他页面更新/u);
  const updated = createFor(plan, 0, { expectedRevision: 1, takeNumber: "Take 04" }, {
    existing: [first],
    id: first.id,
    now: "2026-09-02T01:01:00.000Z"
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, first.createdAt);
});

test("marks records stale when the saved plan or synced version changes", () => {
  const plan = samplePlan();
  const originalVersion = version(plan, 0);
  const review = buildDirectorTakeReview(plan, { itemIndex: 0 });
  const record = createFor(plan, 0);
  assert.equal(assessTakeReviewRecord(record, { plan, version: originalVersion, review }).current, true);
  const changed = structuredClone(plan);
  changed.items[0].fixedElements = "机位、光线和行动引导";
  const assessment = assessTakeReviewRecord(record, {
    plan: changed,
    version: version(changed, 0),
    review: buildDirectorTakeReview(changed, { itemIndex: 0 })
  });
  assert.equal(assessment.current, false);
  assert.ok(assessment.reasons.length >= 1);
  assert.throws(() => createTakeReviewRecord({
    id: record.id,
    projectId: PROJECT_ID,
    version: version(changed, 0),
    plan: changed,
    review: buildDirectorTakeReview(changed, { itemIndex: 0 }),
    draft: draft({ expectedRevision: record.revision }),
    existing: [record],
    now: "2026-09-02T01:02:00.000Z"
  }), /旧过条记录只读/u);
});

test("fingerprints are deterministic, source-sensitive and input-safe", () => {
  const plan = samplePlan();
  const snapshot = structuredClone(plan);
  assert.equal(takeReviewPlanFingerprint(plan), takeReviewPlanFingerprint(structuredClone(plan)));
  assert.equal(takeReviewVersionFingerprint(version(plan, 0)), takeReviewVersionFingerprint(version(plan, 0)));
  plan.items[0].hook = "新的钩子";
  assert.notEqual(takeReviewPlanFingerprint(plan), takeReviewPlanFingerprint(snapshot));
  assert.deepEqual(snapshot, samplePlan());
});

test("opens handoff only after every version has one explicit current primary", () => {
  const plan = samplePlan();
  const first = createFor(plan, 0, { materialCode: "B00-CAM1", takeNumber: "Take 01" }, { uuid: "12345678-1234-1234-1234-123456789abc" });
  const partial = summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records: [first]
  });
  assert.equal(partial.ready, false);
  assert.equal(partial.label, "过条中");
  const second = createFor(plan, 1, { materialCode: "A01-CAM1", takeNumber: "Take 02" }, {
    existing: [first],
    uuid: "22345678-1234-1234-1234-123456789abc"
  });
  const ready = summarizeTakeReviewBatch({ ...partial, plan, versions: [version(plan, 0), version(plan, 1)], reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })], records: [first, second] });
  assert.equal(ready.ready, true);
  assert.equal(ready.primaryCount, 2);
  const text = takeReviewBatchHandoffToText({ projectName: "秋季素材", summary: ready });
  assert.match(text, /B00-CAM1 · Take 01/u);
  assert.match(text, /A01-CAM1 · Take 02/u);
  assert.match(text, /不代表系统自动选片/u);
});

test("uses immutable Take creation order so editing an older record cannot change the handoff gate", () => {
  const plan = samplePlan();
  const checks = passingChecks();
  checks[0] = { ...checks[0], status: "issue" };
  const oldReshoot = createFor(plan, 0, {
    materialCode: "B00-OLD",
    takeNumber: "Take 01",
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.5",
    nextCorrection: "重拍首帧",
    ownerRole: "director"
  }, { now: "2026-09-02T01:00:00.000Z", uuid: "32345678-1234-1234-1234-123456789abc" });
  const currentPrimary = createFor(plan, 0, { materialCode: "B00-NEW", takeNumber: "Take 02" }, {
    existing: [oldReshoot],
    now: "2026-09-02T01:01:00.000Z",
    uuid: "42345678-1234-1234-1234-123456789abc"
  });
  const variantPrimary = createFor(plan, 1, { materialCode: "A01-NEW", takeNumber: "Take 02" }, {
    existing: [oldReshoot, currentPrimary],
    now: "2026-09-02T01:01:00.000Z",
    uuid: "52345678-1234-1234-1234-123456789abc"
  });
  const editedOld = createFor(plan, 0, {
    expectedRevision: oldReshoot.revision,
    materialCode: oldReshoot.materialCode,
    takeNumber: oldReshoot.takeNumber,
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.7",
    nextCorrection: "首帧仍不可用",
    ownerRole: "director"
  }, {
    id: oldReshoot.id,
    existing: [oldReshoot, currentPrimary, variantPrimary],
    now: "2026-09-02T01:03:00.000Z"
  });
  const summary = summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records: [editedOld, currentPrimary, variantPrimary]
  });
  assert.equal(summary.entries[0].latestRecord.id, currentPrimary.id);
  assert.equal(summary.ready, true);
});

test("uses a monotonic created order when timestamps tie or the device clock moves backwards", () => {
  const plan = samplePlan();
  const first = createFor(plan, 0, { materialCode: "B00-PRIMARY", takeNumber: "Take 01" }, {
    now: "2026-09-02T01:00:00.000Z",
    uuid: "e2345678-1234-1234-1234-123456789abc"
  });
  const checks = passingChecks();
  checks[0] = { ...checks[0], status: "issue" };
  const sameTimeFailure = createFor(plan, 0, {
    materialCode: "B00-FAIL",
    takeNumber: "Take 02",
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.4",
    nextCorrection: "重拍清晰首帧",
    ownerRole: "camera"
  }, {
    existing: [first],
    now: "2026-09-02T01:00:00.000Z",
    uuid: "f2345678-1234-1234-1234-123456789abc"
  });
  const variant = createFor(plan, 1, { materialCode: "A01-PRIMARY", takeNumber: "Take 01" }, {
    existing: [first, sameTimeFailure],
    now: "2026-09-02T01:00:00.000Z",
    uuid: "12345679-1234-1234-1234-123456789abc"
  });
  const summarize = (records) => summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records
  });
  const blocked = summarize([first, sameTimeFailure, variant]);
  assert.equal(first.createdOrder, 1);
  assert.equal(sameTimeFailure.createdOrder, 2);
  assert.equal(blocked.entries[0].latestRecord.id, sameTimeFailure.id);
  assert.equal(blocked.ready, false);

  const clockRollbackSuccess = createFor(plan, 0, {
    materialCode: "B00-RECOVERED",
    takeNumber: "Take 03",
    handoffRole: "none"
  }, {
    existing: [first, sameTimeFailure, variant],
    now: "2026-09-01T23:00:00.000Z",
    uuid: "22345679-1234-1234-1234-123456789abc"
  });
  const recovered = summarize([first, sameTimeFailure, variant, clockRollbackSuccess]);
  assert.equal(clockRollbackSuccess.createdOrder, 3);
  assert.equal(recovered.entries[0].latestRecord.id, clockRollbackSuccess.id);
  assert.equal(recovered.ready, true);

  const editedFailure = createFor(plan, 0, {
    expectedRevision: sameTimeFailure.revision,
    materialCode: sameTimeFailure.materialCode,
    takeNumber: sameTimeFailure.takeNumber,
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.5",
    nextCorrection: "继续补拍清晰首帧",
    ownerRole: "camera"
  }, {
    id: sameTimeFailure.id,
    existing: [first, sameTimeFailure, variant, clockRollbackSuccess],
    now: "2026-09-01T22:00:00.000Z"
  });
  assert.equal(editedFailure.createdOrder, sameTimeFailure.createdOrder);
  assert.equal(editedFailure.updatedAt, sameTimeFailure.updatedAt);
  assert.equal(summarize([first, editedFailure, variant, clockRollbackSuccess]).entries[0].latestRecord.id, clockRollbackSuccess.id);

  const { createdOrder: _ignored, ...legacy } = first;
  assert.equal("createdOrder" in sanitizeTakeReviewRecord(legacy), false);
});

test("fails closed when multiple legacy Takes have no reliable creation order", () => {
  const plan = samplePlan();
  const primary = createFor(plan, 0, { materialCode: "B00-PRIMARY", takeNumber: "Take 01" }, {
    now: "2026-09-02T01:00:00.000Z",
    uuid: "32345679-1234-1234-1234-123456789abc"
  });
  const checks = passingChecks();
  checks[0] = { ...checks[0], status: "issue" };
  const failed = createFor(plan, 0, {
    materialCode: "B00-FAILED",
    takeNumber: "Take 02",
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.3",
    nextCorrection: "重拍清晰首帧",
    ownerRole: "camera"
  }, {
    existing: [primary],
    now: "2026-09-02T01:01:00.000Z",
    uuid: "42345679-1234-1234-1234-123456789abc"
  });
  const variant = createFor(plan, 1, { materialCode: "A01-PRIMARY", takeNumber: "Take 01" }, {
    existing: [primary, failed],
    uuid: "52345679-1234-1234-1234-123456789abc"
  });
  const withoutOrder = (record) => {
    const { createdOrder: _ignored, ...legacy } = record;
    return legacy;
  };
  const legacyRecords = [withoutOrder(primary), withoutOrder(failed), variant];
  const summarize = (records) => summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records
  });
  const ambiguous = summarize(legacyRecords);
  assert.equal(ambiguous.ready, false);
  assert.equal(ambiguous.code, "order_ambiguous");
  assert.equal(ambiguous.orderingAmbiguousCount, 1);
  assert.match(ambiguous.blockers.join("；"), /缺少可靠创建顺序/u);
  const [followUp] = deriveTakeReviewFollowUps(ambiguous);
  assert.equal(followUp.status, "order_ambiguous");
  assert.equal(followUp.ambiguousRecordCount, 2);
  assert.match(followUp.prompt, /登记一条新的当前结论/u);

  const confirmedLatest = createFor(plan, 0, {
    materialCode: "B00-CONFIRMED",
    takeNumber: "Take 03",
    handoffRole: "none"
  }, {
    existing: legacyRecords,
    uuid: "62345679-1234-1234-1234-123456789abc"
  });
  const recovered = summarize([...legacyRecords, confirmedLatest]);
  assert.equal(recovered.entries[0].latestRecord.id, confirmedLatest.id);
  assert.equal(recovered.orderingAmbiguousCount, 0);
  assert.equal(recovered.ready, true);
});

test("derives the on-set follow-up list by action priority and then plan order", () => {
  const plan = { ...samplePlan(), items: [planItem(0), planItem(1), planItem(2), planItem(3)] };
  const needsPrimary = createFor(plan, 0, {
    materialCode: "B00-CAM1",
    takeNumber: "Take 01",
    handoffRole: "none"
  }, { uuid: "62345678-1234-1234-1234-123456789abc" });
  const checks = passingChecks();
  checks[1] = { ...checks[1], status: "issue" };
  const reshoot = createFor(plan, 2, {
    materialCode: "A02-CAM2",
    takeNumber: "Take 04",
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:03.2",
    nextCorrection: "补录完整口播钩子",
    ownerRole: "talent"
  }, { existing: [needsPrimary], uuid: "72345678-1234-1234-1234-123456789abc" });
  const held = createFor(plan, 3, {
    materialCode: "A03-CAM1",
    takeNumber: "Take 02",
    outcome: "hold",
    handoffRole: "none",
    nextCorrection: "现场确认授权证明",
    ownerRole: "compliance"
  }, { existing: [needsPrimary, reshoot], uuid: "82345678-1234-1234-1234-123456789abc" });
  const summary = summarizeTakeReviewBatch({
    plan,
    versions: plan.items.map((_, index) => version(plan, index)),
    reviews: plan.items.map((_, index) => buildDirectorTakeReview(plan, { itemIndex: index })),
    records: [needsPrimary, reshoot, held]
  });
  const followUps = deriveTakeReviewFollowUps(summary);
  assert.deepEqual(followUps.map(({ status, testId }) => [status, testId]), [
    ["hold", plan.items[3].id],
    ["reshoot", plan.items[2].id],
    ["unreviewed", plan.items[1].id],
    ["needs_primary", plan.items[0].id]
  ]);
  assert.deepEqual(
    (({ materialCode, takeNumber, issueTimecode, ownerRole, nextCorrection }) => ({ materialCode, takeNumber, issueTimecode, ownerRole, nextCorrection }))(followUps[1]),
    {
      materialCode: "A02-CAM2",
      takeNumber: "Take 04",
      issueTimecode: "00:03.2",
      ownerRole: "talent",
      nextCorrection: "补录完整口播钩子"
    }
  );
  assert.equal(followUps[2].hasManualRecord, false);
  assert.match(followUps[2].prompt, /人工过条记录/u);
  assert.match(followUps[3].prompt, /尚未人工指定唯一首选/u);
});

test("uses only the latest current-source record so stale and closed failures do not reopen work", () => {
  const originalPlan = samplePlan();
  const staleHold = createFor(originalPlan, 1, {
    materialCode: "A01-OLD",
    takeNumber: "Take 01",
    outcome: "hold",
    handoffRole: "none",
    nextCorrection: "旧方案要求停机",
    ownerRole: "director"
  }, { now: "2026-09-02T00:58:00.000Z", uuid: "92345678-1234-1234-1234-123456789abc" });
  const plan = structuredClone(originalPlan);
  plan.items[1].fixedElements = `${plan.items[1].fixedElements}、新版景别`;
  const checks = passingChecks();
  checks[0] = { ...checks[0], status: "issue" };
  const oldFailure = createFor(plan, 0, {
    materialCode: "B00-OLD",
    takeNumber: "Take 01",
    checks,
    outcome: "reshoot",
    handoffRole: "none",
    issueTimecode: "00:00.5",
    nextCorrection: "补拍静音首帧",
    ownerRole: "director"
  }, { existing: [staleHold], now: "2026-09-02T01:00:00.000Z", uuid: "a2345678-1234-1234-1234-123456789abc" });
  const closed = createFor(plan, 0, {
    materialCode: "B00-NEW",
    takeNumber: "Take 02"
  }, { existing: [staleHold, oldFailure], now: "2026-09-02T01:01:00.000Z", uuid: "b2345678-1234-1234-1234-123456789abc" });
  const summary = summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records: [staleHold, oldFailure, closed]
  });
  const before = structuredClone(summary);
  const followUps = deriveTakeReviewFollowUps(summary);
  assert.deepEqual(followUps.map(({ testId, status }) => [testId, status]), [[plan.items[1].id, "unreviewed"]]);
  assert.equal(summary.entries[0].latestRecord.id, closed.id);
  assert.equal(summary.entries[1].staleRecords.length, 1);
  assert.deepEqual(summary, before);
  followUps[0].materialCode = "LOCAL-CHANGE";
  assert.deepEqual(summary, before);
});

test("formats an explicitly manual follow-up sheet and refuses ready or empty batches", () => {
  const plan = samplePlan();
  const held = createFor(plan, 0, {
    materialCode: "B00-CAM1",
    takeNumber: "Take 06",
    outcome: "hold",
    handoffRole: "none",
    nextCorrection: "制片核实演员授权",
    ownerRole: "producer"
  });
  const summary = summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records: [held]
  });
  const before = structuredClone(summary);
  const text = takeReviewFollowUpsToText({ projectName: "秋季素材", summary });
  assert.match(text, /现场待办 \/ 追拍单/u);
  assert.match(text, /人工登记素材：B00-CAM1 · Take 06/u);
  assert.match(text, /人工指定负责人：制片 \/ 场务/u);
  assert.match(text, /只整理当前版本结构和人工结论/u);
  assert.match(text, /不代表系统已经检查素材或给出自动结论/u);
  assert.deepEqual(summary, before);

  const first = createFor(plan, 0, { materialCode: "B00-READY", takeNumber: "Take 08" }, { uuid: "c2345678-1234-1234-1234-123456789abc" });
  const second = createFor(plan, 1, { materialCode: "A01-READY", takeNumber: "Take 03" }, {
    existing: [first],
    uuid: "d2345678-1234-1234-1234-123456789abc"
  });
  const ready = summarizeTakeReviewBatch({
    plan,
    versions: [version(plan, 0), version(plan, 1)],
    reviews: [buildDirectorTakeReview(plan, { itemIndex: 0 }), buildDirectorTakeReview(plan, { itemIndex: 1 })],
    records: [first, second]
  });
  assert.throws(() => takeReviewFollowUpsToText({ projectName: "秋季素材", summary: ready }), /不生成空的现场待办/u);
  assert.throws(() => takeReviewFollowUpsToText({
    projectName: "秋季素材",
    summary: { batchId: "TAKE-BATCH", ready: false, entries: [] }
  }), /没有可整理的现场待办/u);
});

test("sanitization removes unknown fields and enforces the local record size bound", () => {
  const record = createFor(samplePlan(), 0);
  assert.equal("unknown" in sanitizeTakeReviewRecord({ ...record, unknown: "drop" }), false);
  assert.equal(takeReviewRecordSnapshot({ ...record, unknown: "drop" }), takeReviewRecordSnapshot(record));
  assert.notEqual(takeReviewRecordSnapshot({ ...record, materialCode: "另一条人工结论" }), takeReviewRecordSnapshot(record));
  assert.throws(() => sanitizeTakeReviewRecord({ ...record, nextCorrection: "修".repeat(501) }), /最多 500/u);
  assert.throws(() => createFor(samplePlan(), 0, { materialCode: "C:\\Users\\Director\\clip.mp4" }), /不要粘贴本机路径/u);
  assert.throws(() => createFor(samplePlan(), 0, { materialCode: "file:///Users/director/clip.mp4" }), /不要粘贴本机路径/u);
});

test("groups historical sources without merging reused batch ids", () => {
  const currentPlan = samplePlan();
  const priorPlanA = structuredClone(currentPlan);
  priorPlanA.generatedAt = "2026-08-30T01:00:00.000Z";
  const priorPlanB = structuredClone(currentPlan);
  priorPlanB.generatedAt = "2026-08-31T01:00:00.000Z";
  priorPlanB.items[0].hook = "另一版旧钩子";
  priorPlanB.items[0].variant = "另一版旧钩子";
  const current = createFor(currentPlan, 0, { materialCode: "CURRENT" }, { uuid: "a2345678-1234-1234-1234-123456789abc" });
  const priorA = createFor(priorPlanA, 0, { materialCode: "OLD-A" }, {
    existing: [current],
    now: "2026-08-30T02:00:00.000Z",
    uuid: "b2345678-1234-1234-1234-123456789abc"
  });
  const priorASecondVersion = createFor(priorPlanA, 1, { materialCode: "OLD-A-SECOND" }, {
    existing: [current, priorA],
    now: "2026-08-30T03:00:00.000Z",
    uuid: "b3345678-1234-1234-1234-123456789abc"
  });
  const priorB = createFor(priorPlanB, 0, { materialCode: "OLD-B" }, {
    existing: [current, priorA, priorASecondVersion],
    now: "2026-08-31T02:00:00.000Z",
    uuid: "c2345678-1234-1234-1234-123456789abc"
  });
  const mismatchedBatch = {
    ...current,
    id: "take_d2345678-1234-1234-1234-123456789abc",
    source: { ...current.source, batchId: "OTHER-BATCH" },
    materialCode: "MISMATCHED-BATCH"
  };
  const summary = summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: currentPlan.batchId,
    currentPlanFingerprint: takeReviewPlanFingerprint(currentPlan),
    records: [current, priorA, priorASecondVersion, priorB, mismatchedBatch]
  });
  assert.equal(summary.totalCount, 5);
  assert.equal(summary.currentSourceCount, 1);
  assert.equal(summary.historicalCount, 4);
  assert.equal(summary.groups.length, 3);
  assert.equal(summary.groups.filter((group) => group.batchId === currentPlan.batchId).length, 2);
  assert.ok(summary.groups.some((group) => group.batchId === "OTHER-BATCH"
    && group.planFingerprint === current.source.planFingerprint));
  assert.notEqual(summary.groups[0].planFingerprint, summary.groups[1].planFingerprint);
  const priorAGroup = summary.groups.find((group) => group.planFingerprint === priorA.source.planFingerprint);
  assert.equal(priorAGroup.recordCount, 2);
  assert.equal(priorAGroup.versionCount, 2);
  assert.equal(priorAGroup.latestUpdatedAt, priorASecondVersion.updatedAt);
  assert.equal(summary.groups[0].batchId, "OTHER-BATCH");
  assert.ok(summary.groups.findIndex((group) => group.planFingerprint === priorB.source.planFingerprint)
    < summary.groups.findIndex((group) => group.planFingerprint === priorA.source.planFingerprint));
  assert.equal(summary.capacityLimit, 1000);
  assert.equal(summary.capacityWarning, false);
  assert.throws(() => summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: currentPlan.batchId,
    currentPlanFingerprint: takeReviewPlanFingerprint(currentPlan),
    records: [{ ...current, projectId: "prj_87654321" }]
  }), /其他项目/u);
});

test("warns before the per-project Take limit without deleting records", () => {
  const plan = samplePlan();
  const base = createFor(plan, 0, { materialCode: "CAPACITY" }, {
    uuid: "d2345678-1234-1234-1234-123456789abc"
  });
  const records = Array.from({ length: 1000 }, (_, index) => ({
    ...base,
    id: `take_cap-${String(index).padStart(8, "0")}`,
    source: { ...base.source, planFingerprint: "take-plan:deadbeef" },
    createdOrder: index + 1
  }));
  const currentPlanFingerprint = takeReviewPlanFingerprint(plan);
  const before = structuredClone(records);
  const belowThreshold = summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: plan.batchId,
    currentPlanFingerprint,
    records: records.slice(0, 799)
  });
  const atThreshold = summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: plan.batchId,
    currentPlanFingerprint,
    records: records.slice(0, 800)
  });
  const atLimit = summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: plan.batchId,
    currentPlanFingerprint,
    records
  });
  assert.equal(belowThreshold.capacityWarning, false);
  assert.equal(atThreshold.capacityWarningAt, 800);
  assert.equal(atThreshold.capacityWarning, true);
  assert.equal(atThreshold.totalCount, 800);
  assert.equal(atThreshold.historicalCount, 800);
  assert.equal(atLimit.totalCount, 1000);
  assert.equal(atLimit.capacityWarning, true);
  assert.throws(() => summarizeTakeReviewHistory({
    projectId: PROJECT_ID,
    currentBatchId: plan.batchId,
    currentPlanFingerprint,
    records: [...records, { ...records[0], id: "take_cap-overflow" }]
  }), /最多 1000/u);
  assert.deepEqual(records, before);
});
