import { migrateLegacyProductBrief, normalizeCreativeTask } from "./core.js";
import {
  sanitizedAnalysis,
  sanitizedCreativePlan,
  sanitizedLastUpdateCheck,
  sanitizedTargetRoi,
  sanitizedUpdateSettings
} from "./update.js";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function activeTask(value) {
  const normalized = normalizeCreativeTask(value);
  if (isRecord(value?._migration)) normalized._migration = value._migration;
  return normalized;
}

function issue(issues, invalidKeys, key, message, { removable = true } = {}) {
  issues.push({ key, message });
  if (removable && key) invalidKeys.push(key);
}

export function recoverStoredWorkspace(input = {}) {
  const storage = isRecord(input) ? input : {};
  const issues = [];
  const invalidKeys = [];
  const cleanupKeys = [];
  const writes = {};
  let migrated = false;

  let legacyTask = null;
  if (isRecord(storage.productBrief)) {
    try {
      legacyTask = migrateLegacyProductBrief(storage.productBrief);
    } catch {
      legacyTask = null;
    }
  }
  const validLegacyTask = Boolean(legacyTask);
  const currentTaskValid = storage.creativeTask === undefined || isRecord(storage.creativeTask);
  let creativeTask = currentTaskValid && isRecord(storage.creativeTask) ? activeTask(storage.creativeTask) : {};
  if (!currentTaskValid) issue(issues, invalidKeys, "creativeTask", validLegacyTask ? "创作任务记录损坏，已从兼容旧资料恢复" : "已忽略损坏的创作任务记录", { removable: !validLegacyTask });

  if (storage.productBrief !== undefined) {
    if (validLegacyTask) {
      if (!currentTaskValid || !isRecord(storage.creativeTask)) {
        creativeTask = legacyTask;
      } else if (!creativeTask._migration?.archivedLegacyData) {
        creativeTask = { ...creativeTask, _migration: legacyTask._migration };
      }
      writes.creativeTask = creativeTask;
      cleanupKeys.push("productBrief");
      migrated = true;
    } else {
      issue(issues, invalidKeys, "productBrief", "检测到无法识别的旧版资料；未自动删除，可由你确认清理");
    }
  }

  let targetRoi = 1.5;
  if (storage.targetRoi !== undefined) {
    const parsed = Number(storage.targetRoi);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100000) targetRoi = sanitizedTargetRoi(parsed);
    else issue(issues, invalidKeys, "targetRoi", "目标 ROI 记录无效，已临时恢复为 1.5");
  }

  let lastAnalysis = null;
  if (storage.lastAnalysis !== undefined && storage.lastAnalysis !== null) {
    try {
      const recovered = sanitizedAnalysis(storage.lastAnalysis);
      if (!recovered.topCreatives.length) throw new Error("复盘记录缺少可用素材");
      lastAnalysis = recovered;
    } catch (error) {
      issue(issues, invalidKeys, "lastAnalysis", `已隔离损坏的复盘摘要：${error.message || "格式无效"}`);
    }
  }

  let creativePlan = null;
  if (storage.creativePlan !== undefined && storage.creativePlan !== null) {
    try {
      const recovered = sanitizedCreativePlan(storage.creativePlan);
      if (!recovered.items.length) throw new Error("任务列表为空");
      creativePlan = recovered;
    } catch (error) {
      issue(issues, invalidKeys, "creativePlan", `已隔离损坏的下一版任务：${error.message || "格式无效"}`);
    }
  }

  let updateSettings = { autoCheck: false };
  if (storage.updateSettings !== undefined) {
    try {
      updateSettings = sanitizedUpdateSettings(storage.updateSettings);
    } catch {
      issue(issues, invalidKeys, "updateSettings", "更新设置无效，已临时关闭自动检查");
    }
  }

  let lastUpdateCheck = null;
  if (storage.lastUpdateCheck !== undefined && storage.lastUpdateCheck !== null) {
    try {
      lastUpdateCheck = sanitizedLastUpdateCheck(storage.lastUpdateCheck);
      if (!lastUpdateCheck?.checkedAt) throw new Error("缺少检查时间");
    } catch {
      issue(issues, invalidKeys, "lastUpdateCheck", "版本检查记录无效，已忽略该记录");
    }
  }

  let planExportReceipt = null;
  if (storage.planExportReceipt !== undefined && storage.planExportReceipt !== null) {
    if (isRecord(storage.planExportReceipt) && /^[a-z0-9:_-]{1,128}$/iu.test(storage.planExportReceipt.fingerprint || "")) {
      planExportReceipt = {
        fingerprint: storage.planExportReceipt.fingerprint,
        completedAt: String(storage.planExportReceipt.completedAt || "").slice(0, 64)
      };
    } else {
      issue(issues, invalidKeys, "planExportReceipt", "导出完成记录无效，已恢复为未完成状态");
    }
  }

  let onboardingDismissed = false;
  if (storage.onboardingDismissed !== undefined) {
    if (typeof storage.onboardingDismissed === "boolean") onboardingDismissed = storage.onboardingDismissed;
    else issue(issues, invalidKeys, "onboardingDismissed", "新手引导设置无效，将重新显示引导");
  }

  let migrationNoticePending = false;
  if (storage.migrationNoticePending !== undefined) {
    if (typeof storage.migrationNoticePending === "boolean") migrationNoticePending = storage.migrationNoticePending;
    else issue(issues, invalidKeys, "migrationNoticePending", "迁移提示状态无效，已恢复为未显示");
  }

  return {
    data: {
      creativeTask,
      targetRoi,
      lastAnalysis,
      creativePlan,
      updateSettings,
      lastUpdateCheck,
      planExportReceipt,
      onboardingDismissed,
      migrationNoticePending
    },
    issues,
    invalidKeys: [...new Set(invalidKeys)],
    cleanupKeys: [...new Set(cleanupKeys)],
    writes,
    migrated
  };
}
