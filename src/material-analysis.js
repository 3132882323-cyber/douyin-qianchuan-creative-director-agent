import { buildPowerShellCommand, createTranscodeManifest, validateLocalVideoBatch } from "./transcode.js";
import {
  MAX_TIMED_TRANSCRIPT_BYTES,
  MAX_TIMED_TRANSCRIPT_CHARACTERS,
  assertTranscriptDocumentMatchesText,
  parseTranscriptDocument
} from "./timed-transcript.js";

export const MATERIAL_WORKFLOW_KIND = "qianchuan-local-material-analysis-v1";
export const LOCAL_TRANSCRIPTION_KIND = "qianchuan-local-transcription-handoff-v1";
export const MAX_TRANSCRIPT_BYTES = MAX_TIMED_TRANSCRIPT_BYTES;
export const MAX_TRANSCRIPT_CHARACTERS = MAX_TIMED_TRANSCRIPT_CHARACTERS;
export const MATERIAL_VIDEO_BATCH_LIMITS = Object.freeze({
  maxFiles: 40,
  maxSingleFileBytes: 10 * 1024 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024 * 1024
});

const STRUCTURE_RULES = Object.freeze([
  { id: "hook", label: "开场钩子", patterns: [/你是不是|还在|千万别|别再|注意|看这里|为什么|没想到|今天告诉|先别划走|真的有人|居然|竟然|怎么选/u] },
  { id: "audience", label: "目标受众", patterns: [/男士|女士|宝妈|学生|上班族|打工人|新手|老板|家庭|敏感肌|油皮|干皮|大码|小个子|通勤人群|经常.{0,8}的(?:人|朋友)/u] },
  { id: "pain", label: "痛点问题", patterns: [/痛点|麻烦|担心|尴尬|难受|不舒服|闷|勒|粘|掉色|起球|过敏|油腻|费时|容易坏|不好用|不方便|踩雷|浪费/u] },
  { id: "selling_point", label: "核心主张", patterns: [/采用|使用|支持|可以|能够|更.{0,6}|透气|柔软|轻薄|耐用|方便|省时|显瘦|防晒|速干|舒适|稳固|好清洗|不易/u] },
  { id: "evidence", label: "信任证据", patterns: [/(?:\d+(?:\.\d+)?)(?:%|倍|天|小时|分钟|克|斤|厘米|cm|元|件|层)|实测|测试|检测|报告|认证|材质|成分|对比|细节|回购|评价|现场演示/u] },
  { id: "scene", label: "使用场景", patterns: [/上班|通勤|出门|户外|旅行|运动|健身|睡觉|居家|办公室|宿舍|夏天|冬天|雨天|约会|送礼|开车|带娃/u] },
  { id: "cta", label: "行动引导", patterns: [/点击|下单|购买|购物车|链接|领取|抢|马上|现在|到手|拍下|咨询|收藏|关注|试试/u] }
]);

function cleanText(value, label, { required = false, maxLength = 1000 } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function windowsAbsolutePath(value, label, { extension } = {}) {
  const path = cleanText(value, label, { required: true, maxLength: 500 });
  if (/[\u0000-\u001f\u007f<>"|?*]/u.test(path)) throw new Error(`${label}包含 Windows 路径不允许的字符`);
  const drivePath = /^[A-Za-z]:\\[^\\]/u.test(path);
  const uncPath = /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u.test(path);
  if (!drivePath && !uncPath) {
    throw new Error(`${label}必须是 Windows 绝对路径`);
  }
  const pathWithoutRoot = drivePath ? path.slice(3) : path.replace(/^\\\\[^\\/]+\\[^\\/]+\\?/u, "");
  if (pathWithoutRoot.includes(":")) throw new Error(`${label}不能包含备用数据流或额外冒号`);
  const segments = pathWithoutRoot.split("\\").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label}不能包含空白、. 或 .. 路径段`);
  }
  if (segments.some((segment) => /[. ]$/u.test(segment))) throw new Error(`${label}的路径段不能以空格或句点结尾`);
  if (extension && !path.toLowerCase().endsWith(extension)) throw new Error(`${label}必须以 ${extension} 结尾`);
  return path;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function replaceExtension(path, suffix) {
  const separator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dot = path.lastIndexOf(".");
  return `${dot > separator ? path.slice(0, dot) : path}${suffix}`;
}

export function validateDouyinSourceNote(value) {
  const text = cleanText(value, "来源链接", { maxLength: 1000 });
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("来源链接格式无效");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(hostname === "douyin.com" || hostname.endsWith(".douyin.com"))) {
    throw new Error("来源备注只接受 https://douyin.com 域名链接");
  }
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.href,
    hostname,
    usage: "source_note_and_open_original_only",
    fetched: false,
    parsedMedia: false
  };
}

export function createMaterialProcessingManifest(files, rawSettings = {}, options = {}) {
  validateLocalVideoBatch(files, MATERIAL_VIDEO_BATCH_LIMITS);
  const base = createTranscodeManifest(files, {
    ...rawSettings,
    authorizationConfirmed: rawSettings.authorizationConfirmed === true,
    preset: rawSettings.preset || "balanced",
    resolution: rawSettings.resolution || "1080p",
    frameRate: rawSettings.frameRate || "keep",
    sampleRate: rawSettings.sampleRate || "48000",
    outputSuffix: rawSettings.outputSuffix || "_analysis"
  }, { ...options, fileLimits: MATERIAL_VIDEO_BATCH_LIMITS });
  const sourceNote = validateDouyinSourceNote(rawSettings.sourceNote);
  const tasks = [];
  for (const baseTask of base.tasks) {
    const videoTask = {
      ...baseTask,
      id: `${baseTask.id}-V`,
      operation: "standardize_video"
    };
    videoTask.powerShellCommand = buildPowerShellCommand(videoTask, base.processing.ffmpegExecutable);
    const audioPath = replaceExtension(baseTask.outputPath, "_audio.wav");
    const audioTask = {
      id: `${baseTask.id}-A`,
      operation: "extract_audio",
      source: { ...baseTask.source },
      sourcePath: baseTask.sourcePath,
      outputPath: audioPath,
      ffmpegArguments: [
        "-hide_banner", "-n", "-i", baseTask.sourcePath,
        "-map", "0:a:0", "-map_metadata", "0", "-map_chapters", "0",
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        audioPath
      ],
      status: "pending",
      progress: 0,
      failureReason: ""
    };
    audioTask.powerShellCommand = buildPowerShellCommand(audioTask, base.processing.ffmpegExecutable);
    tasks.push(videoTask, audioTask);
  }
  return {
    ...base,
    workflowKind: MATERIAL_WORKFLOW_KIND,
    sourceNote,
    processing: {
      ...base.processing,
      workflow: "standardize_video_and_extract_pcm_audio",
      audio: { codec: "pcm_s16le", channels: 1, sampleRate: 16000 }
    },
    tasks,
    notice: "仅对本地自有或已授权视频生成 FFmpeg 标准化与音频提取任务；来源链接只作备注/打开原页，不下载、不解析媒体。"
  };
}

export function createLocalTranscriptionPlan(processingManifest, rawConfig = {}, options = {}) {
  if (processingManifest?.schemaVersion !== 1 || processingManifest?.workflowKind !== MATERIAL_WORKFLOW_KIND) {
    throw new Error("请先生成受支持的素材分析处理任务");
  }
  if (processingManifest.authorization?.confirmed !== true) throw new Error("处理任务缺少自有或授权素材确认");
  if (processingManifest.processing?.remoteUpload !== false) throw new Error("不接受包含远程上传的处理任务");
  const mode = rawConfig.mode === "whisper_cpp" ? "whisper_cpp" : "text_import";
  const createdAt = options.createdAt || new Date().toISOString();
  const plan = {
    schemaVersion: 1,
    kind: LOCAL_TRANSCRIPTION_KIND,
    processingManifestId: processingManifest.manifestId,
    createdAt,
    mode,
    remoteUpload: false,
    tasks: [],
    notice: mode === "text_import"
      ? "未配置执行引擎；请导入在本机生成的 TXT、MD、SRT 或 VTT 文本。"
      : "命令只调用用户明确配置的本机 whisper.cpp；不会连接云端转写服务。"
  };
  if (mode === "text_import") return plan;

  const executable = windowsAbsolutePath(rawConfig.executable, "whisper.cpp 可执行文件");
  const leaf = executable.split("\\").pop().toLowerCase();
  if (leaf !== "whisper-cli.exe" && leaf !== "whisper-cli") throw new Error("本地引擎仅允许明确配置 whisper-cli 或 whisper-cli.exe");
  const modelPath = windowsAbsolutePath(rawConfig.modelPath, "whisper.cpp 模型文件", { extension: ".bin" });
  const language = rawConfig.language === "auto" ? "auto" : "zh";
  const audioTasks = processingManifest.tasks.filter((task) => task.operation === "extract_audio");
  if (!audioTasks.length) throw new Error("处理任务中没有可转写的本地音频输出");
  plan.engine = { name: "whisper.cpp", executable, modelPath, language };
  plan.tasks = audioTasks.map((task, index) => {
    const audioPath = windowsAbsolutePath(task.outputPath, "本地音频路径", { extension: ".wav" });
    const outputStem = replaceExtension(audioPath, "_transcript");
    const args = ["-m", modelPath, "-f", audioPath, "-otxt", "-of", outputStem, "-l", language];
    return {
      id: `${processingManifest.manifestId}-T${String(index + 1).padStart(3, "0")}`,
      audioPath,
      outputPath: `${outputStem}.txt`,
      executable,
      arguments: args,
      command: `& ${powerShellQuote(executable)} ${args.map(powerShellQuote).join(" ")}`,
      status: "pending"
    };
  });
  return plan;
}

export function transcriptTextFromDocument(rawText) {
  const raw = String(rawText ?? "");
  const trimmed = raw.replace(/^\uFEFF/u, "").trimStart();
  const name = /^WEBVTT(?:\s|$)/iu.test(trimmed)
    ? "legacy.vtt"
    : /^\s*(?:\d+\s*\n)?\d{1,2}:\d{2}:\d{2},\d{3}\s+-->/u.test(trimmed)
      ? "legacy.srt"
      : "legacy.txt";
  return parseTranscriptDocument(raw, { name }).text;
}

function splitTranscriptContent(text) {
  return text
    .split(/\n+|(?<=[。！？!?；;])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitTranscript(text, transcriptDocument = null) {
  let fragments;
  if (transcriptDocument) {
    const document = assertTranscriptDocumentMatchesText(transcriptDocument, text);
    fragments = document.cues.flatMap((cue) => splitTranscriptContent(cue.content).map((content) => ({
      content,
      source: {
        kind: cue.startMs === null ? "paragraph" : "cue",
        cueIndex: cue.index,
        label: cue.label,
        startMs: cue.startMs,
        endMs: cue.endMs,
        start: cue.start,
        end: cue.end
      }
    })));
  } else {
    fragments = splitTranscriptContent(text).map((content, index) => ({
      content,
      source: {
        kind: "paragraph",
        cueIndex: index + 1,
        label: "",
        startMs: null,
        endMs: null,
        start: "",
        end: ""
      }
    }));
  }
  if (fragments.length <= 600) return fragments;
  const overflow = fragments.slice(599);
  return [
    ...fragments.slice(0, 599),
    {
      content: overflow.map((item) => item.content).join(" "),
      source: { kind: "combined", cueIndex: 600, label: "合并余下段落", startMs: null, endMs: null, start: "", end: "" }
    }
  ];
}

function tagsForSegment(text, index) {
  const tags = STRUCTURE_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(text))).map((rule) => rule.id);
  if (index === 0 && !tags.includes("hook")) tags.unshift("hook");
  return [...new Set(tags)];
}

export function analyzeTranscriptStructure(rawText, options = {}) {
  const text = transcriptTextFromDocument(rawText);
  const fragments = splitTranscript(text, options.transcriptDocument || null);
  const segments = fragments.map(({ content, source }, index) => ({
    index: index + 1,
    content,
    tags: tagsForSegment(content, index),
    source
  }));
  const coverage = Object.fromEntries(STRUCTURE_RULES.map((rule) => {
    const matched = segments.filter((segment) => segment.tags.includes(rule.id));
    return [rule.id, { label: rule.label, present: matched.length > 0, count: matched.length, segmentIndexes: matched.map((segment) => segment.index) }];
  }));
  const presentCount = Object.values(coverage).filter((item) => item.present).length;
  const missingAdvice = {
    hook: "补一句明确的反常识、问题或结果承诺，并确保事实可兑现。",
    audience: "明确谁在什么情况下需要看到这段内容。",
    pain: "补充目标受众可感知的具体问题，不夸大焦虑。",
    selling_point: "把功能改写成可拍、可验证的用户利益。",
    evidence: "补充实测、材质细节、合规报告或真实演示。",
    scene: "加入一个真实使用场景，帮助观众代入。",
    cta: "补充清楚但不过度催促的下一步行动。"
  };
  return {
    schemaVersion: 1,
    kind: "qianchuan-rule-based-copy-structure-v1",
    generatedAt: options.generatedAt || new Date().toISOString(),
    sourceName: cleanText(options.sourceName || "本地转写文本", "来源名称", { maxLength: 260 }),
    method: "local_deterministic_rules",
    summary: {
      characters: text.length,
      segments: segments.length,
      coveredStructures: presentCount,
      totalStructures: STRUCTURE_RULES.length,
      structureCoveragePercent: Math.round((presentCount / STRUCTURE_RULES.length) * 100)
    },
    coverage,
    segments,
    recommendations: Object.entries(coverage).filter(([, item]) => !item.present).map(([id, item]) => ({ id, label: item.label, advice: missingAdvice[id] })),
    disclaimer: "这是本地关键词规则形成的结构提示，不是投放效果预测；关键事实、证据与合规表达仍需编导人工复核。"
  };
}

export function materialAnalysisToMarkdown(result) {
  const lines = [
    "# 素材文案结构分析",
    "",
    `- 来源：${result.sourceName}`,
    `- 方法：本地确定性规则`,
    `- 结构覆盖：${result.summary.coveredStructures}/${result.summary.totalStructures}（${result.summary.structureCoveragePercent}%）`,
    "",
    "## 结构覆盖",
    ""
  ];
  for (const item of Object.values(result.coverage)) lines.push(`- ${item.present ? "[x]" : "[ ]"} ${item.label}${item.present ? `（${item.count} 段）` : ""}`);
  lines.push("", "## 分段标注", "");
  for (const segment of result.segments) {
    const source = segment.source?.start
      ? `${segment.source.start} → ${segment.source.end}${segment.source.label ? ` · ${segment.source.label}` : ""}`
      : `段落 ${segment.source?.cueIndex || segment.index}`;
    lines.push(`${segment.index}. 【${source}】${segment.content}${segment.tags.length ? `  \n   标签：${segment.tags.map((id) => result.coverage[id].label).join("、")}` : ""}`);
  }
  if (result.recommendations.length) {
    lines.push("", "## 待补结构", "");
    for (const item of result.recommendations) lines.push(`- **${item.label}**：${item.advice}`);
  }
  lines.push("", `> ${result.disclaimer}`, "");
  return lines.join("\n");
}
