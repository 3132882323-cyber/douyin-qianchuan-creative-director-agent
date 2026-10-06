import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_DB_VERSION,
  createProjectRepository,
  upgradeProjectDatabase
} from "../src/project-store.js";
import {
  createProjectRecord,
  versionRecordsFromPlan
} from "../src/project-model.js";
import { creativePlanDependencyFingerprint } from "../src/core.js";
import { createProductionStatus } from "../src/production-status.js";
import {
  TAKE_REVIEW_CHECKS,
  takeReviewPlanFingerprint,
  takeReviewRecordSnapshot
} from "../src/take-review-record.js";

const PROJECT_ID = "prj_12345678";
const BATCH_ID = "TAKE-BATCH";
const TIMES = Object.freeze({
  created: "2026-09-02T01:00:00.000Z",
  first: "2026-09-02T02:00:00.000Z",
  second: "2026-09-02T03:00:00.000Z",
  third: "2026-09-02T04:00:00.000Z",
  fourth: "2026-09-02T05:00:00.000Z",
  fifth: "2026-09-02T06:00:00.000Z"
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function valueAtPath(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((entry) => valueAtPath(value, entry));
  return String(keyPath).split(".").reduce((current, key) => current?.[key], value);
}

function sameKey(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class FakeIndex {
  constructor(transaction, storeName, keyPath) {
    this.transaction = transaction;
    this.storeName = storeName;
    this.keyPath = keyPath;
  }

  getAll(query) {
    return this.transaction.request(() => [...this.transaction.working.get(this.storeName).values()]
      .filter((entry) => query === undefined || sameKey(valueAtPath(entry, this.keyPath), query))
      .map(clone));
  }
}

class FakeObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
  }

  get(key) {
    return this.transaction.request(() => clone(this.transaction.working.get(this.name).get(key)));
  }

  getAll() {
    return this.transaction.request(() => [...this.transaction.working.get(this.name).values()].map(clone));
  }

  put(value) {
    return this.transaction.request(() => {
      const record = clone(value);
      const key = this.name === "meta" ? record.key : record.id;
      if (key === undefined) throw new Error(`missing key for ${this.name}`);
      this.transaction.working.get(this.name).set(key, record);
      return key;
    });
  }

  delete(key) {
    return this.transaction.request(() => this.transaction.working.get(this.name).delete(key));
  }

  clear() {
    return this.transaction.request(() => this.transaction.working.get(this.name).clear());
  }

  index(name) {
    const keyPath = {
      projectId: "projectId",
      versionId: "source.testId",
      batchId: "source.batchId",
      updatedAt: "updatedAt"
    }[name];
    if (!keyPath) throw new Error(`unexpected index: ${this.name}.${name}`);
    return new FakeIndex(this.transaction, this.name, keyPath);
  }
}

class FakeTransaction {
  constructor(database, storeNames, mode) {
    this.database = database;
    this.storeNames = storeNames;
    this.mode = mode;
    this.working = new Map();
    this.pending = 0;
    this.generation = 0;
    this.waitingRequests = [];
    this.active = false;
    this.settled = false;
    this.aborted = false;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  get store() {
    if (this.storeNames.length !== 1) return undefined;
    return this.objectStore(this.storeNames[0]);
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`store ${name} is outside this transaction`);
    return new FakeObjectStore(this, name);
  }

  activate() {
    if (this.active || this.settled) return;
    this.active = true;
    for (const name of this.storeNames) {
      this.working.set(name, new Map([...this.database.stores.get(name)].map(([key, value]) => [key, clone(value)])));
    }
    for (const run of this.waitingRequests.splice(0)) run();
    this.scheduleCompletion();
  }

  request(operation) {
    if (this.settled || this.aborted) return Promise.reject(new Error("transaction inactive"));
    this.pending += 1;
    this.generation += 1;
    return new Promise((resolve, reject) => {
      const run = () => queueMicrotask(() => {
        try {
          resolve(operation());
        } catch (error) {
          this.aborted = true;
          reject(error);
          this.fail(error);
        } finally {
          this.pending -= 1;
          this.scheduleCompletion();
        }
      });
      if (this.active) run();
      else this.waitingRequests.push(run);
    });
  }

  fail(error) {
    if (this.settled) return;
    this.settled = true;
    this.rejectDone(error);
    this.database.finishTransaction(this);
  }

  scheduleCompletion() {
    if (!this.active) return;
    const generation = this.generation;
    setTimeout(() => {
      if (this.settled || this.pending || generation !== this.generation) return;
      this.settled = true;
      if (!this.aborted) {
        if (this.mode === "readwrite") {
          for (const name of this.storeNames) this.database.stores.set(name, this.working.get(name));
        }
        this.resolveDone();
        this.database.finishTransaction(this);
      }
    }, 0);
  }
}

class FakeDatabase {
  constructor(seed = {}) {
    this.stores = new Map(["projects", "versions", "results", "takeReviews", "meta"].map((name) => {
      const keyName = name === "meta" ? "key" : "id";
      return [name, new Map((seed[name] || []).map((entry) => [entry[keyName], clone(entry)]))];
    }));
    this.transactions = [];
    this.transactionLog = [];
  }

  transaction(storeNames, mode = "readonly") {
    const names = Array.isArray(storeNames) ? [...storeNames] : [storeNames];
    for (const name of names) if (!this.stores.has(name)) throw new Error(`unexpected store: ${name}`);
    const transaction = new FakeTransaction(this, names, mode);
    this.transactions.push(transaction);
    this.transactionLog.push({ names, mode });
    if (this.transactions.length === 1) transaction.activate();
    return transaction;
  }

  finishTransaction(transaction) {
    const index = this.transactions.indexOf(transaction);
    if (index >= 0) this.transactions.splice(index, 1);
    this.transactions[0]?.activate();
  }

  async operation(storeName, mode, callback) {
    const transaction = this.transaction(storeName, mode);
    const result = await callback(transaction.store);
    await transaction.done;
    return result;
  }

  get(storeName, key) {
    return this.operation(storeName, "readonly", (store) => store.get(key));
  }

  getAll(storeName) {
    return this.operation(storeName, "readonly", (store) => store.getAll());
  }

  getAllFromIndex(storeName, indexName, query) {
    return this.operation(storeName, "readonly", (store) => store.index(indexName).getAll(query));
  }

  put(storeName, value) {
    return this.operation(storeName, "readwrite", (store) => store.put(value));
  }

  delete(storeName, key) {
    return this.operation(storeName, "readwrite", (store) => store.delete(key));
  }
}

class FakeUpgradeStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.indexes = new Map();
  }

  createIndex(name, keyPath) {
    if (this.indexes.has(name)) throw new Error(`duplicate index: ${name}`);
    this.indexes.set(name, keyPath);
  }
}

class FakeUpgradeDatabase {
  constructor(existingNames = []) {
    this.stores = new Map(existingNames.map((name) => [name, new FakeUpgradeStore(name, name === "meta" ? "key" : "id")]));
  }

  createObjectStore(name, { keyPath }) {
    if (this.stores.has(name)) throw new Error(`duplicate store: ${name}`);
    const store = new FakeUpgradeStore(name, keyPath);
    this.stores.set(name, store);
    return store;
  }
}

function planItem(index, hook = index === 0 ? "先看结果" : "别急着下结论") {
  const id = index === 0 ? `${BATCH_ID}-B00` : `${BATCH_ID}-A${String(index).padStart(2, "0")}`;
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
    hypothesis: "只修改钩子并观察结果",
    fixedElements: "演员、机位、光线、证据条件、时长与行动引导",
    observationMetrics: "完播率、互动率与人工内容复核",
    minSpend: 300,
    stopCondition: "达到最低观察量后再判断",
    successAction: "保留有效变量并进入下一轮",
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

function samplePlan({ generatedAt = TIMES.created, secondHook = "别急着下结论" } = {}) {
  return {
    generatedAt,
    version: "1.4.0",
    batchId: BATCH_ID,
    creativeTask: {},
    sourceSummary: { targetRoi: 1.5 },
    testVariable: "hook",
    items: [planItem(0), planItem(1, secondHook)],
    notice: "本地人工方案"
  };
}

function reviewDraft({ materialCode = "C001", takeNumber = "T01", handoffRole = "none", expectedRevision = 0 } = {}) {
  return {
    materialCode,
    takeNumber,
    checks: TAKE_REVIEW_CHECKS.map(({ code }) => ({ code, status: "pass" })),
    outcome: "keep",
    handoffRole,
    issueTimecode: "",
    nextCorrection: "",
    ownerRole: "none",
    expectedRevision
  };
}

function revisionSnapshot(records) {
  return records.map((record) => ({
    id: record.id,
    revision: record.revision,
    createdOrder: record.createdOrder || 0,
    contentSnapshot: takeReviewRecordSnapshot(record)
  }));
}

function withTakeReviewSnapshots(repository) {
  return {
    ...repository,
    async saveTakeReview(projectId, testId, draft, options = {}) {
      const visible = await repository.listTakeReviews(projectId, { testId });
      return repository.saveTakeReview(projectId, testId, draft, {
        ...options,
        expectedVersionRecords: revisionSnapshot(visible)
      });
    }
  };
}

function setup() {
  const creativeTask = { subject: "门店内容" };
  const requestedPlan = samplePlan();
  requestedPlan.dependencyFingerprint = creativePlanDependencyFingerprint(creativeTask, null, {
    testVariable: requestedPlan.testVariable,
    minSpend: requestedPlan.items[0].minSpend
  });
  const project = createProjectRecord({
    id: PROJECT_ID,
    name: "片场项目",
    now: TIMES.created,
    workspace: { creativePlan: requestedPlan, creativeTask }
  });
  const plan = project.workspace.creativePlan;
  const versions = versionRecordsFromPlan({
    projectId: project.id,
    plan,
    existingVersions: [],
    parentVersionId: null,
    now: TIMES.created
  });
  const database = new FakeDatabase({
    projects: [project],
    versions,
    meta: [{ key: "currentProjectId", value: project.id }]
  });
  const rawRepository = createProjectRepository(database);
  return { database, rawRepository, repository: withTakeReviewSnapshots(rawRepository), project, plan, versions };
}

function saveOptions(plan, now, randomUUID) {
  return {
    expectedPlanFingerprint: takeReviewPlanFingerprint(plan),
    expectedRoleConflict: null,
    now,
    randomUUID: () => randomUUID
  };
}

test("upgrades fresh and version-1 databases without recreating legacy stores", () => {
  assert.equal(PROJECT_DB_VERSION, 2);
  const fresh = new FakeUpgradeDatabase();
  upgradeProjectDatabase(fresh, 0);
  assert.deepEqual([...fresh.stores.keys()], ["projects", "versions", "results", "meta", "takeReviews"]);
  const freshTake = fresh.stores.get("takeReviews");
  assert.equal(freshTake.keyPath, "id");
  assert.equal(freshTake.indexes.get("projectId"), "projectId");
  assert.equal(freshTake.indexes.get("versionId"), "source.testId");
  assert.equal(freshTake.indexes.get("batchId"), "source.batchId");

  const upgraded = new FakeUpgradeDatabase(["projects", "versions", "results", "meta"]);
  upgradeProjectDatabase(upgraded, 1);
  assert.deepEqual([...upgraded.stores.keys()], ["projects", "versions", "results", "meta", "takeReviews"]);
});

test("saves, gets and filters local take reviews without changing production status", async () => {
  const { database, repository, project, plan, versions } = setup();
  const beforeStatus = clone(versions[0].productionStatus);
  const record = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ handoffRole: "primary" }),
    saveOptions(plan, TIMES.first, "11111111")
  );

  assert.equal(record.id, "take_11111111");
  assert.equal(record.revision, 1);
  assert.equal(record.source.batchId, BATCH_ID);
  assert.deepEqual((await repository.getProject(project.id)).workspace.creativePlan, plan);
  assert.equal((await repository.getProject(project.id)).updatedAt, TIMES.first);
  assert.deepEqual((await database.get("versions", versions[0].id)).productionStatus, beforeStatus);
  assert.deepEqual(await repository.listTakeReviews(project.id, { testId: versions[0].testId }), [record]);
  assert.deepEqual(await repository.listTakeReviews(project.id, { batchId: BATCH_ID }), [record]);
  assert.deepEqual(await repository.listTakeReviews(project.id, { testId: versions[1].testId }), []);
  await assert.rejects(
    repository.saveTakeReview(project.id, versions[1].testId, reviewDraft(), {
      ...saveOptions(plan, TIMES.second, "22222222"),
      expectedPlanFingerprint: "take-plan:00000000"
    }),
    /方案已变化/u
  );
  assert.equal((await repository.listTakeReviews(project.id)).length, 1);
});

test("enforces live Take limits, allows edits at capacity and reopens one slot after exact history deletion", async () => {
  const versionLimit = setup();
  const first = await versionLimit.rawRepository.saveTakeReview(
    versionLimit.project.id,
    versionLimit.versions[0].testId,
    reviewDraft({ materialCode: "LIMIT-01", takeNumber: "T01" }),
    { ...saveOptions(versionLimit.plan, TIMES.first, "limit-0001"), expectedVersionRecords: [] }
  );
  const versionStore = versionLimit.database.stores.get("takeReviews");
  for (let index = 2; index <= 19; index += 1) {
    const record = {
      ...first,
      id: `take_limit-${String(index).padStart(4, "0")}`,
      materialCode: `LIMIT-${String(index).padStart(2, "0")}`,
      takeNumber: `T${String(index).padStart(2, "0")}`,
      createdOrder: index
    };
    versionStore.set(record.id, clone(record));
  }
  const nineteenVisible = await versionLimit.rawRepository.listTakeReviews(versionLimit.project.id, {
    testId: versionLimit.versions[0].testId
  });
  const twentieth = await versionLimit.rawRepository.saveTakeReview(
    versionLimit.project.id,
    versionLimit.versions[0].testId,
    reviewDraft({ materialCode: "LIMIT-20", takeNumber: "T20" }),
    {
      ...saveOptions(versionLimit.plan, TIMES.second, "limit-0020"),
      expectedVersionRecords: revisionSnapshot(nineteenVisible)
    }
  );
  assert.equal(twentieth.materialCode, "LIMIT-20");
  const twentyVisible = await versionLimit.rawRepository.listTakeReviews(versionLimit.project.id, {
    testId: versionLimit.versions[0].testId
  });
  assert.equal(twentyVisible.length, 20);
  const projectBeforeVersionRejection = await versionLimit.rawRepository.getProject(versionLimit.project.id);
  await assert.rejects(versionLimit.rawRepository.saveTakeReview(
    versionLimit.project.id,
    versionLimit.versions[0].testId,
    reviewDraft({ materialCode: "LIMIT-21", takeNumber: "T21" }),
    {
      ...saveOptions(versionLimit.plan, TIMES.third, "limit-0021"),
      expectedVersionRecords: revisionSnapshot(twentyVisible)
    }
  ), /每个版本最多记录 20/u);
  assert.equal((await versionLimit.rawRepository.listTakeReviews(versionLimit.project.id)).length, 20);
  assert.equal((await versionLimit.rawRepository.getProject(versionLimit.project.id)).updatedAt, projectBeforeVersionRejection.updatedAt);

  const capacity = setup();
  const current = await capacity.rawRepository.saveTakeReview(
    capacity.project.id,
    capacity.versions[0].testId,
    reviewDraft({ materialCode: "CURRENT", takeNumber: "T01" }),
    { ...saveOptions(capacity.plan, TIMES.first, "capacity-current"), expectedVersionRecords: [] }
  );
  const capacityStore = capacity.database.stores.get("takeReviews");
  let releasableHistory;
  for (let index = 0; index < 999; index += 1) {
    const isReleasable = index === 0;
    const record = {
      ...current,
      id: `take_archive-${String(index).padStart(8, "0")}`,
      source: {
        ...current.source,
        batchId: isReleasable ? "ARCHIVE-ONE" : "ARCHIVE-BULK",
        testId: `ARCHIVE-${String(index).padStart(8, "0")}`,
        planFingerprint: isReleasable ? "take-plan:deadbeef" : "take-plan:cafebabe"
      },
      materialCode: `ARCHIVE-${String(index).padStart(4, "0")}`,
      takeNumber: "T01",
      handoffRole: "none",
      createdOrder: 1
    };
    capacityStore.set(record.id, clone(record));
    if (isReleasable) releasableHistory = record;
  }
  const projectBeforeCapacityRejection = await capacity.rawRepository.getProject(capacity.project.id);
  await assert.rejects(capacity.rawRepository.saveTakeReview(
    capacity.project.id,
    capacity.versions[1].testId,
    reviewDraft({ materialCode: "OVERFLOW", takeNumber: "T01" }),
    { ...saveOptions(capacity.plan, TIMES.second, "capacity-overflow"), expectedVersionRecords: [] }
  ), /单项目人工过条记录最多 1000/u);
  assert.equal((await capacity.rawRepository.listTakeReviews(capacity.project.id)).length, 1000);
  assert.equal((await capacity.rawRepository.getProject(capacity.project.id)).updatedAt, projectBeforeCapacityRejection.updatedAt);

  const edited = await capacity.rawRepository.saveTakeReview(
    capacity.project.id,
    capacity.versions[0].testId,
    reviewDraft({ materialCode: "CURRENT-EDITED", takeNumber: "T01", expectedRevision: current.revision }),
    {
      ...saveOptions(capacity.plan, TIMES.third, "unused-edit-id"),
      takeId: current.id,
      expectedRevision: current.revision,
      expectedVersionRecords: revisionSnapshot([current])
    }
  );
  assert.equal(edited.revision, 2);
  assert.equal((await capacity.rawRepository.listTakeReviews(capacity.project.id)).length, 1000);

  await capacity.rawRepository.deleteHistoricalTakeReviewGroup(capacity.project.id, {
    batchId: releasableHistory.source.batchId,
    planFingerprint: releasableHistory.source.planFingerprint
  }, {
    expectedPlanFingerprint: takeReviewPlanFingerprint(capacity.plan),
    expectedRecords: revisionSnapshot([releasableHistory]),
    now: TIMES.fourth
  });
  assert.equal((await capacity.rawRepository.listTakeReviews(capacity.project.id)).length, 999);
  const replacement = await capacity.rawRepository.saveTakeReview(
    capacity.project.id,
    capacity.versions[1].testId,
    reviewDraft({ materialCode: "NEW-SLOT", takeNumber: "T01" }),
    { ...saveOptions(capacity.plan, TIMES.fifth, "capacity-new-slot"), expectedVersionRecords: [] }
  );
  assert.equal(replacement.materialCode, "NEW-SLOT");
  assert.equal((await capacity.rawRepository.listTakeReviews(capacity.project.id)).length, 1000);
});

test("reads the project, versions and Take records from one readonly snapshot", async () => {
  const { database, repository, project, plan, versions } = setup();
  const saved = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft(),
    saveOptions(plan, TIMES.first, "12121212")
  );
  const before = database.transactionLog.length;
  const snapshot = await repository.getTakeReviewSnapshot(project.id);
  const transactions = database.transactionLog.slice(before);
  assert.deepEqual(transactions, [{ names: ["projects", "versions", "takeReviews"], mode: "readonly" }]);
  assert.equal(snapshot.project.id, project.id);
  assert.equal(snapshot.versions.length, versions.length);
  assert.deepEqual(snapshot.records, [saved]);
});

test("uses revision CAS and atomically replaces an explicit primary or backup role", async () => {
  const { repository, project, plan, versions } = setup();
  const first = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C001", takeNumber: "T01", handoffRole: "primary" }),
    saveOptions(plan, TIMES.first, "11111111")
  );
  const second = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T02" }),
    saveOptions(plan, TIMES.second, "22222222")
  );

  await assert.rejects(
    repository.saveTakeReview(
      project.id,
      versions[0].testId,
      reviewDraft({ materialCode: "C002", takeNumber: "T02", handoffRole: "primary", expectedRevision: second.revision }),
      {
        ...saveOptions(plan, TIMES.third, "unused-id"),
        takeId: second.id,
        expectedRevision: second.revision,
        expectedRoleConflict: { id: first.id, revision: first.revision }
      }
    ),
    /明确确认后再替换/u
  );

  const promoted = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T02", handoffRole: "primary", expectedRevision: second.revision }),
    {
      ...saveOptions(plan, TIMES.third, "unused-id"),
      takeId: second.id,
      expectedRevision: second.revision,
      expectedRoleConflict: { id: first.id, revision: first.revision },
      replaceHandoffRole: true
    }
  );
  const records = await repository.listTakeReviews(project.id, { testId: versions[0].testId });
  assert.equal(promoted.revision, 2);
  assert.equal(promoted.handoffRole, "primary");
  assert.equal(records.find((entry) => entry.id === first.id).handoffRole, "none");
  assert.equal(records.find((entry) => entry.id === first.id).revision, 2);
  assert.equal(records.filter((entry) => entry.handoffRole === "primary").length, 1);

  const left = repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T02", handoffRole: "primary", expectedRevision: promoted.revision }),
    { ...saveOptions(plan, TIMES.fourth, "unused-left"), takeId: promoted.id, expectedRevision: promoted.revision }
  );
  const right = repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T02", handoffRole: "primary", expectedRevision: promoted.revision }),
    { ...saveOptions(plan, TIMES.fourth, "unused-right"), takeId: promoted.id, expectedRevision: promoted.revision }
  );
  const settled = await Promise.allSettled([left, right]);
  assert.deepEqual(settled.map((entry) => entry.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(settled.find((entry) => entry.status === "rejected").reason), /其他页面(?:更新|变化)/u);
  assert.equal((await repository.listTakeReviews(project.id)).find((entry) => entry.id === promoted.id).revision, 3);
});

test("uses the observed role-conflict revision so two pages cannot replace the same primary", async () => {
  const { repository, project, plan, versions } = setup();
  const primary = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C001", takeNumber: "T01", handoffRole: "primary" }),
    saveOptions(plan, TIMES.first, "11111111")
  );
  const candidateA = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T02" }),
    saveOptions(plan, TIMES.second, "22222222")
  );
  const candidateB = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C003", takeNumber: "T03" }),
    saveOptions(plan, TIMES.third, "33333333")
  );
  const observedConflict = { id: primary.id, revision: primary.revision };
  const promote = (candidate, now) => repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({
      materialCode: candidate.materialCode,
      takeNumber: candidate.takeNumber,
      handoffRole: "primary",
      expectedRevision: candidate.revision
    }),
    {
      ...saveOptions(plan, now, "unused-id"),
      takeId: candidate.id,
      expectedRevision: candidate.revision,
      expectedRoleConflict: observedConflict,
      replaceHandoffRole: true
    }
  );

  const settled = await Promise.allSettled([
    promote(candidateA, TIMES.fourth),
    promote(candidateB, TIMES.fifth)
  ]);
  assert.deepEqual(settled.map((entry) => entry.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(settled.find((entry) => entry.status === "rejected").reason), /其他页面变化/u);
  const records = await repository.listTakeReviews(project.id, { testId: versions[0].testId });
  assert.equal(records.filter((entry) => entry.handoffRole === "primary").length, 1);
});

test("allocates a monotonic Take order across same-time writes and clock rollback", async () => {
  const { repository, project, plan, versions } = setup();
  const save = (materialCode, takeNumber, randomUUID) => repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode, takeNumber }),
    saveOptions(plan, TIMES.first, randomUUID)
  );
  await save("C001", "T01", "44444444");
  await save("C002", "T02", "55555555");
  const clockRollback = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C003", takeNumber: "T03" }),
    saveOptions(plan, TIMES.created, "66666666")
  );
  const records = await repository.listTakeReviews(project.id, { testId: versions[0].testId });
  assert.deepEqual(records.map((entry) => entry.createdOrder).sort((left, right) => left - right), [1, 2, 3]);
  assert.equal(clockRollback.createdOrder, 3);
});

test("rejects an unseen concurrent Take in the same version but allows another version", async () => {
  const { rawRepository, project, plan, versions } = setup();
  await assert.rejects(rawRepository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft(),
    saveOptions(plan, TIMES.first, "77777770")
  ), /本版本过条记录已在其他页面变化/u);
  const save = (testId, materialCode, randomUUID) => rawRepository.saveTakeReview(
    project.id,
    testId,
    reviewDraft({ materialCode, takeNumber: "T01" }),
    {
      ...saveOptions(plan, TIMES.first, randomUUID),
      expectedVersionRecords: []
    }
  );
  const settled = await Promise.allSettled([
    save(versions[0].testId, "C001", "77777771"),
    save(versions[0].testId, "C002", "77777772"),
    save(versions[1].testId, "C003", "77777773")
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 2);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.match(String(settled.find((entry) => entry.status === "rejected").reason), /本版本过条记录已在其他页面变化/u);
  assert.equal((await rawRepository.listTakeReviews(project.id, { testId: versions[0].testId })).length, 1);
  assert.equal((await rawRepository.listTakeReviews(project.id, { testId: versions[1].testId })).length, 1);
});

test("rejects same-revision Take content replaced through a portfolio restore", async () => {
  const { rawRepository, project, plan, versions } = setup();
  const original = await rawRepository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C001", takeNumber: "T01" }),
    {
      ...saveOptions(plan, TIMES.first, "77777774"),
      expectedVersionRecords: []
    }
  );
  const staleSnapshot = revisionSnapshot([original]);
  const portfolio = await rawRepository.exportPortfolio();
  await rawRepository.replacePortfolio({
    ...portfolio,
    takeReviews: portfolio.takeReviews.map((record) => record.id === original.id
      ? { ...record, materialCode: "C001-RESTORED" }
      : record)
  });

  await assert.rejects(rawRepository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C001-OLD-PAGE", takeNumber: "T01", expectedRevision: original.revision }),
    {
      ...saveOptions(plan, TIMES.second, "unused-id"),
      takeId: original.id,
      expectedRevision: original.revision,
      expectedVersionRecords: staleSnapshot
    }
  ), /本版本过条记录已在其他页面变化/u);
  await assert.rejects(rawRepository.deleteTakeReview(project.id, original.id, {
    expectedRevision: original.revision,
    expectedContentSnapshot: takeReviewRecordSnapshot(original),
    expectedPlanFingerprint: takeReviewPlanFingerprint(plan),
    now: TIMES.second
  }), /记录内容已在其他页面变化/u);
  await assert.rejects(rawRepository.clearTakeReviewBatch(project.id, BATCH_ID, {
    expectedPlanFingerprint: takeReviewPlanFingerprint(plan),
    expectedRecords: staleSnapshot,
    now: TIMES.second
  }), /本批过条记录已在其他页面变化/u);
  assert.equal((await rawRepository.listTakeReviews(project.id, { testId: versions[0].testId }))[0].materialCode, "C001-RESTORED");
});

test("rejects take writes when the plan context or stored version no longer matches", async () => {
  {
    const { database, repository, project, plan, versions } = setup();
    const storedProject = await database.get("projects", project.id);
    database.stores.get("projects").set(project.id, {
      ...storedProject,
      workspace: {
        ...storedProject.workspace,
        creativeTask: { ...storedProject.workspace.creativeTask, subject: "已改变的内容主题" }
      }
    });
    await assert.rejects(repository.saveTakeReview(
      project.id,
      versions[0].testId,
      reviewDraft(),
      saveOptions(plan, TIMES.first, "11111111")
    ), /创作上下文已变化/u);
  }

  {
    const { database, repository, project, plan, versions } = setup();
    const storedVersion = await database.get("versions", versions[0].id);
    database.stores.get("versions").set(versions[0].id, {
      ...storedVersion,
      planItem: { ...storedVersion.planItem, hook: "未同步的版本钩子" }
    });
    await assert.rejects(repository.saveTakeReview(
      project.id,
      versions[0].testId,
      reviewDraft(),
      saveOptions(plan, TIMES.first, "11111111")
    ), /尚未完整同步到版本库/u);
  }
});

test("deletes with CAS and clears only the selected current batch", async () => {
  const { repository, project, plan, versions } = setup();
  const first = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C001", takeNumber: "T01" }),
    saveOptions(plan, TIMES.first, "11111111")
  );
  const second = await repository.saveTakeReview(
    project.id,
    versions[1].testId,
    reviewDraft({ materialCode: "C002", takeNumber: "T01" }),
    saveOptions(plan, TIMES.second, "22222222")
  );

  const expectedPlanFingerprint = takeReviewPlanFingerprint(plan);
  await assert.rejects(repository.deleteTakeReview(project.id, first.id, {
    expectedRevision: 0,
    expectedContentSnapshot: takeReviewRecordSnapshot(first),
    expectedPlanFingerprint,
    now: TIMES.third
  }), /其他页面更新/u);
  assert.equal((await repository.listTakeReviews(project.id)).length, 2);

  await assert.rejects(repository.deleteTakeReview(project.id, first.id, {
    expectedRevision: first.revision,
    expectedContentSnapshot: takeReviewRecordSnapshot(first),
    now: TIMES.third
  }), /方案已变化/u);
  await repository.deleteTakeReview(project.id, first.id, {
    expectedRevision: first.revision,
    expectedContentSnapshot: takeReviewRecordSnapshot(first),
    expectedPlanFingerprint,
    now: TIMES.third
  });

  const staleClearSnapshot = revisionSnapshot([second]);
  await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "C003", takeNumber: "T01" }),
    saveOptions(plan, TIMES.fourth, "33333333")
  );
  await assert.rejects(repository.clearTakeReviewBatch(project.id, BATCH_ID, {
    expectedPlanFingerprint,
    expectedRecords: staleClearSnapshot,
    now: TIMES.fifth
  }), /其他页面变化/u);

  const currentBatch = await repository.listTakeReviews(project.id, { batchId: BATCH_ID });
  assert.equal(await repository.clearTakeReviewBatch(project.id, BATCH_ID, {
    expectedPlanFingerprint,
    expectedRecords: revisionSnapshot(currentBatch),
    now: TIMES.fifth
  }), 2);
  assert.deepEqual(await repository.listTakeReviews(project.id), []);
  assert.equal((await repository.getProject(project.id)).updatedAt, TIMES.fifth);
});

test("exports current-source semantics and deletes only one exact historical source group", async () => {
  const { rawRepository, project, plan, versions } = setup();
  const current = await rawRepository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ materialCode: "CURRENT", takeNumber: "T01" }),
    { ...saveOptions(plan, TIMES.first, "88888881"), expectedVersionRecords: [] }
  );
  const portfolio = await rawRepository.exportPortfolio();
  const historicalA = {
    ...current,
    id: "take_88888882",
    source: { ...current.source, planFingerprint: "take-plan:deadbeef" },
    materialCode: "HISTORY-A",
    takeNumber: "T02",
    handoffRole: "none",
    createdOrder: 2,
    createdAt: TIMES.second,
    updatedAt: TIMES.second
  };
  const historicalB = {
    ...current,
    id: "take_88888883",
    source: { ...current.source, planFingerprint: "take-plan:cafebabe" },
    materialCode: "HISTORY-B",
    takeNumber: "T03",
    handoffRole: "none",
    createdOrder: 3,
    createdAt: TIMES.third,
    updatedAt: TIMES.third
  };
  await rawRepository.replacePortfolio({ ...portfolio, takeReviews: [current, historicalA, historicalB] });
  const expectedPlanFingerprint = takeReviewPlanFingerprint(plan);

  await assert.rejects(rawRepository.deleteHistoricalTakeReviewGroup(project.id, {
    batchId: current.source.batchId,
    planFingerprint: current.source.planFingerprint
  }, {
    expectedPlanFingerprint,
    expectedRecords: revisionSnapshot([current])
  }), /当前方案来源不能/u);

  const deleted = await rawRepository.deleteHistoricalTakeReviewGroup(project.id, {
    batchId: historicalA.source.batchId,
    planFingerprint: historicalA.source.planFingerprint
  }, {
    expectedPlanFingerprint,
    expectedRecords: revisionSnapshot([historicalA]),
    now: TIMES.fourth
  });
  assert.equal(deleted.deletedCount, 1);
  assert.deepEqual((await rawRepository.listTakeReviews(project.id)).map((record) => record.id).sort(), [current.id, historicalB.id].sort());

  await rawRepository.clearTakeReviewBatch(project.id, BATCH_ID, {
    expectedPlanFingerprint,
    expectedRecords: revisionSnapshot([current]),
    now: TIMES.fifth
  });
  assert.deepEqual((await rawRepository.listTakeReviews(project.id)).map((record) => record.id), [historicalB.id]);

  const beforeRestore = revisionSnapshot([historicalB]);
  const afterClear = await rawRepository.exportPortfolio();
  await rawRepository.replacePortfolio({
    ...afterClear,
    takeReviews: afterClear.takeReviews.map((record) => ({ ...record, materialCode: "HISTORY-B-RESTORED" }))
  });
  await assert.rejects(rawRepository.deleteHistoricalTakeReviewGroup(project.id, {
    batchId: historicalB.source.batchId,
    planFingerprint: historicalB.source.planFingerprint
  }, {
    expectedPlanFingerprint,
    expectedRecords: beforeRestore
  }), /其他页面变化/u);
  assert.equal((await rawRepository.listTakeReviews(project.id))[0].materialCode, "HISTORY-B-RESTORED");
});

test("exports one portfolio snapshot, restores take reviews atomically and migrates schema 1", async () => {
  const { database, repository, project, plan, versions } = setup();
  const saved = await repository.saveTakeReview(
    project.id,
    versions[0].testId,
    reviewDraft({ handoffRole: "primary" }),
    saveOptions(plan, TIMES.first, "11111111")
  );
  const beforeTransactions = database.transactionLog.length;
  const portfolio = await repository.exportPortfolio();
  const exportTransactions = database.transactionLog.slice(beforeTransactions);
  assert.equal(portfolio.schemaVersion, 2);
  assert.deepEqual(portfolio.takeReviews, [saved]);
  assert.equal(exportTransactions.length, 1);
  assert.deepEqual(exportTransactions[0], {
    names: ["projects", "versions", "results", "takeReviews", "meta"],
    mode: "readonly"
  });

  const replacementDatabase = new FakeDatabase();
  const replacement = createProjectRepository(replacementDatabase);
  await replacement.replacePortfolio(portfolio);
  assert.deepEqual(await replacement.exportPortfolio(), portfolio);
  const replaceWrite = replacementDatabase.transactionLog.find((entry) => entry.mode === "readwrite" && entry.names.length === 5);
  assert.deepEqual(replaceWrite?.names, ["projects", "versions", "results", "takeReviews", "meta"]);

  const { takeReviews: _removed, ...legacy } = portfolio;
  const migrated = await replacement.replacePortfolio({ ...legacy, schemaVersion: 1 });
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.takeReviews, []);
  assert.deepEqual(await replacement.listTakeReviews(project.id), []);
});

test("serializes plan sync with production updates so neither write is lost", async () => {
  const { database, repository, project, plan, versions } = setup();
  const changedPlan = samplePlan({ generatedAt: TIMES.second, secondHook: "三秒看懂真实差别" });
  const sanitizedChangedPlan = createProjectRecord({
    id: "prj_87654321",
    name: "临时校验",
    now: TIMES.created,
    workspace: { creativePlan: changedPlan }
  }).workspace.creativePlan;
  const storedProject = await database.get("projects", project.id);
  database.stores.get("projects").set(project.id, {
    ...storedProject,
    workspace: { ...storedProject.workspace, creativePlan: sanitizedChangedPlan }
  });

  const sync = repository.syncPlan(project.id, sanitizedChangedPlan, null);
  const status = repository.setVersionProductionStatus(
    project.id,
    versions[1].testId,
    createProductionStatus("ready", TIMES.third),
    TIMES.third
  );
  await Promise.all([sync, status]);

  const stored = (await repository.listVersions(project.id)).find((entry) => entry.testId === versions[1].testId);
  assert.equal(stored.planItem.hook, "三秒看懂真实差别");
  assert.equal(stored.productionStatus.stage, "ready");
  assert.equal(stored.productionStatus.updatedAt, TIMES.third);
});
