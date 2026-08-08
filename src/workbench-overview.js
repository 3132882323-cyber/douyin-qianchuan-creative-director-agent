function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function primaryAction(type, target, control, label, focus = control) {
  return { type, target, control, focus, label };
}

export function buildWorkbenchResetPrompt({
  entryMode = "",
  filesCount = 0,
  processingTaskCount = 0,
  processingExported = false,
  transcriptionTaskCount = 0,
  transcriptionExported = false,
  transcriptLength = 0,
  hasAnalysis = false,
  analysisPreserved = false,
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
  const hasWork = Boolean(
    entryMode || files || processingTasks || transcriptionTasks || characters || analysis || hasHandoffState || hasSetupValues || hasFeedback
  );
  const atRisk = [];
  if (processingTasks && !processingExported) atRisk.push("尚未导出的处理任务");
  if (transcriptionTasks && !transcriptionExported) atRisk.push("尚未导出的转写任务");
  if (analysis && !analysisPreserved && handoffState !== "sent") atRisk.push("尚未导出或成功发送的分析结果");
  const currentItems = [];
  if (files) currentItems.push(`${files} 个视频选择`);
  if (processingTasks) currentItems.push(`${processingTasks} 项处理任务`);
  if (transcriptionTasks) currentItems.push(`${transcriptionTasks} 项转写任务`);
  if (characters) currentItems.push(`${characters.toLocaleString("zh-CN")} 字符正文`);
  if (analysis) currentItems.push("结构分析与本页交接状态");
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

export function buildWorkbenchOverview({
  entryMode = "",
  filesCount = 0,
  sourceReady = false,
  missingSourceField = "files",
  processing = null,
  processingPrepared = false,
  transcriptLength = 0,
  analysis = null,
  handoffState = "idle"
} = {}) {
  const files = safeCount(filesCount);
  const characters = safeCount(transcriptLength);
  const tasks = processing ? safeCount(processing.total) : 0;
  const completed = processing ? safeCount(processing.completed) : 0;
  const finished = processing ? safeCount(processing.finished) : 0;
  const failed = processing ? safeCount(processing.failed) : 0;
  const skipped = processing ? safeCount(processing.skipped) : 0;
  const hasProcessing = Boolean(processing);
  const processingComplete = hasProcessing && tasks > 0 && completed === tasks;
  const processingAttention = hasProcessing && (failed > 0 || skipped > 0);
  const hasAnalysis = Boolean(analysis);
  const handoffComplete = hasAnalysis && handoffState === "sent";
  const handoffConflict = hasAnalysis && handoffState === "conflict";
  const handoffFailed = hasAnalysis && handoffState === "failed";
  const selectedEntryMode = ["video", "transcript"].includes(entryMode) ? entryMode : "";
  const effectiveEntryMode = selectedEntryMode || (files || hasProcessing ? "video" : "");
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
      status: sourceReady ? "complete" : current === "source" ? "current" : "pending",
      text: files ? `${files} 个 · ${sourceReady ? "已就绪" : "待补齐"}` : "待选择"
    },
    processing: {
      status: processingComplete ? "complete" : processingAttention ? "attention" : current === "processing" ? "current" : "pending",
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
        : "待生成"
    },
    transcription: {
      status: characters ? "complete" : current === "transcription" ? "current" : "pending",
      text: characters ? `${characters.toLocaleString("zh-CN")} 字符` : "待导入"
    },
    structure: {
      status: handoffConflict || handoffFailed ? "attention" : hasAnalysis ? "complete" : current === "structure" ? "current" : "pending",
      text: handoffComplete
        ? "已发送编导台"
        : handoffConflict
          ? "待处理收件箱冲突"
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
    guidance: "先选择“处理本地视频”或“分析已有转写”；选择只改变引导，不会上传或保存内容。"
  };
  let next = {
    type: "choose-entry",
    target: "",
    control: "",
    focus: "workbench-entry-video",
    label: "先选择一个开始方式",
    disabled: true
  };

  if (handoffComplete) {
    phase = {
      id: "complete",
      label: "本轮已交接",
      tone: "success",
      progress: 100,
      guidance: "受限分析摘要已进入当前浏览器会话；请在侧边栏预览并确认需要填入的空白字段。"
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
  } else if (hasAnalysis) {
    phase = {
      id: "handoff",
      label: handoffFailed ? "交接失败" : "等待交接",
      tone: handoffFailed ? "attention" : "active",
      progress: 90,
      guidance: handoffFailed
        ? "分析结果仍保留在本页；可重试发送，或导出 JSON 交接包。"
        : "结构分析已完成；发送前只会打包受限摘要，不包含原始全文、文件名或本机路径。"
    };
    next = primaryAction("activate", "structure", "send-analysis-handoff", handoffFailed ? "重试：发送到编导台" : "完成：发送到编导台");
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
            : 0;
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
    summary: [
      phase.label,
      files ? `${files} 个素材` : "未选择素材",
      hasProcessing ? `${tasks} 项处理任务` : "未生成处理任务",
      characters ? `${characters.toLocaleString("zh-CN")} 字符文本` : "未导入转写文本",
      hasAnalysis ? `结构覆盖 ${safeCount(analysis.structureCoveragePercent)}%` : "未完成结构分析"
    ].join(" · ")
  };
}
