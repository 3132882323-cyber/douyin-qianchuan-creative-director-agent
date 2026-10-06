import test from "node:test";
import assert from "node:assert/strict";
import { createContentPriority } from "../src/content-priority.js";
import { createProjectRecord } from "../src/project-model.js";
import { readProductionCommandSnapshot } from "../src/production-command-source.js";

const NOW = "2026-09-02T08:00:00.000Z";
const TODAY = "2026-09-02";

function project(index, lane = "now", manualOrder = index) {
  const source = createProjectRecord({
    id: `prj_1234567${index}`,
    name: `项目 ${index}`,
    now: NOW,
    workspace: {
      creativeTask: {
        subject: `项目 ${index} 选题`,
        targetAudience: "明确受众",
        creativeGoal: "完成今日素材生产",
        coreClaim: "人工排期优先"
      }
    }
  });
  return {
    ...source,
    contentPriority: createContentPriority({ project: source, lane, reason: `人工确认项目 ${index} 今日执行`, manualOrder, now: NOW })
  };
}

function snapshotFor(source) {
  const testId = `${source.id}-A`;
  return {
    project: structuredClone(source),
    versions: [{ projectId: source.id, testId }],
    records: [{ projectId: source.id, id: `${source.id}-take`, source: { testId } }]
  };
}

test("reads only the manual Top 3 and keeps each project snapshot together", async () => {
  const projects = [project(4, "now", 3), project(2, "now", 1), project(1, "now", 0), project(3, "now", 2), project(5, "week", 0)];
  const calls = [];
  const repository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      calls.push(id);
      return snapshotFor(projects.find((entry) => entry.id === id));
    }
  };
  const result = await readProductionCommandSnapshot(repository, { currentProjectId: projects[0].id, today: TODAY });
  const expectedIds = [projects[2].id, projects[1].id, projects[3].id];
  assert.deepEqual(calls, [...expectedIds, ...expectedIds]);
  assert.deepEqual(result.versions.map((entry) => entry.projectId), expectedIds);
  assert.deepEqual(result.takeReviews.map((entry) => entry.projectId), expectedIds);
  assert.deepEqual(result.projectErrors, {});
  assert.equal(result.projects.length, 5);
});

test("isolates one project read failure without clearing the other commands", async () => {
  const projects = [project(1), project(2), project(3)];
  const repository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      if (id === projects[1].id) throw new Error("IndexedDB 记录损坏");
      return snapshotFor(projects.find((entry) => entry.id === id));
    }
  };
  const result = await readProductionCommandSnapshot(repository, { currentProjectId: projects[0].id, today: TODAY });
  assert.equal(result.versions.length, 2);
  assert.match(result.projectErrors[projects[1].id], /记录损坏/u);
});

test("isolates an orphan Take reference to one project snapshot", async () => {
  const projects = [project(1), project(2), project(3)];
  const repository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      const snapshot = snapshotFor(projects.find((entry) => entry.id === id));
      if (id === projects[1].id) snapshot.records[0].source.testId = "missing-version";
      return snapshot;
    }
  };
  const result = await readProductionCommandSnapshot(repository, { currentProjectId: projects[0].id, today: TODAY });
  assert.deepEqual(result.versions.map((entry) => entry.projectId), [projects[0].id, projects[2].id]);
  assert.deepEqual(result.takeReviews.map((entry) => entry.projectId), [projects[0].id, projects[2].id]);
  assert.match(result.projectErrors[projects[1].id], /孤立的人工过条记录/u);
});

test("retries when manual order changes during the read and returns one coherent queue", async () => {
  const first = [project(1, "now", 0), project(2, "now", 1), project(3, "now", 2), project(4, "now", 3)];
  const second = [first[3], first[1], first[2], first[0]].map((entry, index) => ({
    ...entry,
    contentPriority: { ...entry.contentPriority, manualOrder: index }
  }));
  let listCall = 0;
  const snapshots = new Map([...first, ...second].map((entry) => [entry.id, entry]));
  const repository = {
    listProjects: async () => structuredClone(listCall++ === 0 ? first : second),
    getTakeReviewSnapshot: async (id) => snapshotFor(snapshots.get(id))
  };
  const result = await readProductionCommandSnapshot(repository, { currentProjectId: first[0].id, today: TODAY });
  assert.deepEqual(result.projects.map((entry) => entry.id), second.map((entry) => entry.id));
  assert.deepEqual(result.versions.map((entry) => entry.projectId), second.slice(0, 3).map((entry) => entry.id));
  assert.ok(listCall >= 4);

  let finalListCall = 0;
  const finalCheckRepository = {
    listProjects: async () => structuredClone(finalListCall++ < 2 ? first : second),
    getTakeReviewSnapshot: async (id) => snapshotFor(snapshots.get(id))
  };
  const finalCheckResult = await readProductionCommandSnapshot(finalCheckRepository, { currentProjectId: first[0].id, today: TODAY });
  assert.deepEqual(finalCheckResult.versions.map((entry) => entry.projectId), second.slice(0, 3).map((entry) => entry.id));
  assert.ok(finalListCall >= 6);
});

test("fails closed after repeated queue churn and validates repository bounds", async () => {
  const first = [project(1, "now", 0), project(2, "now", 1), project(3, "now", 2), project(4, "now", 3)];
  const reverse = [...first].reverse().map((entry, index) => ({ ...entry, contentPriority: { ...entry.contentPriority, manualOrder: index } }));
  let call = 0;
  const repository = {
    listProjects: async () => structuredClone(call++ % 2 === 0 ? first : reverse),
    getTakeReviewSnapshot: async (id) => snapshotFor(first.find((entry) => entry.id === id) || reverse.find((entry) => entry.id === id))
  };
  await assert.rejects(readProductionCommandSnapshot(repository, { currentProjectId: first[0].id, today: TODAY }), /排期刚刚发生变化/u);
  await assert.rejects(readProductionCommandSnapshot({}, { currentProjectId: first[0].id, today: TODAY }), /读取器不可用/u);
  await assert.rejects(readProductionCommandSnapshot(repository, { currentProjectId: first[0].id, today: TODAY, maxAttempts: 0 }), /重试次数/u);
});

test("retries when versions or Take records change between complete snapshots and fails closed on continuous churn", async () => {
  const projects = [project(1), project(2), project(3)];
  const targetId = projects[0].id;
  let targetRead = 0;
  const repository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      const snapshot = snapshotFor(projects.find((entry) => entry.id === id));
      if (id === targetId) {
        targetRead += 1;
        if (targetRead >= 2) {
          snapshot.versions[0].revision = "stable-new-version";
          snapshot.records[0].nextCorrection = "稳定后的人工修正";
        }
      }
      return snapshot;
    }
  };
  const result = await readProductionCommandSnapshot(repository, { currentProjectId: targetId, today: TODAY });
  assert.ok(targetRead >= 4);
  assert.equal(result.versions.find((entry) => entry.projectId === targetId).revision, "stable-new-version");
  assert.equal(result.takeReviews.find((entry) => entry.projectId === targetId).nextCorrection, "稳定后的人工修正");

  let takeRead = 0;
  const takeChangingRepository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      const snapshot = snapshotFor(projects.find((entry) => entry.id === id));
      if (id === targetId) {
        takeRead += 1;
        if (takeRead >= 2) snapshot.records[0].nextCorrection = "只变化的 Take 结论";
      }
      return snapshot;
    }
  };
  const takeResult = await readProductionCommandSnapshot(takeChangingRepository, { currentProjectId: targetId, today: TODAY });
  assert.ok(takeRead >= 4);
  assert.equal(takeResult.takeReviews.find((entry) => entry.projectId === targetId).nextCorrection, "只变化的 Take 结论");

  let failedVerificationRead = 0;
  const failedVerificationRepository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      if (id === targetId && ++failedVerificationRead === 2) throw new Error("第二次完整快照读取失败");
      return snapshotFor(projects.find((entry) => entry.id === id));
    }
  };
  const isolated = await readProductionCommandSnapshot(failedVerificationRepository, { currentProjectId: targetId, today: TODAY });
  assert.equal(isolated.versions.some((entry) => entry.projectId === targetId), false);
  assert.match(isolated.projectErrors[targetId], /第二次完整快照读取失败/u);

  let churnRead = 0;
  const churningRepository = {
    listProjects: async () => structuredClone(projects),
    getTakeReviewSnapshot: async (id) => {
      const snapshot = snapshotFor(projects.find((entry) => entry.id === id));
      if (id === targetId) snapshot.versions[0].revision = `revision-${churnRead++}`;
      return snapshot;
    }
  };
  await assert.rejects(
    readProductionCommandSnapshot(churningRepository, { currentProjectId: targetId, today: TODAY }),
    /读取期间发生变化/u
  );
});
