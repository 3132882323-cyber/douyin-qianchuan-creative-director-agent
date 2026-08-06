function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function buildWorkbenchOverview({
  filesCount = 0,
  sourceReady = false,
  missingSourceField = "files",
  processing = null,
  transcriptLength = 0,
  analysis = null
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

  let current = "source";
  if (hasAnalysis) current = null;
  else if (characters) current = "structure";
  else if (hasProcessing && !processingComplete) current = "processing";
  else if (processingComplete) current = "transcription";
  else if (sourceReady) current = "processing";

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
              : `${tasks} 项待执行`
        : "待生成"
    },
    transcription: {
      status: characters ? "complete" : current === "transcription" ? "current" : "pending",
      text: characters ? `${characters.toLocaleString("zh-CN")} 字符` : "待导入"
    },
    structure: {
      status: hasAnalysis ? "complete" : current === "structure" ? "current" : "pending",
      text: hasAnalysis ? `覆盖 ${safeCount(analysis.coveredStructures)}/${safeCount(analysis.totalStructures)}` : "待分析"
    }
  };

  let next = { target: "source", focus: "material-video-files-trigger", label: "下一步：选择本地素材" };
  if (hasAnalysis) {
    next = { target: "structure", focus: "export-structure-json", label: "查看分析结果" };
  } else if (characters) {
    next = { target: "structure", focus: "analyze-transcript", label: "下一步：前往结构分析" };
  } else if (hasProcessing && !processingComplete) {
    next = {
      target: "processing",
      focus: finished ? "import-material-result" : "export-material-manifest",
      label: processingAttention ? "下一步：检查处理结果" : "下一步：继续本机处理"
    };
  } else if (processingComplete) {
    next = { target: "transcription", focus: "transcript-file-trigger", label: "下一步：导入转写文本" };
  } else if (sourceReady) {
    next = { target: "processing", focus: "create-material-tasks", label: "下一步：前往生成任务" };
  } else if (files) {
    const focusByMissingField = {
      authorization: "material-authorization",
      sourceRoot: "material-source-root",
      outputRoot: "material-output-root",
      ffmpeg: "material-ffmpeg-path",
      sourceNote: "douyin-source-note"
    };
    next = {
      target: "source",
      focus: focusByMissingField[missingSourceField] || "material-video-files-trigger",
      label: "下一步：补齐素材信息"
    };
  }

  return {
    current,
    steps,
    next,
    summary: [
      files ? `${files} 个素材` : "未选择素材",
      hasProcessing ? `${tasks} 项处理任务` : "未生成处理任务",
      characters ? `${characters.toLocaleString("zh-CN")} 字符文本` : "未导入转写文本",
      hasAnalysis ? `结构覆盖 ${safeCount(analysis.structureCoveragePercent)}%` : "未完成结构分析"
    ].join(" · ")
  };
}
