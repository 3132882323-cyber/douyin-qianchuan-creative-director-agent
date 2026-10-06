import { openDB } from "../vendor/idb.js";
import { createContentPriority, sanitizeContentPriority } from "./content-priority.js";
import { buildDirectorTakeReview } from "./director-take-review.js";
import {
  PROJECT_LIMITS,
  PROJECT_PORTFOLIO_SCHEMA_VERSION,
  createProjectId,
  createProjectRecord,
  createResultRecord,
  emptyProjectWorkspace,
  sanitizeProjectName,
  sanitizeProjectRecord,
  sanitizeProjectWorkspace,
  sanitizeVersionRecord,
  validateProjectPortfolio,
  versionRecordId,
  versionRecordsFromPlan
} from "./project-model.js";
import {
  assessTakeReviewRecord,
  createTakeReviewRecord,
  sanitizeTakeReviewRecord,
  summarizeTakeReviewHistory,
  takeReviewPlanFingerprint,
  takeReviewPlanMatchesWorkspace,
  takeReviewRecordSnapshot,
  takeReviewVersionMatchesPlan
} from "./take-review-record.js";

export const PROJECT_DB_NAME = "qianchuan-creative-director-projects";
export const PROJECT_DB_VERSION = 2;
const CURRENT_PROJECT_META_KEY = "currentProjectId";
const PENDING_PROJECT_META_KEY = "pendingProjectId";

export function upgradeProjectDatabase(database, oldVersion) {
  if (oldVersion < 1) {
    const projects = database.createObjectStore("projects", { keyPath: "id" });
    projects.createIndex("updatedAt", "updatedAt");
    const versions = database.createObjectStore("versions", { keyPath: "id" });
    versions.createIndex("projectId", "projectId");
    const results = database.createObjectStore("results", { keyPath: "id" });
    results.createIndex("projectId", "projectId");
    database.createObjectStore("meta", { keyPath: "key" });
  }
  if (oldVersion < 2) {
    const takeReviews = database.createObjectStore("takeReviews", { keyPath: "id" });
    takeReviews.createIndex("projectId", "projectId");
    takeReviews.createIndex("versionId", "source.testId");
    takeReviews.createIndex("batchId", "source.batchId");
  }
}

export async function openProjectDatabase() {
  return openDB(PROJECT_DB_NAME, PROJECT_DB_VERSION, {
    upgrade(database, oldVersion) {
      upgradeProjectDatabase(database, oldVersion);
    },
    blocking(_currentVersion, _blockedVersion, event) {
      event.target.close();
    }
  });
}

export function createProjectRepository(database) {
  if (!database) throw new Error("项目数据库不可用");

  async function meta(key) {
    return (await database.get("meta", key))?.value ?? null;
  }

  async function setMeta(key, value) {
    await database.put("meta", { key, value });
  }

  async function listProjects() {
    const projects = (await database.getAll("projects")).map(sanitizeProjectRecord);
    return projects.filter((project) => !project.archived).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function currentProject() {
    const currentId = await meta(CURRENT_PROJECT_META_KEY);
    return currentId ? getProject(currentId) : null;
  }

  async function getProject(projectId) {
    const project = await database.get("projects", projectId);
    if (!project || project.archived) return null;
    return sanitizeProjectRecord(project);
  }

  async function initialize(activeWorkspace, { defaultName = "我的第一个项目", now = new Date().toISOString(), randomUUID } = {}) {
    let projects = await listProjects();
    if (!projects.length) {
      const project = createProjectRecord({ id: createProjectId(randomUUID), name: defaultName, workspace: activeWorkspace, now });
      await database.put("projects", project);
      await setMeta(CURRENT_PROJECT_META_KEY, project.id);
      projects = [project];
    }
    let current = await currentProject();
    if (!current || current.archived) {
      current = projects[0];
      await setMeta(CURRENT_PROJECT_META_KEY, current.id);
    }
    const pendingId = await meta(PENDING_PROJECT_META_KEY);
    const pending = pendingId ? await database.get("projects", pendingId) : null;
    if (pending && !pending.archived) {
      current = pending;
      await setMeta(CURRENT_PROJECT_META_KEY, current.id);
      await database.delete("meta", PENDING_PROJECT_META_KEY);
      return { current: sanitizeProjectRecord(current), projects: await listProjects(), pendingWorkspace: sanitizeProjectWorkspace(current.workspace) };
    }
    if (pendingId) await database.delete("meta", PENDING_PROJECT_META_KEY);
    return { current: sanitizeProjectRecord(current), projects, pendingWorkspace: null };
  }

  async function saveWorkspace(projectId, workspace, now = new Date().toISOString()) {
    const transaction = database.transaction("projects", "readwrite");
    const projects = transaction.store;
    const current = await projects.get(projectId);
    if (!current || current.archived) throw new Error("当前项目不存在或已归档");
    const project = sanitizeProjectRecord({ ...current, updatedAt: now, workspace: sanitizeProjectWorkspace(workspace) });
    await Promise.all([projects.put(project), transaction.done]);
    return project;
  }

  async function createProject(name, { now = new Date().toISOString(), randomUUID } = {}) {
    const projects = await listProjects();
    if (projects.length >= PROJECT_LIMITS.maxProjects) throw new Error(`最多创建 ${PROJECT_LIMITS.maxProjects} 个本地项目`);
    const project = createProjectRecord({ id: createProjectId(randomUUID), name, workspace: emptyProjectWorkspace(), now });
    await database.put("projects", project);
    await setMeta(PENDING_PROJECT_META_KEY, project.id);
    return project;
  }

  async function renameProject(projectId, name, now = new Date().toISOString()) {
    const transaction = database.transaction("projects", "readwrite");
    const projects = transaction.store;
    const project = await projects.get(projectId);
    if (!project || project.archived) throw new Error("项目不存在或已归档");
    const next = sanitizeProjectRecord({ ...project, name: sanitizeProjectName(name), updatedAt: now });
    await Promise.all([projects.put(next), transaction.done]);
    return next;
  }

  async function requestSwitch(projectId) {
    const project = await database.get("projects", projectId);
    if (!project || project.archived) throw new Error("目标项目不存在或已归档");
    await setMeta(PENDING_PROJECT_META_KEY, project.id);
    return sanitizeProjectRecord(project);
  }

  async function listVersions(projectId) {
    return database.getAllFromIndex("versions", "projectId", projectId);
  }

  async function listResults(projectId) {
    return database.getAllFromIndex("results", "projectId", projectId);
  }

  async function listTakeReviews(projectId, { testId, batchId } = {}) {
    const records = (await database.getAllFromIndex("takeReviews", "projectId", projectId)).map(sanitizeTakeReviewRecord);
    return records
      .filter((record) => testId === undefined || record.source.testId === String(testId))
      .filter((record) => batchId === undefined || record.source.batchId === String(batchId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.revision - left.revision || right.id.localeCompare(left.id));
  }

  async function getTakeReviewSnapshot(projectId) {
    const transaction = database.transaction(["projects", "versions", "takeReviews"], "readonly");
    const [storedProject, storedVersions, storedRecords] = await Promise.all([
      transaction.objectStore("projects").get(projectId),
      transaction.objectStore("versions").index("projectId").getAll(projectId),
      transaction.objectStore("takeReviews").index("projectId").getAll(projectId)
    ]);
    await transaction.done;
    if (!storedProject || storedProject.archived) throw new Error("当前项目不存在或已归档");
    return {
      project: sanitizeProjectRecord(storedProject),
      versions: storedVersions.map(sanitizeVersionRecord),
      records: storedRecords.map(sanitizeTakeReviewRecord)
    };
  }

  async function syncPlan(projectId, plan, parentVersionId) {
    const transaction = database.transaction(["projects", "versions"], "readwrite");
    const projects = transaction.objectStore("projects");
    const versions = transaction.objectStore("versions");
    const [project, existing] = await Promise.all([
      projects.get(projectId),
      versions.index("projectId").getAll(projectId)
    ]);
    if (!project || project.archived) throw new Error("当前项目不存在或已归档");
    const records = versionRecordsFromPlan({ projectId, plan, parentVersionId, existingVersions: existing });
    if (!records.length) {
      await transaction.done;
      return existing.map(sanitizeVersionRecord);
    }
    const mergedIds = new Set([...existing.map((entry) => entry.id), ...records.map((entry) => entry.id)]);
    if (mergedIds.size > PROJECT_LIMITS.maxVersionsPerProject) throw new Error("当前项目测试版本超过 500 条上限");
    await Promise.all([...records.map((record) => versions.put(record)), transaction.done]);
    return listVersions(projectId);
  }

  async function importResults(projectId, rows, importedAt = new Date().toISOString()) {
    const transaction = database.transaction(["projects", "versions", "results"], "readwrite");
    const projectStore = transaction.objectStore("projects");
    const versionStore = transaction.objectStore("versions");
    const resultStore = transaction.objectStore("results");
    const [project, versions, existing] = await Promise.all([
      projectStore.get(projectId),
      versionStore.index("projectId").getAll(projectId),
      resultStore.index("projectId").getAll(projectId)
    ]);
    if (!project || project.archived) throw new Error("当前项目不存在或已归档");
    const known = new Set(versions.map((version) => version.testId));
    const records = rows.map((row) => {
      if (!known.has(row.testId)) throw new Error(`测试编号不属于当前项目：${row.testId}`);
      return createResultRecord({ projectId, testId: row.testId, metrics: row.metrics, qualityWarnings: row.qualityWarnings, importedAt });
    });
    if (new Set([...existing.map((entry) => entry.id), ...records.map((entry) => entry.id)]).size > PROJECT_LIMITS.maxResultsPerProject) throw new Error("当前项目结果记录超过 500 条上限");
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt: importedAt });
    await Promise.all([...records.map((record) => resultStore.put(record)), projectStore.put(nextProject), transaction.done]);
    return listResults(projectId);
  }

  async function setVersionDecision(projectId, testId, decision, updatedAt = new Date().toISOString()) {
    const id = versionRecordId(projectId, testId);
    const transaction = database.transaction(["projects", "versions"], "readwrite");
    const projects = transaction.objectStore("projects");
    const versions = transaction.objectStore("versions");
    const [project, version] = await Promise.all([projects.get(projectId), versions.get(id)]);
    if (!project || project.archived || !version || version.projectId !== projectId) {
      throw new Error("目标测试版本不存在或不属于当前项目");
    }
    const nextVersion = sanitizeVersionRecord({ ...version, decision, updatedAt });
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt });
    await Promise.all([versions.put(nextVersion), projects.put(nextProject), transaction.done]);
    return nextVersion;
  }

  async function setVersionProductionStatus(projectId, testId, productionStatus, updatedAt = new Date().toISOString()) {
    const id = versionRecordId(projectId, testId);
    const transaction = database.transaction(["projects", "versions"], "readwrite");
    const projects = transaction.objectStore("projects");
    const versions = transaction.objectStore("versions");
    const [project, version] = await Promise.all([projects.get(projectId), versions.get(id)]);
    if (!project || project.archived || !version || version.projectId !== projectId) {
      throw new Error("目标测试版本不存在或不属于当前项目");
    }
    const nextVersion = sanitizeVersionRecord({ ...version, productionStatus, updatedAt });
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt });
    await Promise.all([versions.put(nextVersion), projects.put(nextProject), transaction.done]);
    return nextVersion;
  }

  function takeReviewSourceMatches(left, right) {
    return left.planFingerprint === right.planFingerprint
      && left.versionFingerprint === right.versionFingerprint
      && left.reviewFingerprint === right.reviewFingerprint;
  }

  function takeReviewDraftFromRecord(record, handoffRole = record.handoffRole) {
    return {
      materialCode: record.materialCode,
      takeNumber: record.takeNumber,
      checks: record.checks,
      outcome: record.outcome,
      handoffRole,
      issueTimecode: record.issueTimecode,
      nextCorrection: record.nextCorrection,
      ownerRole: record.ownerRole,
      expectedRevision: record.revision
    };
  }

  function takeReviewRecordSetSnapshotMatches(records, expectedRecords) {
    if (!Array.isArray(expectedRecords)) return false;
    const expected = new Map();
    for (const candidate of expectedRecords) {
      const id = String(candidate?.id || "");
      const revision = Number(candidate?.revision);
      const createdOrder = Number(candidate?.createdOrder || 0);
      const contentSnapshot = String(candidate?.contentSnapshot || "");
      if (!id || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(createdOrder) || createdOrder < 0 || !contentSnapshot || expected.has(id)) return false;
      expected.set(id, { revision, createdOrder, contentSnapshot });
    }
    return expected.size === records.length
      && records.every((record) => {
        const candidate = expected.get(record.id);
        return candidate?.revision === record.revision
          && candidate.createdOrder === (record.createdOrder || 0)
          && candidate.contentSnapshot === takeReviewRecordSnapshot(record);
      });
  }

  function takeReviewPlanContext(project, version, testId) {
    const plan = project.workspace.creativePlan;
    if (!plan?.items?.length) throw new Error("当前项目没有可用的拍摄方案");
    if (!takeReviewPlanMatchesWorkspace(plan, project.workspace)) throw new Error("当前拍摄方案的创作上下文已变化，请返回侧边栏重新生成方案");
    const itemIndex = plan.items.findIndex((item) => item.id === testId);
    if (itemIndex < 0) throw new Error("过条记录对应的测试版本不在当前方案中");
    if (!takeReviewVersionMatchesPlan(version, plan)) throw new Error("当前拍摄方案尚未完整同步到版本库，请返回侧边栏重试保存");
    return { plan, review: buildDirectorTakeReview(plan, { itemIndex }), version };
  }

  async function saveTakeReview(projectId, testId, draft, {
    takeId,
    expectedRevision = draft?.expectedRevision ?? 0,
    expectedPlanFingerprint,
    expectedVersionRecords,
    replaceHandoffRole = false,
    expectedRoleConflict,
    now = new Date().toISOString(),
    randomUUID
  } = {}) {
    const transaction = database.transaction(["projects", "versions", "takeReviews"], "readwrite");
    const projects = transaction.objectStore("projects");
    const versions = transaction.objectStore("versions");
    const takeReviews = transaction.objectStore("takeReviews");
    const versionId = versionRecordId(projectId, testId);
    const [storedProject, storedVersion, storedRecords] = await Promise.all([
      projects.get(projectId),
      versions.get(versionId),
      takeReviews.index("projectId").getAll(projectId)
    ]);
    if (!storedProject || storedProject.archived) throw new Error("当前项目不存在或已归档");
    if (!storedVersion || storedVersion.projectId !== projectId || storedVersion.testId !== testId) throw new Error("目标测试版本不存在或不属于当前项目");
    const project = sanitizeProjectRecord(storedProject);
    const version = sanitizeVersionRecord(storedVersion);
    const existing = storedRecords.map(sanitizeTakeReviewRecord);
    const existingVersionRecords = existing.filter((record) => record.projectId === projectId && record.source.testId === testId);
    const context = takeReviewPlanContext(project, version, testId);
    const currentPlanFingerprint = takeReviewPlanFingerprint(context.plan);
    if (!expectedPlanFingerprint || expectedPlanFingerprint !== currentPlanFingerprint) throw new Error("当前拍摄方案已变化，请重新载入过条台后再保存");
    if (!takeReviewRecordSetSnapshotMatches(existingVersionRecords, expectedVersionRecords)) {
      throw new Error("本版本过条记录已在其他页面变化，请重新载入后再保存");
    }
    const next = createTakeReviewRecord({
      id: takeId,
      projectId,
      version,
      plan: context.plan,
      review: context.review,
      draft: { ...draft, expectedRevision },
      existing,
      now,
      randomUUID
    });
    if (!takeId && await takeReviews.get(next.id)) throw new Error("过条记录编号冲突，请重试");
    const roleConflicts = next.handoffRole === "none" ? [] : existing.filter((record) => (
      record.id !== next.id
      && record.projectId === projectId
      && record.source.testId === testId
      && record.handoffRole === next.handoffRole
      && takeReviewSourceMatches(record.source, next.source)
    ));
    if (next.handoffRole !== "none") {
      const conflict = roleConflicts.length === 1 ? roleConflicts[0] : null;
      const expectationMatches = conflict
        ? expectedRoleConflict?.id === conflict.id && expectedRoleConflict?.revision === conflict.revision
        : expectedRoleConflict === null;
      if (!expectationMatches || roleConflicts.length > 1) throw new Error("人工首选或备选已在其他页面变化，请重新载入并再次确认");
    }
    if (roleConflicts.length && !replaceHandoffRole) throw new Error(`当前版本已有人工${next.handoffRole === "primary" ? "首选" : "备选"} Take；请明确确认后再替换`);
    const replacements = roleConflicts.map((record) => createTakeReviewRecord({
      id: record.id,
      projectId,
      version,
      plan: context.plan,
      review: context.review,
      draft: takeReviewDraftFromRecord(record, "none"),
      existing,
      now
    }));
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt: now });
    await Promise.all([
      ...replacements.map((record) => takeReviews.put(record)),
      takeReviews.put(next),
      projects.put(nextProject),
      transaction.done
    ]);
    return sanitizeTakeReviewRecord(next);
  }

  async function deleteTakeReview(projectId, takeId, { expectedRevision, expectedContentSnapshot, expectedPlanFingerprint, now = new Date().toISOString() } = {}) {
    const transaction = database.transaction(["projects", "versions", "takeReviews"], "readwrite");
    const projects = transaction.objectStore("projects");
    const versions = transaction.objectStore("versions");
    const takeReviews = transaction.objectStore("takeReviews");
    const [storedProject, storedRecord, storedVersions] = await Promise.all([
      projects.get(projectId),
      takeReviews.get(takeId),
      versions.index("projectId").getAll(projectId)
    ]);
    if (!storedProject || storedProject.archived) throw new Error("当前项目不存在或已归档");
    if (!storedRecord) throw new Error("要删除的过条记录已不存在");
    const project = sanitizeProjectRecord(storedProject);
    const record = sanitizeTakeReviewRecord(storedRecord);
    if (record.projectId !== projectId) throw new Error("过条记录不属于当前项目");
    if (!Number.isInteger(expectedRevision) || expectedRevision !== record.revision) throw new Error("过条记录已在其他页面更新，请重新载入后再删除");
    if (!expectedContentSnapshot || expectedContentSnapshot !== takeReviewRecordSnapshot(record)) throw new Error("过条记录内容已在其他页面变化，请重新载入后再删除");
    const version = storedVersions.map(sanitizeVersionRecord).find((entry) => entry.testId === record.source.testId);
    if (!version) throw new Error("过条记录对应的测试版本已不存在");
    const context = takeReviewPlanContext(project, version, record.source.testId);
    if (!expectedPlanFingerprint || expectedPlanFingerprint !== takeReviewPlanFingerprint(context.plan)) throw new Error("当前拍摄方案已变化，请重新载入过条台后再删除");
    if (!assessTakeReviewRecord(record, context).current) throw new Error("来源方案已变化，旧过条记录只读");
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt: now });
    await Promise.all([takeReviews.delete(takeId), projects.put(nextProject), transaction.done]);
    return record;
  }

  async function clearTakeReviewBatch(projectId, batchId, { expectedPlanFingerprint, expectedRecords, now = new Date().toISOString() } = {}) {
    const transaction = database.transaction(["projects", "takeReviews"], "readwrite");
    const projects = transaction.objectStore("projects");
    const takeReviews = transaction.objectStore("takeReviews");
    const [storedProject, storedRecords] = await Promise.all([
      projects.get(projectId),
      takeReviews.index("projectId").getAll(projectId)
    ]);
    if (!storedProject || storedProject.archived) throw new Error("当前项目不存在或已归档");
    const project = sanitizeProjectRecord(storedProject);
    const plan = project.workspace.creativePlan;
    if (!plan?.items?.length || plan.batchId !== batchId) throw new Error("要清空的过条批次不是当前项目方案");
    if (!takeReviewPlanMatchesWorkspace(plan, project.workspace)) throw new Error("当前拍摄方案的创作上下文已变化，请返回侧边栏重新生成方案");
    const currentPlanFingerprint = takeReviewPlanFingerprint(plan);
    if (!expectedPlanFingerprint || expectedPlanFingerprint !== currentPlanFingerprint) throw new Error("当前拍摄方案已变化，请重新载入过条台后再清空");
    const records = storedRecords.map(sanitizeTakeReviewRecord).filter((record) => (
      record.source.batchId === batchId && record.source.planFingerprint === currentPlanFingerprint
    ));
    if (!takeReviewRecordSetSnapshotMatches(records, expectedRecords)) throw new Error("本批过条记录已在其他页面变化，请重新载入并再次确认清空");
    if (!records.length) {
      await transaction.done;
      return 0;
    }
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt: now });
    await Promise.all([...records.map((record) => takeReviews.delete(record.id)), projects.put(nextProject), transaction.done]);
    return records.length;
  }

  async function deleteHistoricalTakeReviewGroup(projectId, { batchId, planFingerprint } = {}, {
    expectedPlanFingerprint,
    expectedRecords,
    now = new Date().toISOString()
  } = {}) {
    const transaction = database.transaction(["projects", "takeReviews"], "readwrite");
    const projects = transaction.objectStore("projects");
    const takeReviews = transaction.objectStore("takeReviews");
    const [storedProject, storedRecords] = await Promise.all([
      projects.get(projectId),
      takeReviews.index("projectId").getAll(projectId)
    ]);
    if (!storedProject || storedProject.archived) throw new Error("当前项目不存在或已归档");
    const project = sanitizeProjectRecord(storedProject);
    const plan = project.workspace.creativePlan;
    if (!plan?.items?.length || !takeReviewPlanMatchesWorkspace(plan, project.workspace)) {
      throw new Error("当前拍摄方案已变化，请返回侧边栏重新生成并保存方案");
    }
    const currentPlanFingerprint = takeReviewPlanFingerprint(plan);
    if (!expectedPlanFingerprint || expectedPlanFingerprint !== currentPlanFingerprint) {
      throw new Error("当前拍摄方案已变化，请重新载入过条台后再管理历史记录");
    }
    const cleanRecords = storedRecords.map(sanitizeTakeReviewRecord);
    const history = summarizeTakeReviewHistory({
      projectId,
      currentBatchId: plan.batchId,
      currentPlanFingerprint,
      records: cleanRecords
    });
    const targetBatchId = String(batchId || "");
    const targetPlanFingerprint = String(planFingerprint || "");
    if (targetBatchId === plan.batchId && targetPlanFingerprint === currentPlanFingerprint) {
      throw new Error("当前方案来源不能从历史记录入口删除");
    }
    const group = history.groups.find((entry) => entry.batchId === targetBatchId && entry.planFingerprint === targetPlanFingerprint);
    if (!group) throw new Error("目标历史记录组已不存在，请重新载入后再操作");
    const records = cleanRecords.filter((record) => (
      record.source.batchId === targetBatchId && record.source.planFingerprint === targetPlanFingerprint
    ));
    if (!takeReviewRecordSetSnapshotMatches(records, expectedRecords)) {
      throw new Error("目标历史记录组已在其他页面变化，请重新载入并再次确认删除");
    }
    const nextProject = sanitizeProjectRecord({ ...project, updatedAt: now });
    await Promise.all([...records.map((record) => takeReviews.delete(record.id)), projects.put(nextProject), transaction.done]);
    return { batchId: targetBatchId, planFingerprint: targetPlanFingerprint, deletedCount: records.length };
  }

  async function setProjectContentPriority(projectId, { lane, reason, dueOn = null } = {}, now = new Date().toISOString()) {
    const transaction = database.transaction("projects", "readwrite");
    const projects = transaction.store;
    const [storedProject, storedProjects] = await Promise.all([projects.get(projectId), projects.getAll()]);
    if (!storedProject || storedProject.archived) throw new Error("项目不存在或已归档");

    const project = sanitizeProjectRecord(storedProject);
    const current = sanitizeContentPriority(project.contentPriority, { allowNull: true });
    let manualOrder = current?.lane === lane ? current.manualOrder : null;
    if (manualOrder === null) {
      const laneOrders = storedProjects
        .filter((candidate) => candidate?.id !== project.id && candidate?.archived !== true)
        .map((candidate) => sanitizeContentPriority(candidate?.contentPriority, { allowNull: true }))
        .filter((priority) => priority?.lane === lane)
        .map((priority) => priority.manualOrder);
      manualOrder = laneOrders.length ? Math.max(...laneOrders) + 1 : 0;
    }

    const contentPriority = createContentPriority({ project, lane, reason, dueOn, manualOrder, now });
    const nextProject = sanitizeProjectRecord({ ...project, contentPriority, updatedAt: now });
    await Promise.all([projects.put(nextProject), transaction.done]);
    return sanitizeProjectRecord(nextProject);
  }

  async function moveProjectContentPriority(projectId, direction, now = new Date().toISOString()) {
    if (direction !== "up" && direction !== "down") throw new Error("内容排期移动方向无效");
    const transaction = database.transaction("projects", "readwrite");
    const projects = transaction.store;
    const storedProjects = await projects.getAll();
    const targetProject = storedProjects.find((project) => project?.id === projectId);
    if (!targetProject || targetProject.archived) throw new Error("项目不存在或已归档");
    const targetPriority = sanitizeContentPriority(targetProject.contentPriority, { allowNull: true });
    if (!targetPriority) throw new Error("项目尚未设置内容排期");

    const laneProjects = storedProjects
      .filter((project) => project?.archived !== true)
      .map((project) => ({ project, priority: sanitizeContentPriority(project?.contentPriority, { allowNull: true }) }))
      .filter((entry) => entry.priority?.lane === targetPriority.lane)
      .sort((left, right) => left.priority.manualOrder - right.priority.manualOrder || String(left.project.id).localeCompare(String(right.project.id)));
    const currentIndex = laneProjects.findIndex((entry) => entry.project.id === projectId);
    if (currentIndex < 0) throw new Error("项目内容排期泳道不一致");
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= laneProjects.length) {
      await transaction.done;
      return listProjects();
    }

    const neighborId = laneProjects[nextIndex].project.id;
    [laneProjects[currentIndex], laneProjects[nextIndex]] = [laneProjects[nextIndex], laneProjects[currentIndex]];
    const writes = laneProjects.flatMap(({ project, priority }, index) => {
      if (priority.manualOrder === index && project.id !== projectId && project.id !== neighborId) return [];
      const contentPriority = sanitizeContentPriority({ ...priority, manualOrder: index, updatedAt: now }, { allowNull: false });
      const nextProject = sanitizeProjectRecord({ ...project, contentPriority, updatedAt: now });
      return [projects.put(nextProject)];
    });
    await Promise.all([...writes, transaction.done]);
    return listProjects();
  }

  async function clearProjectContentPriority(projectId, now = new Date().toISOString()) {
    const transaction = database.transaction("projects", "readwrite");
    const projects = transaction.store;
    const storedProject = await projects.get(projectId);
    if (!storedProject || storedProject.archived) throw new Error("项目不存在或已归档");
    const project = sanitizeProjectRecord(storedProject);
    const nextProject = sanitizeProjectRecord({ ...project, contentPriority: null, updatedAt: now });
    await Promise.all([projects.put(nextProject), transaction.done]);
    return sanitizeProjectRecord(nextProject);
  }

  async function exportPortfolio() {
    const transaction = database.transaction(["projects", "versions", "results", "takeReviews", "meta"], "readonly");
    const [storedProjects, versions, results, takeReviews, currentMeta] = await Promise.all([
      transaction.objectStore("projects").getAll(),
      transaction.objectStore("versions").getAll(),
      transaction.objectStore("results").getAll(),
      transaction.objectStore("takeReviews").getAll(),
      transaction.objectStore("meta").get(CURRENT_PROJECT_META_KEY)
    ]);
    await transaction.done;
    const projects = storedProjects.filter((project) => !project.archived).map(sanitizeProjectRecord);
    return validateProjectPortfolio({
      schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION,
      currentProjectId: currentMeta?.value,
      projects,
      versions,
      results,
      takeReviews
    });
  }

  async function replacePortfolio(value) {
    const portfolio = validateProjectPortfolio(value);
    const transaction = database.transaction(["projects", "versions", "results", "takeReviews", "meta"], "readwrite");
    const operations = [
      transaction.objectStore("projects").clear(),
      transaction.objectStore("versions").clear(),
      transaction.objectStore("results").clear(),
      transaction.objectStore("takeReviews").clear(),
      transaction.objectStore("meta").clear()
    ];
    for (const project of portfolio.projects) operations.push(transaction.objectStore("projects").put(project));
    for (const version of portfolio.versions) operations.push(transaction.objectStore("versions").put(version));
    for (const result of portfolio.results) operations.push(transaction.objectStore("results").put(result));
    for (const takeReview of portfolio.takeReviews) operations.push(transaction.objectStore("takeReviews").put(takeReview));
    operations.push(transaction.objectStore("meta").put({ key: CURRENT_PROJECT_META_KEY, value: portfolio.currentProjectId }));
    operations.push(transaction.objectStore("meta").put({ key: PENDING_PROJECT_META_KEY, value: portfolio.currentProjectId }));
    await Promise.all([...operations, transaction.done]);
    return portfolio;
  }

  return {
    initialize,
    listProjects,
    currentProject,
    getProject,
    saveWorkspace,
    createProject,
    renameProject,
    requestSwitch,
    listVersions,
    listResults,
    listTakeReviews,
    getTakeReviewSnapshot,
    syncPlan,
    importResults,
    setVersionDecision,
    setVersionProductionStatus,
    saveTakeReview,
    deleteTakeReview,
    clearTakeReviewBatch,
    deleteHistoricalTakeReviewGroup,
    setProjectContentPriority,
    moveProjectContentPriority,
    clearProjectContentPriority,
    exportPortfolio,
    replacePortfolio
  };
}
