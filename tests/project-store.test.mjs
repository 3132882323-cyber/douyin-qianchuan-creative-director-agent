import test from "node:test";
import assert from "node:assert/strict";
import { assessContentPriority, contentPriorityContextFingerprint } from "../src/content-priority.js";
import { createProjectRecord } from "../src/project-model.js";
import { createProjectRepository } from "../src/project-store.js";

const TIMES = Object.freeze({
  created: "2026-09-02T01:00:00.000Z",
  first: "2026-09-02T02:00:00.000Z",
  second: "2026-09-02T03:00:00.000Z",
  third: "2026-09-02T04:00:00.000Z",
  move: "2026-09-02T05:00:00.000Z"
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeTransaction {
  constructor(database, failPutAt) {
    this.database = database;
    this.working = null;
    this.failPutAt = failPutAt;
    this.putCount = 0;
    this.pending = 0;
    this.generation = 0;
    this.settled = false;
    this.aborted = false;
    this.active = false;
    this.waitingRequests = [];
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.store = {
      get: (key) => this.request(() => clone(this.working.get(key))),
      getAll: () => this.request(() => [...this.working.values()].map(clone)),
      put: (value) => this.request(() => {
        this.putCount += 1;
        if (this.putCount === this.failPutAt) throw new Error("simulated IndexedDB write failure");
        const record = clone(value);
        this.working.set(record.id, record);
        return record.id;
      })
    };
  }

  activate() {
    if (this.active || this.settled) return;
    this.active = true;
    this.working = new Map([...this.database.projects].map(([key, value]) => [key, clone(value)]));
    const waiting = this.waitingRequests.splice(0);
    for (const run of waiting) run();
    this.scheduleCompletion();
  }

  objectStore(name) {
    if (name !== "projects") throw new Error(`unexpected store: ${name}`);
    return this.store;
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
          this.reject(error);
        } finally {
          this.pending -= 1;
          this.scheduleCompletion();
        }
      });
      if (this.active) run();
      else this.waitingRequests.push(run);
    });
  }

  reject(error) {
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
        this.database.projects = this.working;
        this.database.committedPutCount += this.putCount;
        this.resolveDone();
        this.database.finishTransaction(this);
      }
    }, 0);
  }
}

class FakeProjectDatabase {
  constructor(projects) {
    this.projects = new Map(projects.map((project) => [project.id, clone(project)]));
    this.failPutAt = Number.POSITIVE_INFINITY;
    this.committedPutCount = 0;
    this.transactions = [];
  }

  async get(store, key) {
    if (store !== "projects") throw new Error(`unexpected store: ${store}`);
    return clone(this.projects.get(key));
  }

  async getAll(store) {
    if (store !== "projects") throw new Error(`unexpected store: ${store}`);
    return [...this.projects.values()].map(clone);
  }

  transaction(storeNames, mode) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    if (mode !== "readwrite" || names.length !== 1 || names[0] !== "projects") {
      throw new Error("unexpected transaction");
    }
    const transaction = new FakeTransaction(this, this.failPutAt);
    this.failPutAt = Number.POSITIVE_INFINITY;
    this.transactions.push(transaction);
    if (this.transactions.length === 1) transaction.activate();
    return transaction;
  }

  finishTransaction(transaction) {
    const index = this.transactions.indexOf(transaction);
    if (index >= 0) this.transactions.splice(index, 1);
    this.transactions[0]?.activate();
  }
}

function project(id, subject) {
  return createProjectRecord({
    id,
    name: subject,
    now: TIMES.created,
    workspace: {
      creativeTask: {
        subject,
        targetAudience: "近期需要拍摄素材的内容团队",
        creativeGoal: "明确本周最应该先拍什么",
        coreClaim: "人工排期优先"
      },
      targetRoi: 1.5
    }
  });
}

function setup() {
  const projects = [
    project("prj_aaaaaaaa", "项目甲"),
    project("prj_bbbbbbbb", "项目乙"),
    project("prj_cccccccc", "项目丙"),
    project("prj_dddddddd", "项目丁")
  ];
  const database = new FakeProjectDatabase(projects);
  return { database, repository: createProjectRepository(database), projects };
}

test("sets a local manual priority bound to the current content fingerprint and preserves order in one lane", async () => {
  const { database, repository, projects } = setup();
  const created = await repository.setProjectContentPriority(projects[0].id, {
    lane: "now",
    reason: "本周必须先完成首轮拍摄",
    dueOn: "2026-09-05"
  }, TIMES.first);

  assert.equal(created.contentPriority.method, "manual");
  assert.equal(created.contentPriority.lane, "now");
  assert.equal(created.contentPriority.manualOrder, 0);
  assert.equal(created.contentPriority.contextFingerprint, contentPriorityContextFingerprint(projects[0]));
  assert.equal(created.contentPriority.updatedAt, TIMES.first);
  const stored = await database.get("projects", projects[0].id);
  assert.deepEqual(stored, created);
  assert.equal(stored.updatedAt, TIMES.first);

  const editedProject = clone(stored);
  editedProject.workspace.creativeTask.subject = "已经变化的本周拍摄主题";
  database.projects.set(editedProject.id, clone(editedProject));
  const updated = await repository.setProjectContentPriority(projects[0].id, {
    lane: "now",
    reason: "演员档期提前，仍保持当前顺序",
    dueOn: null
  }, TIMES.second);
  assert.equal(updated.contentPriority.manualOrder, 0);
  assert.equal(updated.contentPriority.reason, "演员档期提前，仍保持当前顺序");
  assert.equal(updated.contentPriority.dueOn, null);
  assert.notEqual(updated.contentPriority.contextFingerprint, created.contentPriority.contextFingerprint);
  assert.equal(updated.contentPriority.contextFingerprint, contentPriorityContextFingerprint(editedProject));
});

test("rejects a missing reason without persisting a partial priority", async () => {
  const { database, repository, projects } = setup();
  await assert.rejects(repository.setProjectContentPriority(projects[0].id, {
    lane: "now",
    reason: "",
    dueOn: null
  }, TIMES.first));
  const stored = await database.get("projects", projects[0].id);
  assert.equal(stored.contentPriority, null);
  assert.equal(stored.updatedAt, TIMES.created);
});

test("keeps order in the same lane and appends a project when it changes lanes", async () => {
  const { database, repository, projects } = setup();
  await repository.setProjectContentPriority(projects[0].id, { lane: "now", reason: "先拍基线版本" }, TIMES.first);
  await repository.setProjectContentPriority(projects[1].id, { lane: "now", reason: "随后拍摄变量版本" }, TIMES.second);
  await repository.setProjectContentPriority(projects[2].id, { lane: "week", reason: "本周完成内容复盘" }, TIMES.first);

  const sameLane = await repository.setProjectContentPriority(projects[1].id, { lane: "now", reason: "更新原因但不改变顺序" }, TIMES.third);
  assert.equal(sameLane.contentPriority.manualOrder, 1);
  const changedLane = await repository.setProjectContentPriority(projects[0].id, { lane: "week", reason: "调整到本周候拍列表" }, TIMES.third);
  assert.equal(changedLane.contentPriority.manualOrder, 1);
  assert.equal((await database.get("projects", projects[1].id)).contentPriority.manualOrder, 1);
  assert.equal((await database.get("projects", projects[2].id)).contentPriority.manualOrder, 0);
});

test("moves only within one lane atomically and treats top and bottom boundaries as idempotent", async () => {
  const { database, repository, projects } = setup();
  await repository.setProjectContentPriority(projects[0].id, { lane: "now", reason: "第一优先项目" }, TIMES.first);
  await repository.setProjectContentPriority(projects[1].id, { lane: "now", reason: "第二优先项目" }, TIMES.second);
  await repository.setProjectContentPriority(projects[2].id, { lane: "now", reason: "第三优先项目" }, TIMES.third);
  await repository.setProjectContentPriority(projects[3].id, { lane: "week", reason: "本周其他项目" }, TIMES.third);

  const moved = await repository.moveProjectContentPriority(projects[1].id, "up", TIMES.move);
  assert.equal(moved.length, projects.length);
  assert.equal(moved.find((entry) => entry.id === projects[1].id).contentPriority.manualOrder, 0);
  assert.equal((await database.get("projects", projects[0].id)).contentPriority.manualOrder, 1);
  assert.equal((await database.get("projects", projects[1].id)).contentPriority.manualOrder, 0);
  assert.equal((await database.get("projects", projects[2].id)).contentPriority.manualOrder, 2);
  assert.equal((await database.get("projects", projects[3].id)).contentPriority.manualOrder, 0);

  const writesBeforeTopBoundary = database.committedPutCount;
  const top = await repository.moveProjectContentPriority(projects[1].id, "up", TIMES.move);
  assert.equal(top.find((entry) => entry.id === projects[1].id).contentPriority.manualOrder, 0);
  assert.equal(database.committedPutCount, writesBeforeTopBoundary);
  const writesBeforeBottomBoundary = database.committedPutCount;
  const bottom = await repository.moveProjectContentPriority(projects[2].id, "down", TIMES.move);
  assert.equal(bottom.find((entry) => entry.id === projects[2].id).contentPriority.manualOrder, 2);
  assert.equal(database.committedPutCount, writesBeforeBottomBoundary);
});

test("clears only the selected project priority", async () => {
  const { database, repository, projects } = setup();
  await repository.setProjectContentPriority(projects[0].id, { lane: "now", reason: "项目甲立即执行" }, TIMES.first);
  const other = await repository.setProjectContentPriority(projects[1].id, { lane: "now", reason: "项目乙随后执行" }, TIMES.second);

  const cleared = await repository.clearProjectContentPriority(projects[0].id, TIMES.third);
  assert.equal(cleared.contentPriority, null);
  assert.equal((await database.get("projects", projects[0].id)).contentPriority, null);
  assert.deepEqual(await database.get("projects", projects[1].id), other);
});

test("rolls back every reordered project when an IndexedDB write fails", async () => {
  const { database, repository, projects } = setup();
  await repository.setProjectContentPriority(projects[0].id, { lane: "now", reason: "第一优先项目" }, TIMES.first);
  await repository.setProjectContentPriority(projects[1].id, { lane: "now", reason: "第二优先项目" }, TIMES.second);
  const before = await database.getAll("projects");
  database.failPutAt = 2;

  await assert.rejects(
    repository.moveProjectContentPriority(projects[1].id, "up", TIMES.move),
    /simulated IndexedDB write failure/u
  );
  assert.deepEqual(await database.getAll("projects"), before);
});

test("serializes workspace and priority transactions in both start orders without losing either change", async () => {
  {
    const { database, repository, projects } = setup();
    const nextWorkspace = clone(projects[0].workspace);
    nextWorkspace.creativeTask.subject = "先保存工作区再确认排期";
    const workspaceWrite = repository.saveWorkspace(projects[0].id, nextWorkspace, TIMES.first);
    const priorityWrite = repository.setProjectContentPriority(projects[0].id, {
      lane: "now",
      reason: "工作区保存后立即进入拍摄排期"
    }, TIMES.second);
    await Promise.all([workspaceWrite, priorityWrite]);

    const stored = await database.get("projects", projects[0].id);
    assert.equal(stored.workspace.creativeTask.subject, "先保存工作区再确认排期");
    assert.equal(stored.contentPriority.reason, "工作区保存后立即进入拍摄排期");
    assert.equal(assessContentPriority(stored).code, "current");
  }

  {
    const { database, repository, projects } = setup();
    const nextWorkspace = clone(projects[0].workspace);
    nextWorkspace.creativeTask.subject = "排期确认后内容目标发生变化";
    const priorityWrite = repository.setProjectContentPriority(projects[0].id, {
      lane: "week",
      reason: "先确认本周人工内容排期"
    }, TIMES.first);
    const workspaceWrite = repository.saveWorkspace(projects[0].id, nextWorkspace, TIMES.second);
    await Promise.all([priorityWrite, workspaceWrite]);

    const stored = await database.get("projects", projects[0].id);
    assert.equal(stored.workspace.creativeTask.subject, "排期确认后内容目标发生变化");
    assert.equal(stored.contentPriority.reason, "先确认本周人工内容排期");
    assert.equal(assessContentPriority(stored).code, "stale");
  }
});

test("serializes project rename with priority persistence without overwriting either field", async () => {
  const { database, repository, projects } = setup();
  const renameWrite = repository.renameProject(projects[0].id, "重命名后的内容项目", TIMES.first);
  const priorityWrite = repository.setProjectContentPriority(projects[0].id, {
    lane: "backlog",
    reason: "候选池等待内容负责人复核"
  }, TIMES.second);
  await Promise.all([renameWrite, priorityWrite]);

  const stored = await database.get("projects", projects[0].id);
  assert.equal(stored.name, "重命名后的内容项目");
  assert.equal(stored.contentPriority.reason, "候选池等待内容负责人复核");
});
