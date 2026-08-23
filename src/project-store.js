import { openDB } from "../vendor/idb.js";
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
  validateProjectPortfolio,
  versionRecordsFromPlan
} from "./project-model.js";

export const PROJECT_DB_NAME = "qianchuan-creative-director-projects";
export const PROJECT_DB_VERSION = 1;
const CURRENT_PROJECT_META_KEY = "currentProjectId";
const PENDING_PROJECT_META_KEY = "pendingProjectId";

export async function openProjectDatabase() {
  return openDB(PROJECT_DB_NAME, PROJECT_DB_VERSION, {
    upgrade(database) {
      const projects = database.createObjectStore("projects", { keyPath: "id" });
      projects.createIndex("updatedAt", "updatedAt");
      const versions = database.createObjectStore("versions", { keyPath: "id" });
      versions.createIndex("projectId", "projectId");
      const results = database.createObjectStore("results", { keyPath: "id" });
      results.createIndex("projectId", "projectId");
      database.createObjectStore("meta", { keyPath: "key" });
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
    return currentId ? database.get("projects", currentId) : null;
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
    const current = await database.get("projects", projectId);
    if (!current || current.archived) throw new Error("当前项目不存在或已归档");
    const project = sanitizeProjectRecord({ ...current, updatedAt: now, workspace: sanitizeProjectWorkspace(workspace) });
    await database.put("projects", project);
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
    const project = await database.get("projects", projectId);
    if (!project || project.archived) throw new Error("项目不存在或已归档");
    const next = sanitizeProjectRecord({ ...project, name: sanitizeProjectName(name), updatedAt: now });
    await database.put("projects", next);
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

  async function syncPlan(projectId, plan, parentVersionId) {
    const existing = await listVersions(projectId);
    const records = versionRecordsFromPlan({ projectId, plan, parentVersionId, existingVersions: existing });
    if (!records.length) return existing;
    const mergedIds = new Set([...existing.map((entry) => entry.id), ...records.map((entry) => entry.id)]);
    if (mergedIds.size > PROJECT_LIMITS.maxVersionsPerProject) throw new Error("当前项目测试版本超过 500 条上限");
    const transaction = database.transaction("versions", "readwrite");
    await Promise.all([...records.map((record) => transaction.store.put(record)), transaction.done]);
    return listVersions(projectId);
  }

  async function importResults(projectId, rows, importedAt = new Date().toISOString()) {
    const versions = await listVersions(projectId);
    const known = new Set(versions.map((version) => version.testId));
    const records = rows.map((row) => {
      if (!known.has(row.testId)) throw new Error(`测试编号不属于当前项目：${row.testId}`);
      return createResultRecord({ projectId, testId: row.testId, metrics: row.metrics, qualityWarnings: row.qualityWarnings, importedAt });
    });
    const existing = await listResults(projectId);
    if (new Set([...existing.map((entry) => entry.id), ...records.map((entry) => entry.id)]).size > PROJECT_LIMITS.maxResultsPerProject) throw new Error("当前项目结果记录超过 500 条上限");
    const transaction = database.transaction("results", "readwrite");
    await Promise.all([...records.map((record) => transaction.store.put(record)), transaction.done]);
    return listResults(projectId);
  }

  async function exportPortfolio() {
    const projects = (await database.getAll("projects")).filter((project) => !project.archived).map(sanitizeProjectRecord);
    const current = await currentProject();
    return validateProjectPortfolio({
      schemaVersion: PROJECT_PORTFOLIO_SCHEMA_VERSION,
      currentProjectId: current?.id,
      projects,
      versions: await database.getAll("versions"),
      results: await database.getAll("results")
    });
  }

  async function replacePortfolio(value) {
    const portfolio = validateProjectPortfolio(value);
    const transaction = database.transaction(["projects", "versions", "results", "meta"], "readwrite");
    const operations = [transaction.objectStore("projects").clear(), transaction.objectStore("versions").clear(), transaction.objectStore("results").clear(), transaction.objectStore("meta").clear()];
    for (const project of portfolio.projects) operations.push(transaction.objectStore("projects").put(project));
    for (const version of portfolio.versions) operations.push(transaction.objectStore("versions").put(version));
    for (const result of portfolio.results) operations.push(transaction.objectStore("results").put(result));
    operations.push(transaction.objectStore("meta").put({ key: CURRENT_PROJECT_META_KEY, value: portfolio.currentProjectId }));
    operations.push(transaction.objectStore("meta").put({ key: PENDING_PROJECT_META_KEY, value: portfolio.currentProjectId }));
    await Promise.all([...operations, transaction.done]);
    return portfolio;
  }

  return { initialize, listProjects, currentProject, saveWorkspace, createProject, renameProject, requestSwitch, listVersions, listResults, syncPlan, importResults, exportPortfolio, replacePortfolio };
}
