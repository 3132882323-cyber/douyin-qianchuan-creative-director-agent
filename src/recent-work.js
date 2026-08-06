function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function buildRecentWorkModel({
  hasCreativeTask = false,
  hasAnalysis = false,
  analysisCount = 0,
  reviewPending = false,
  planCount = 0,
  planStale = false,
  planExported = false
} = {}) {
  const creatives = count(analysisCount);
  const plans = count(planCount);
  const reviewAvailable = Boolean(hasAnalysis) || creatives > 0;

  if (reviewPending) {
    return {
      kind: "review-pending",
      title: "当前复盘尚未完成",
      description: "报表、标签或目标已经变化；请先完成复盘，再继续生成下一版任务。",
      action: "继续完成复盘",
      targetView: "review",
      focusId: "analyze-button"
    };
  }

  if (plans && planStale && !reviewAvailable) {
    return {
      kind: "review-missing",
      title: "旧任务缺少可用复盘",
      description: `当前工作区仍保留 ${plans} 个旧方案供对照，但没有可用于重新生成的复盘摘要。`,
      action: "重新导入历史素材",
      targetView: "review",
      focusId: "report-file-trigger"
    };
  }

  if (plans && planStale) {
    return {
      kind: "plan-stale",
      title: "最近任务需要重新生成",
      description: `当前工作区仍保留 ${plans} 个旧方案供对照，但它们与最新复盘或创作条件不一致。`,
      action: "重新生成任务",
      targetView: "next",
      focusId: "generate-plan"
    };
  }

  if (plans && !planExported) {
    return {
      kind: "plan-ready",
      title: "下一版任务待检查",
      description: `当前工作区有 ${plans} 个可继续编辑、复制或导出的拍摄方案。`,
      action: "继续检查任务",
      targetView: "next",
      focusId: "copy-plan"
    };
  }

  if (plans && planExported) {
    return {
      kind: "round-complete",
      title: "最近一轮已经导出",
      description: `当前工作区保留 ${plans} 个已完成方案；可以导入新结果开始下一轮。`,
      action: "开始下一轮复盘",
      targetView: "review",
      focusId: "report-file-trigger"
    };
  }

  if (reviewAvailable) {
    return {
      kind: "review-ready",
      title: "最近复盘可以继续",
      description: creatives
        ? `当前工作区有 ${creatives} 条历史素材复盘，可继续生成下一版任务。`
        : "当前工作区已有可用历史素材复盘，可继续生成下一版任务。",
      action: "继续生成任务",
      targetView: "next",
      focusId: "generate-plan"
    };
  }

  if (hasCreativeTask) {
    return {
      kind: "task-ready",
      title: "创作任务已经准备好",
      description: "当前工作区保留了一份可选创作任务；下一步可以导入历史素材。",
      action: "导入历史素材",
      targetView: "review",
      focusId: "report-file-trigger"
    };
  }

  return {
    kind: "empty",
    title: "暂无可继续的编导任务",
    description: "当前浏览器没有最近编导项目；独立工作台的视频、转写和处理队列不会在这里伪装成可恢复任务。",
    action: "从历史复盘开始",
    targetView: "review",
    focusId: "report-file-trigger"
  };
}
