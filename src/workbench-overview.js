function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function primaryAction(type, target, control, label, focus = control) {
  return { type, target, control, focus, label };
}

function workbenchDeliveryState({
  files = 0,
  hasProcessing = false,
  processingComplete = false,
  processingPrepared = false,
  processingExported = false,
  transcriptionTasks = 0,
  transcriptionExported = false,
  characters = 0,
  transcriptRecoverable = false,
  hasAnalysis = false,
  analysisPreserved = false,
  hasRevisionDraft = false,
  revisionConfirmed = false,
  revisionPreserved = false,
  handoffState = "idle"
} = {}) {
  if (handoffState === "sent") {
    return {
      tone: "success",
      label: "可拍草稿已发送到编导台",
      detail: "本次交接已进入当前浏览器会话；侧边栏仍需人工预览和确认。"
    };
  }
  if (handoffState === "conflict") {
    return {
      tone: "attention",
      label: "交付未完成",
      detail: "编导台已有另一份待确认结果，本次没有覆盖；当前草稿仍保留在本页。"
    };
  }
  if (handoffState === "failed") {
    return {
      tone: "attention",
      label: "交付失败 · 草稿仍在本页",
      detail: "可重试发送或导出交接包；关闭页面前请先保留成果。"
    };
  }
  if (hasRevisionDraft) {
    if (revisionPreserved) {
      return revisionConfirmed
        ? {
            tone: "success",
            label: "已确认草稿已导出",
            detail: "导出文件由浏览器下载记录和用户选择的本机目录管理；侧边栏尚未自动应用。"
          }
        : {
            tone: "attention",
            label: "草稿已导出 · 尚未确认",
            detail: "导出只代表文件已创建，不代表编导审核完成；请继续核对当前草稿。"
          };
    }
    return {
      tone: "attention",
      label: revisionConfirmed ? "草稿已确认 · 尚未交付" : "可拍草稿仅在本页",
      detail: revisionConfirmed
        ? "确认不等于发送；请发送到编导台或导出文件后再关闭页面。"
        : "请先人工核对并确认，再发送或导出；当前内容不会自动保存。"
    };
  }
  if (hasAnalysis) {
    return analysisPreserved
      ? {
          tone: "success",
          label: "结构分析已导出",
          detail: "导出文件已创建；若要进入制作，还需选择改进项并生成可拍草稿。"
        }
      : {
          tone: "attention",
          label: "结构分析仅在本页",
          detail: "尚未导出或发送；关闭页面前请先保留需要的成果。"
        };
  }
  if (characters) {
    return transcriptRecoverable
      ? {
          tone: "neutral",
          label: "正文可从本地文件重新导入",
          detail: "当前还没有结构分析成果；源文件不会被扩展复制或保存。"
        }
      : {
          tone: "attention",
          label: "手动转写正文仅在本页",
          detail: "当前正文不能由扩展恢复；关闭页面前请先完成并导出分析。"
        };
  }
  if (transcriptionTasks) {
    return transcriptionExported
      ? {
          tone: "success",
          label: "本机转写清单已导出",
          detail: "请在本机执行后，再导入或粘贴生成的转写文本。"
        }
      : {
          tone: "attention",
          label: "转写任务仅在本页",
          detail: "清单尚未导出；关闭页面会丢失当前任务。"
        };
  }
  if (hasProcessing) {
    if (processingComplete) {
      return {
        tone: "neutral",
        label: "本机处理结果已导入",
        detail: "当前还没有文案分析成果；下一步导入转写文本。"
      };
    }
    if (processingExported) {
      return {
        tone: "success",
        label: "本机处理清单已导出",
        detail: "请在可信设备运行仓库内执行器，再回到本页导入结果。"
      };
    }
    return {
      tone: "attention",
      label: processingPrepared ? "命令已复制 · 任务仍在本页" : "处理任务仅在本页",
      detail: "任务清单尚未导出；关闭页面前请先导出或完成本机处理。"
    };
  }
  if (files) {
    return {
      tone: "neutral",
      label: "素材选择仅在本页",
      detail: "浏览器不会保存视频引用；重新打开工作台后需要再次选择。"
    };
  }
  return {
    tone: "neutral",
    label: "尚无待交付成果",
    detail: "选择开始方式后，顶部会区分页面内成果、已导出文件和已发送交接。"
  };
}

export function buildWorkbenchResetPrompt({
  entryMode = "",
  filesCount = 0,
  processingTaskCount = 0,
  processingExported = false,
  transcriptionTaskCount = 0,
  transcriptionExported = false,
  transcriptLength = 0,
  transcriptRecoverable = false,
  hasAnalysis = false,
  analysisPreserved = false,
  hasRevisionDraft = false,
  revisionPreserved = false,
  handoffState = "idle",
  hasSetupValues = false,
  hasFeedback = false
} = {}) {
  const files = safeCount(filesCount);
  const processingTasks = safeCount(processingTaskCount);
  const transcriptionTasks = safeCount(transcriptionTaskCount);
  const characters = safeCount(transcriptLength);
  const analysis = Boolean(hasAnalysis);
  const hasHandoffState = handoffState !== "idle";
  const revision = Boolean(hasRevisionDraft);
  const hasWork = Boolean(
    entryMode || files || processingTasks || transcriptionTasks || characters || analysis || revision || hasHandoffState || hasSetupValues || hasFeedback
  );
  const atRisk = [];
  if (processingTasks && !processingExported) atRisk.push("尚未导出的处理任务");
  if (transcriptionTasks && !transcriptionExported) atRisk.push("尚未导出的转写任务");
  if (characters && !transcriptRecoverable) atRisk.push("仅存在本页的手动转写正文");
  if (analysis && !analysisPreserved && handoffState !== "sent") atRisk.push("尚未导出或成功发送的分析结果");
  if (revision && !revisionPreserved && handoffState !== "sent") atRisk.push("尚未导出或成功交接的可拍任务草稿");
  const currentItems = [];
  if (files) currentItems.push(`${files} 个视频选择`);
  if (processingTasks) currentItems.push(`${processingTasks} 项处理任务`);
  if (transcriptionTasks) currentItems.push(`${transcriptionTasks} 项转写任务`);
  if (characters) currentItems.push(`${characters.toLocaleString("zh-CN")} 字符正文`);
  if (analysis) currentItems.push("结构分析与本页交接状态");
  if (revision) currentItems.push("下一版可拍任务草稿");
  if (hasSetupValues) currentItems.push("本页路径、授权与引擎参数");

  return {
    hasWork,
    atRisk,
    message: hasWork
      ? [
          `将开始新一轮，并清空当前工作台页面内存中的${currentItems.length ? currentItems.join("、") : "入口选择、状态与提示"}。`,
          atRisk.length ? `以下内容会随本页清空且无法从扩展恢复：${atRisk.join("、")}。` : "当前页面内容将被重置。",
          "不会删除或覆盖任何本地原文件、已经下载的导出文件、chrome.storage.local 工作区、侧边栏数据，或已经发送到编导台会话收件箱的结果。是否继续？"
        ].join("\n\n")
      : ""
  };
}

export function hasWorkbenchUnloadRisk(snapshot = {}) {
  return buildWorkbenchResetPrompt(snapshot).atRisk.length > 0;
}

export function buildWorkbenchOverview({
  entryMode = "",
  filesCount = 0,
  sourceReady = false,
  missingSourceField = "files",
  processing = null,
  processingPrepared = false,
  processingExported = false,
  transcriptionTaskCount = 0,
  transcriptionExported = false,
  transcriptLength = 0,
  transcriptRecoverable = false,
  analysis = null,
  analysisPreserved = false,
  selectedRecommendationCount = 0,
  revisionDraft = null,
  revisionConfirmed = false,
  revisionPreserved = false,
  handoffState = "idle"
} = {}) {
  const files = safeCount(filesCount);
  const characters = safeCount(transcriptLength);
  const tasks = processing ? safeCount(processing.total) : 0;
  const completed = processing ? safeCount(processing.completed) : 0;
  const finished = processing ? safeCount(processing.finished) : 0;
  const failed = processing ? safeCount(processing.failed) : 0;
  const skipped = processing ? safeCount(processing.skipped) : 0;
  const transcriptionTasks = safeCount(transcriptionTaskCount);
  const hasProcessing = Boolean(processing);
  const processingComplete = hasProcessing && tasks > 0 && completed === tasks;
  const processingAttention = hasProcessing && (failed > 0 || skipped > 0);
  const hasAnalysis = Boolean(analysis);
  const selectedImprovements = safeCount(selectedRecommendationCount);
  const hasRevisionDraft = Boolean(revisionDraft);
  const confirmedRevision = hasRevisionDraft && Boolean(revisionConfirmed);
  const handoffComplete = confirmedRevision && handoffState === "sent";
  const handoffConflict = confirmedRevision && handoffState === "conflict";
  const handoffFailed = confirmedRevision && handoffState === "failed";
  const selectedEntryMode = ["video", "transcript"].includes(entryMode) ? entryMode : "";
  const effectiveEntryMode = selectedEntryMode || (files || hasProcessing ? "video" : "");
  const sourceOptional = selectedEntryMode === "transcript" && files === 0;
  const processingOptional = selectedEntryMode === "transcript" && !hasProcessing;
  const delivery = workbenchDeliveryState({
    files,
    hasProcessing,
    processingComplete,
    processingPrepared,
    processingExported,
    transcriptionTasks,
    transcriptionExported,
    characters,
    transcriptRecoverable,
    hasAnalysis,
    analysisPreserved,
    hasRevisionDraft,
    revisionConfirmed: confirmedRevision,
    revisionPreserved,
    handoffState
  });
  let entryNotice = "入口选择只在当前页面内生效。切换入口不会清空已选视频、任务、转写正文或分析结果。";
  if (selectedEntryMode === "video" && hasAnalysis) {
    entryNotice = "已切换到视频入口，但当前分析结果仍保留；顶部会先完成交接，避免把已完成工作隐藏或误标为未开始。";
  } else if (selectedEntryMode === "video" && characters) {
    entryNotice = "已切换到视频入口，但当前转写正文仍保留；顶部会先完成这份正文的分析，不会静默清空内容。";
  } else if (selectedEntryMode === "transcript" && hasProcessing) {
    entryNotice = `已切换到转写入口；现有 ${tasks} 项视频处理任务仍保留，切回视频入口即可继续。`;
  } else if (selectedEntryMode === "transcript" && files) {
    entryNotice = `已切换到转写入口；已选的 ${files} 个视频仍保留，切回视频入口即可继续。`;
  }

  let current = null;
  if (handoffComplete) current = null;
  else if (hasAnalysis) current = "structure";
  else if (characters) current = "structure";
  else if (effectiveEntryMode === "transcript") current = "transcription";
  else if (hasProcessing && !processingComplete) current = "processing";
  else if (processingComplete) current = "transcription";
  else if (sourceReady && effectiveEntryMode === "video") current = "processing";
  else if (effectiveEntryMode === "video") current = "source";

  const steps = {
    source: {
      status: sourceReady ? "complete" : sourceOptional ? "optional" : current === "source" ? "current" : "pending",
      text: files ? `${files} 个 · ${sourceReady ? "已就绪" : "待补齐"}` : sourceOptional ? "本轮跳过" : "待选择"
    },
    processing: {
      status: processingComplete ? "complete" : processingAttention ? "attention" : processingOptional ? "optional" : current === "processing" ? "current" : "pending",
      text: hasProcessing
        ? processingComplete
          ? `${completed}/${tasks} 已完成`
          : processingAttention
            ? `${completed} 成功 · ${failed + skipped} 异常`
            : finished
              ? `${finished}/${tasks} 已导入`
              : processingPrepared
                ? `${tasks} 项 · 清单已导出`
                : `${tasks} 项待执行`
        : processingOptional ? "本轮跳过" : "待生成"
    },
    transcription: {
      status: characters ? "complete" : current === "transcription" ? "current" : "pending",
      text: characters ? `${characters.toLocaleString("zh-CN")} 字符` : "待导入"
    },
    structure: {
      status: handoffConflict || handoffFailed ? "attention" : handoffComplete ? "complete" : current === "structure" ? "current" : "pending",
      text: handoffComplete
        ? "可拍草稿已发送"
        : handoffConflict
          ? "待处理收件箱冲突"
          : hasRevisionDraft
            ? confirmedRevision ? "草稿已确认 · 待发送" : "草稿待人工确认"
          : selectedImprovements
            ? `已选 ${selectedImprovements} 项 · 待生成草稿`
          : hasAnalysis
            ? `覆盖 ${safeCount(analysis.coveredStructures)}/${safeCount(analysis.totalStructures)}`
            : "待分析"
    }
  };

  let phase = {
    id: "entry",
    label: "选择开始方式",
    tone: "neutral",
    progress: 0,
    guidance: "推荐已有转写直接进入分析；需要从原片开始时再选择本地视频处理。选择只改变引导，不会上传或保存内容。"
  };
  let next = {
    type: "choose-entry",
    target: "",
    control: "",
    focus: "workbench-entry-transcript",
    label: "先选择一个开始方式",
    disabled: true
  };

  if (handoffComplete) {
    phase = {
      id: "complete",
      label: "本轮已交接",
      tone: "success",
      progress: 100,
      guidance: "已确认的下一版可拍任务草稿进入当前浏览器会话；侧边栏只预览草稿，旧版四字段仍只在用户确认时填入空白项。"
    };
    next = primaryAction("open-sidepanel", "structure", "", "打开编导台查看结果", "send-analysis-handoff");
  } else if (handoffConflict) {
    phase = {
      id: "handoff-conflict",
      label: "交接待处理",
      tone: "attention",
      progress: 90,
      guidance: "编导台已有另一份待确认结果，本次没有覆盖；先处理收件箱后再发送。"
    };
    next = primaryAction("open-sidepanel", "structure", "", "打开编导台处理待确认结果", "send-analysis-handoff");
  } else if (hasRevisionDraft && !confirmedRevision) {
    phase = {
      id: "revision-review",
      label: "草稿待确认",
      tone: "active",
      progress: 95,
      guidance: "逐项编辑并核对事实、证据、合规表达与指标；明确勾选确认前不会发送到编导台。"
    };
    next = primaryAction("focus", "structure", "", "下一步：确认可拍任务草稿", "confirm-revision-draft");
  } else if (hasRevisionDraft) {
    phase = {
      id: "handoff",
      label: handoffFailed ? "交接失败" : "等待交接",
      tone: handoffFailed ? "attention" : "active",
      progress: 97,
      guidance: handoffFailed
        ? "已确认草稿仍保留在本页；可重试发送，或导出 JSON 交接包。"
        : "草稿已由你明确确认；发送内容受固定白名单和大小限制，不包含原始全文、文件名或本机路径。"
    };
    next = primaryAction("activate", "structure", "send-analysis-handoff", handoffFailed ? "重试：发送可拍草稿" : "完成：发送可拍草稿");
  } else if (hasAnalysis && selectedImprovements) {
    phase = {
      id: "revision-create",
      label: "等待生成草稿",
      tone: "active",
      progress: 90,
      guidance: "已选择一项改进建议；下一步只围绕这一主要变量生成确定性、可编辑的拍摄草稿。"
    };
    next = primaryAction("activate", "structure", "generate-revision-draft", "下一步：生成单变量可拍草稿");
  } else if (hasAnalysis) {
    phase = {
      id: "revision-select",
      label: "等待选择改进项",
      tone: "active",
      progress: 85,
      guidance: "结构分析已完成；请至少选择一项改进建议。每份草稿只允许一个主要测试变量。"
    };
    next = primaryAction("focus", "structure", "", "下一步：选择一项改进建议", "revision-recommendations");
  } else if (characters) {
    phase = {
      id: "analysis",
      label: "等待分析",
      tone: "active",
      progress: 75,
      guidance: "转写文本已就绪；下一步将在浏览器本地运行确定性结构规则。"
    };
    next = primaryAction("activate", "structure", "analyze-transcript", "下一步：分析文案结构");
  } else if (effectiveEntryMode === "transcript") {
    const preservedProgress = processingComplete
      ? 55
      : hasProcessing
        ? 25 + Math.round((tasks ? Math.min(1, finished / tasks) : 0) * 25)
        : sourceReady
          ? 20
          : files
            ? 10
        : 5;
    phase = {
      id: "transcript-entry",
      label: "已有转写入口",
      tone: "active",
      progress: preservedProgress,
      guidance: "直接导入本地 TXT、MD、SRT 或 VTT；也可以使用下方辅助入口聚焦粘贴区。"
    };
    next = primaryAction("activate", "transcription", "transcript-file", "开始：导入已有转写", "transcript-file-trigger");
  } else if (processingComplete) {
    phase = {
      id: "transcription",
      label: "等待转写",
      tone: "active",
      progress: 55,
      guidance: "本机处理结果已全部完成；导入本地生成的 TXT、MD、SRT 或 VTT。"
    };
    next = primaryAction("activate", "transcription", "transcript-file", "下一步：导入转写文本", "transcript-file-trigger");
  } else if (hasProcessing) {
    const ratio = tasks ? Math.min(1, finished / tasks) : 0;
    phase = {
      id: processingAttention ? "processing-attention" : "processing",
      label: processingAttention ? "处理结果有异常" : processingPrepared ? "等待本机结果" : "等待执行清单",
      tone: processingAttention ? "attention" : "active",
      progress: 25 + Math.round(ratio * 25),
      guidance: processingAttention
        ? "原任务与异常原因仍保留；在本机修正后重新导入结果，不会覆盖原视频。"
        : processingPrepared
          ? "请先在本机运行已导出的受限任务，完成后回到这里导入 results.json。"
          : "先导出受限任务清单，再在本机运行仓库内的开源执行器。"
    };
    next = processingAttention || processingPrepared || finished
      ? primaryAction("activate", "processing", "import-material-result", processingAttention ? "重试：导入处理结果" : "下一步：导入本机结果")
      : primaryAction("activate", "processing", "export-material-manifest", "下一步：导出执行清单");
  } else if (sourceReady) {
    phase = {
      id: "processing-setup",
      label: "素材已就绪",
      tone: "active",
      progress: 20,
      guidance: "授权和路径已补齐；下一步只生成受限任务，不会在浏览器中运行 FFmpeg。"
    };
    next = primaryAction("activate", "processing", "create-material-tasks", "下一步：生成本地处理任务");
  } else if (files) {
    const focusByMissingField = {
      authorization: "material-authorization",
      sourceRoot: "material-source-root",
      outputRoot: "material-output-root",
      ffmpeg: "material-ffmpeg-path",
      sourceNote: "douyin-source-note"
    };
    const missingLabel = {
      authorization: "确认素材授权",
      sourceRoot: "填写原片根目录",
      outputRoot: "填写输出目录",
      ffmpeg: "填写 FFmpeg 路径",
      sourceNote: "检查来源备注"
    }[missingSourceField] || "补齐素材信息";
    phase = {
      id: "source-incomplete",
      label: "素材信息待补齐",
      tone: "attention",
      progress: 10,
      guidance: `已选择 ${files} 个视频；请先${missingLabel}，顶部主操作不会绕过必填校验。`
    };
    next = primaryAction("focus", "source", "", `下一步：${missingLabel}`, focusByMissingField[missingSourceField] || "material-video-files-trigger");
  } else if (effectiveEntryMode === "video") {
    phase = {
      id: "source",
      label: "视频处理入口",
      tone: "active",
      progress: 0,
      guidance: "选择本地自有或已授权视频；未确认授权和补齐路径前不会生成处理任务。"
    };
    next = primaryAction("activate", "source", "material-video-files", "开始：选择本地视频", "material-video-files-trigger");
  }

  return {
    entryMode: selectedEntryMode,
    entryNotice,
    current,
    steps,
    phase,
    next,
    delivery,
    summary: [
      phase.label,
      files ? `${files} 个素材` : "未选择素材",
      hasProcessing ? `${tasks} 项处理任务` : "未生成处理任务",
      characters ? `${characters.toLocaleString("zh-CN")} 字符文本` : "未导入转写文本",
      hasAnalysis ? `结构覆盖 ${safeCount(analysis.structureCoveragePercent)}%` : "未完成结构分析",
      hasRevisionDraft ? `草稿 ${revisionDraft.testId || "待确认"}` : "未生成可拍草稿"
    ].join(" · ")
  };
}
