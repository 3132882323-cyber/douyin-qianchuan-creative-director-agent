import { buildContentPriorityBoard } from "./content-priority.js";

const DEFAULT_MAX_ATTEMPTS = 2;

function assertRepository(repository) {
  if (!repository || typeof repository.listProjects !== "function" || typeof repository.getTakeReviewSnapshot !== "function") {
    throw new Error("跨项目生产快照读取器不可用");
  }
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSavedProject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotFingerprint(snapshot) {
  const versions = [...snapshot.versions].sort((left, right) => {
    const leftKey = `${String(left?.projectId || "")}\u0000${String(left?.testId || "")}`;
    const rightKey = `${String(right?.projectId || "")}\u0000${String(right?.testId || "")}`;
    return leftKey.localeCompare(rightKey);
  });
  const records = [...snapshot.records].sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
  return JSON.stringify({ project: snapshot.project, versions, records });
}

function projectError(error) {
  return String(error?.message || "本地项目记录暂时无法读取").slice(0, 240);
}

function validateProjectSnapshot(projectId, snapshot) {
  if (!snapshot?.project || snapshot.project.id !== projectId || !Array.isArray(snapshot.versions) || !Array.isArray(snapshot.records)) {
    throw new Error("本地项目快照结构不完整");
  }
  const testIds = new Set();
  for (const version of snapshot.versions) {
    const testId = String(version?.testId || "");
    if (version?.projectId !== projectId || !testId) throw new Error("本地项目快照包含错误版本引用");
    if (testIds.has(testId)) throw new Error("本地项目快照包含重复测试版本");
    testIds.add(testId);
  }
  const recordIds = new Set();
  for (const record of snapshot.records) {
    const recordId = String(record?.id || "");
    const testId = String(record?.source?.testId || "");
    if (record?.projectId !== projectId || !recordId || !testIds.has(testId)) {
      throw new Error("本地项目快照包含孤立的人工过条记录");
    }
    if (recordIds.has(recordId)) throw new Error("本地项目快照包含重复人工过条记录");
    recordIds.add(recordId);
  }
  return snapshot;
}

/**
 * Reads the local project list to derive manual priority, then reads versions
 * and Take records only for the valid "立即做" Top 3. Each selected project's
 * project/version/Take records come from its own read-only transaction. Two
 * matching snapshots plus a final project-list read are required before the
 * queue is returned. No experiment-result store or media is read.
 */
export async function readProductionCommandSnapshot(repository, {
  currentProjectId,
  today,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
} = {}) {
  assertRepository(repository);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("跨项目生产快照重试次数无效");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const initialProjects = await repository.listProjects();
    const initialBoard = buildContentPriorityBoard(initialProjects, { currentProjectId, today });
    const requestedIds = initialBoard.topNow.map((entry) => entry.projectId);
    const firstSettled = await Promise.allSettled(requestedIds.map((projectId) => repository.getTakeReviewSnapshot(projectId)));
    const latestProjects = await repository.listProjects();
    const latestBoard = buildContentPriorityBoard(latestProjects, { currentProjectId, today });
    const latestIds = latestBoard.topNow.map((entry) => entry.projectId);
    if (!sameIds(requestedIds, latestIds)) {
      if (attempt + 1 < maxAttempts) continue;
      throw new Error("人工排期刚刚发生变化，请刷新后重试");
    }

    const verificationSettled = await Promise.allSettled(requestedIds.map((projectId) => repository.getTakeReviewSnapshot(projectId)));
    const finalProjects = await repository.listProjects();
    const finalBoard = buildContentPriorityBoard(finalProjects, { currentProjectId, today });
    const finalIds = finalBoard.topNow.map((entry) => entry.projectId);
    if (!sameIds(requestedIds, finalIds)) {
      if (attempt + 1 < maxAttempts) continue;
      throw new Error("人工排期刚刚发生变化，请刷新后重试");
    }

    const finalById = new Map(finalProjects.map((project) => [project.id, project]));
    const versions = [];
    const takeReviews = [];
    const projectErrors = {};
    let changedDuringRead = false;

    firstSettled.forEach((firstResult, index) => {
      const projectId = requestedIds[index];
      const verificationResult = verificationSettled[index];
      let firstSnapshot;
      let verifiedSnapshot;
      let firstError = null;
      let verificationError = null;
      try {
        if (firstResult.status === "rejected") throw firstResult.reason;
        firstSnapshot = validateProjectSnapshot(projectId, firstResult.value);
      } catch (error) {
        firstError = projectError(error);
      }
      try {
        if (verificationResult.status === "rejected") throw verificationResult.reason;
        verifiedSnapshot = validateProjectSnapshot(projectId, verificationResult.value);
      } catch (error) {
        verificationError = projectError(error);
      }
      if (firstError || verificationError) {
        projectErrors[projectId] = verificationError || firstError;
        return;
      }
      if (
        snapshotFingerprint(firstSnapshot) !== snapshotFingerprint(verifiedSnapshot)
        || !sameSavedProject(verifiedSnapshot.project, finalById.get(projectId))
      ) {
        changedDuringRead = true;
        return;
      }
      versions.push(...verifiedSnapshot.versions);
      takeReviews.push(...verifiedSnapshot.records);
    });

    if (changedDuringRead) {
      if (attempt + 1 < maxAttempts) continue;
      throw new Error("今日项目在读取期间发生变化，请刷新后重试");
    }

    return {
      currentProjectId,
      projects: finalProjects,
      versions,
      takeReviews,
      projectErrors
    };
  }

  throw new Error("跨项目生产快照暂时无法稳定读取");
}
