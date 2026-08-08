import { createRevisionIdentity, normalizeRevisionIdentifier } from "./revision-id.js";

export const CREATIVE_REVISION_KIND = "qianchuan-creative-revision-draft-v1";
export const CREATIVE_REVISION_SCHEMA_VERSION = 1;
export const MAX_CREATIVE_REVISION_BYTES = 48 * 1024;
export const CREATIVE_REVISION_METHOD = "local_deterministic_template";
export const CREATIVE_REVISION_NOTICE = "这是根据本地确定性规则与用户选择生成的可编辑拍摄草稿，不是投放效果预测；事实、证据、合规表达和指标阈值必须由编导人工核对。";

export const CREATIVE_REVISION_VARIABLES = Object.freeze([
  { id: "hook", label: "前三秒钩子", metrics: "3 秒留存率、点击率与完播率" },
  { id: "audience", label: "目标受众表达", metrics: "目标人群点击率、完播率与有效互动" },
  { id: "pain", label: "问题表达", metrics: "前 5 秒留存、点击率与评论反馈" },
  { id: "selling_point", label: "核心主张", metrics: "点击率、转化率与支付 ROI" },
  { id: "evidence", label: "信任证据", metrics: "转化率、支付 ROI 与负向反馈" },
  { id: "scene", label: "使用场景", metrics: "完播率、点击率与场景相关互动" },
  { id: "cta", label: "行动引导", metrics: "组件点击率、转化率与负向反馈" }
]);

export const CREATIVE_REVISION_EDITABLE_FIELDS = Object.freeze([
  "problemSummary",
  "testHypothesis",
  "fixedElements",
  "hook",
  "spokenScript",
  "storyboard",
  "supplementalShots",
  "subtitleHighlights",
  "editingRhythm",
  "successMetrics",
  "stopCondition"
]);

const ANALYSIS_KIND = "qianchuan-rule-based-copy-structure-v1";
const ANALYSIS_METHOD = "local_deterministic_rules";
const STRUCTURE_IDS = new Set(CREATIVE_REVISION_VARIABLES.map((item) => item.id));
const MACHINE_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|file:\/\/|\/(?:Users|home|var\/folders)\/)/iu;
const ACTIVE_CONTENT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|img)\b|javascript\s*:|\bon[a-z]+\s*=)/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label}格式无效`);
  return value;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}包含不受支持字段：${unknown.join("、")}`);
}

function safeText(value, label, { maxLength, allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const text = value.replace(/\r\n?/gu, "\n").trim();
  if (!text && !allowEmpty) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}超过 ${maxLength} 字符上限`);
  if (CONTROL_PATTERN.test(text)) throw new Error(`${label}包含不允许的控制字符`);
  if (MACHINE_PATH_PATTERN.test(text)) throw new Error(`${label}不能包含本机路径`);
  if (ACTIVE_CONTENT_PATTERN.test(text)) throw new Error(`${label}包含不安全的活动内容`);
  return text;
}

function exactIso(value) {
  if (typeof value !== "string" || value.length > 40) throw new Error("草稿时间格式无效");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error("草稿时间格式无效");
  return value;
}

function serializedBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new Error("任务草稿无法序列化");
  }
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}数值无效`);
  return value;
}

function analysisSource(analysis) {
  const source = assertPlainObject(analysis, "结构分析结果");
  if (source.schemaVersion !== 1 || source.kind !== ANALYSIS_KIND || source.method !== ANALYSIS_METHOD) {
    throw new Error("请先生成受支持的本地确定性结构分析");
  }
  if (!Array.isArray(source.segments) || !source.segments.length || source.segments.length > 600) throw new Error("结构分析分段格式无效");
  return source;
}

function variableDefinition(id) {
  return CREATIVE_REVISION_VARIABLES.find((item) => item.id === id) || null;
}

function segmentSourceLabel(segment) {
  if (segment?.source?.start) return `${segment.source.start} → ${segment.source.end}${segment.source.label ? ` · ${segment.source.label}` : ""}`;
  return `段落 ${segment?.source?.cueIndex || segment?.index || 1}`;
}

export function revisionRecommendationsForAnalysis(analysis) {
  const source = analysisSource(analysis);
  const missingAdvice = new Map((Array.isArray(source.recommendations) ? source.recommendations : []).map((item) => [item.id, item.advice]));
  const presentAdvice = {
    hook: "保留事实与核心主张不变，只重写前三秒开场并建立清晰对照。",
    audience: "保持产品信息不变，只把受众身份与具体场景说得更明确。",
    pain: "保持解决方案不变，只把问题改成更具体、可感知且不过度焦虑的表达。",
    selling_point: "保持证据与镜头不变，只测试一条更清楚、可拍且可核验的核心主张。",
    evidence: "保持主张不变，只增加一组可核验的实拍、对比或细节证据。",
    scene: "保持口播逻辑不变，只替换为一个更具体的真实使用场景。",
    cta: "保持前文不变，只测试一个清楚、不过度催促的行动引导。"
  };
  return CREATIVE_REVISION_VARIABLES.map((definition) => {
    const coverage = source.coverage?.[definition.id] || {};
    const indexes = Array.isArray(coverage.segmentIndexes)
      ? coverage.segmentIndexes.filter((value) => Number.isInteger(value) && value > 0 && value <= source.segments.length).slice(0, 8)
      : [];
    return {
      id: `rev-${definition.id}`,
      variableId: definition.id,
      label: definition.label,
      advice: safeText(missingAdvice.get(definition.id) || presentAdvice[definition.id], `${definition.label}建议`, { maxLength: 400 }),
      evidenceSegmentIndexes: indexes
    };
  });
}

function firstSegmentForTag(analysis, tagId) {
  return analysis.segments.find((segment) => Array.isArray(segment.tags) && segment.tags.includes(tagId)) || null;
}

function fixedElementLabels(variableId) {
  return CREATIVE_REVISION_VARIABLES.filter((item) => item.id !== variableId).map((item) => item.label).join("、");
}

function sourceSnippet(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizedEvidence(analysis, selectedRecommendations, variableId) {
  const indexes = new Set(selectedRecommendations.flatMap((item) => item.evidenceSegmentIndexes));
  if (!indexes.size) {
    const tagged = firstSegmentForTag(analysis, variableId) || analysis.segments[0];
    if (tagged?.index) indexes.add(tagged.index);
  }
  return [...indexes].slice(0, 4).map((index) => {
    const segment = analysis.segments[index - 1];
    if (!segment) throw new Error("改进建议引用了不存在的分析片段");
    return {
      segmentIndex: safeInteger(segment.index, "证据片段编号", { min: 1, max: 600 }),
      sourceLabel: safeText(segmentSourceLabel(segment), "证据来源", { maxLength: 180 }),
      startMs: segment.source?.startMs === null || segment.source?.startMs === undefined
        ? null
        : safeInteger(segment.source.startMs, "证据开始时间", { max: 24 * 60 * 60 * 1000 }),
      endMs: segment.source?.endMs === null || segment.source?.endMs === undefined
        ? null
        : safeInteger(segment.source.endMs, "证据结束时间", { max: 24 * 60 * 60 * 1000 }),
      excerpt: safeText(segment.content, "证据摘录", { maxLength: 240 }),
      tags: Array.isArray(segment.tags) ? [...new Set(segment.tags.filter((tag) => STRUCTURE_IDS.has(tag)))].slice(0, 7) : []
    };
  });
}

export function createCreativeRevisionDraft(analysis, options = {}) {
  const source = analysisSource(analysis);
  const recommendations = revisionRecommendationsForAnalysis(source);
  const selectedIds = Array.isArray(options.selectedRecommendationIds) ? [...new Set(options.selectedRecommendationIds)] : [];
  if (!selectedIds.length) throw new Error("请至少选择一项改进建议后再生成草稿");
  if (selectedIds.length > recommendations.length) throw new Error("改进建议选择数量无效");
  const selected = selectedIds.map((id) => recommendations.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("改进建议包含未知选项");
  const testVariables = Array.isArray(options.testVariables) ? [...new Set(options.testVariables)] : [];
  if (testVariables.length !== 1) throw new Error("同一草稿只能包含一个主要测试变量；请拆分为多轮测试");
  const variable = variableDefinition(testVariables[0]);
  if (!variable) throw new Error("主要测试变量不受支持");
  if (selected.some((item) => item.variableId !== variable.id)) {
    throw new Error("所选改进建议涉及多个测试变量；请只保留同一变量或拆分草稿");
  }
  const identity = createRevisionIdentity(source, options);
  const evidence = normalizedEvidence(source, selected, variable.id);
  const pain = sourceSnippet(firstSegmentForTag(source, "pain")?.content || selected.map((item) => item.advice).join("；"), 500);
  const existingHook = sourceSnippet(firstSegmentForTag(source, "hook")?.content || "用一个具体问题或可核验结果开场", 500);
  const claim = sourceSnippet(firstSegmentForTag(source, "selling_point")?.content || "保持当前核心主张，先补齐可拍证据", 600);
  const scene = sourceSnippet(firstSegmentForTag(source, "scene")?.content || "团队已授权的真实使用场景", 600);
  const proof = sourceSnippet(firstSegmentForTag(source, "evidence")?.content || "材质细节、过程实拍或合规证明", 600);
  const draft = {
    schemaVersion: CREATIVE_REVISION_SCHEMA_VERSION,
    kind: CREATIVE_REVISION_KIND,
    testId: identity.revisionId,
    parentVersionId: identity.parentVersionId,
    sourceAnalysisId: identity.sourceAnalysisId,
    createdAt: identity.createdAt,
    method: CREATIVE_REVISION_METHOD,
    primaryVariable: { id: variable.id, label: variable.label },
    selectedRecommendationIds: selectedIds,
    evidence,
    problemSummary: `当前文案需要围绕“${pain.slice(0, 280)}”建立更清晰的可拍验证路径。`,
    testHypothesis: `本轮仅改变${variable.label}，其余内容保持不变；对照观察${variable.metrics}，结果待真实投放数据验证。`,
    fixedElements: `保持不变：${fixedElementLabels(variable.id)}、素材授权边界和事实证据口径。`,
    hook: variable.id === "hook" ? `前三秒测试稿：${existingHook}` : `沿用当前开场：${existingHook}`,
    spokenScript: [
      `开场：${existingHook}`,
      `问题：${pain}`,
      `主张：${claim}`,
      `证据：${proof}`,
      `场景：${scene}`,
      "行动：给出清楚但不过度催促的下一步，并由编导复核合规。"
    ].join("\n"),
    storyboard: [
      "0–3 秒：呈现本轮唯一变量，画面与字幕同步。",
      "3–8 秒：展示具体问题与真实场景。",
      "8–18 秒：用细节、过程或对照镜头说明核心主张。",
      "18 秒后：补充限制条件与清楚的行动引导。"
    ].join("\n"),
    supplementalShots: "补拍：问题发生镜头、使用过程、关键细节特写、同条件对照、证据来源和结尾行动镜头。",
    subtitleHighlights: `${variable.label}｜具体问题｜核心主张｜可核验证据｜行动引导`,
    editingRhythm: "前三秒快速建立变量；随后按问题—主张—证据—场景—行动推进。避免用无证据快切代替事实说明。",
    successMetrics: `与父版本或基线进行单变量对照，观察${variable.metrics}；不由本地规则自动判定胜负。`,
    stopCondition: "达到团队预先设定的最低样本或消耗后再判断；若核心指标持续低于基线且无改善趋势，停止该变量并保留原版。",
    notice: CREATIVE_REVISION_NOTICE
  };
  return validateCreativeRevisionDraft(draft);
}

function normalizeEvidence(rawEvidence) {
  if (!Array.isArray(rawEvidence) || rawEvidence.length < 1 || rawEvidence.length > 4) throw new Error("草稿证据必须包含 1–4 项分析引用");
  return rawEvidence.map((rawItem) => {
    const item = assertPlainObject(rawItem, "草稿证据");
    assertKnownKeys(item, ["segmentIndex", "sourceLabel", "startMs", "endMs", "excerpt", "tags"], "草稿证据");
    const startMs = item.startMs === null ? null : safeInteger(item.startMs, "证据开始时间", { max: 24 * 60 * 60 * 1000 });
    const endMs = item.endMs === null ? null : safeInteger(item.endMs, "证据结束时间", { max: 24 * 60 * 60 * 1000 });
    if ((startMs === null) !== (endMs === null) || (startMs !== null && endMs <= startMs)) throw new Error("草稿证据时间范围无效");
    if (!Array.isArray(item.tags) || item.tags.length > 7 || item.tags.some((tag) => !STRUCTURE_IDS.has(tag))) throw new Error("草稿证据标签无效");
    return {
      segmentIndex: safeInteger(item.segmentIndex, "证据片段编号", { min: 1, max: 600 }),
      sourceLabel: safeText(item.sourceLabel, "证据来源", { maxLength: 180 }),
      startMs,
      endMs,
      excerpt: safeText(item.excerpt, "证据摘录", { maxLength: 240 }),
      tags: [...new Set(item.tags)]
    };
  });
}

export function validateCreativeRevisionDraft(raw) {
  if (serializedBytes(raw) > MAX_CREATIVE_REVISION_BYTES) throw new Error("可拍任务草稿超过 48 KB 上限");
  const document = assertPlainObject(raw, "可拍任务草稿");
  const keys = [
    "schemaVersion", "kind", "testId", "parentVersionId", "sourceAnalysisId", "createdAt", "method",
    "primaryVariable", "selectedRecommendationIds", "evidence", ...CREATIVE_REVISION_EDITABLE_FIELDS, "notice"
  ];
  assertKnownKeys(document, keys, "可拍任务草稿");
  if (document.schemaVersion !== CREATIVE_REVISION_SCHEMA_VERSION || document.kind !== CREATIVE_REVISION_KIND) throw new Error("可拍任务草稿版本不受支持");
  if (document.method !== CREATIVE_REVISION_METHOD || document.notice !== CREATIVE_REVISION_NOTICE) throw new Error("可拍任务草稿边界声明不完整");
  const primary = assertPlainObject(document.primaryVariable, "主要测试变量");
  assertKnownKeys(primary, ["id", "label"], "主要测试变量");
  const definition = variableDefinition(primary.id);
  if (!definition || primary.label !== definition.label) throw new Error("主要测试变量无效");
  if (!Array.isArray(document.selectedRecommendationIds) || !document.selectedRecommendationIds.length || document.selectedRecommendationIds.length > CREATIVE_REVISION_VARIABLES.length) {
    throw new Error("草稿必须包含至少一项改进建议引用");
  }
  const recommendationIds = [...new Set(document.selectedRecommendationIds.map((id) => safeText(id, "改进建议编号", { maxLength: 40 })))];
  if (recommendationIds.length !== document.selectedRecommendationIds.length || recommendationIds.some((id) => id !== `rev-${definition.id}`)) {
    throw new Error("草稿改进建议必须对应唯一测试变量");
  }
  const normalized = {
    schemaVersion: CREATIVE_REVISION_SCHEMA_VERSION,
    kind: CREATIVE_REVISION_KIND,
    testId: normalizeRevisionIdentifier(document.testId, "测试编号", { allowEmpty: false }),
    parentVersionId: normalizeRevisionIdentifier(document.parentVersionId, "父版本编号"),
    sourceAnalysisId: safeText(document.sourceAnalysisId, "来源分析编号", { maxLength: 40 }),
    createdAt: exactIso(document.createdAt),
    method: CREATIVE_REVISION_METHOD,
    primaryVariable: { id: definition.id, label: definition.label },
    selectedRecommendationIds: recommendationIds,
    evidence: normalizeEvidence(document.evidence),
    problemSummary: safeText(document.problemSummary, "问题摘要", { maxLength: 800 }),
    testHypothesis: safeText(document.testHypothesis, "测试假设", { maxLength: 1000 }),
    fixedElements: safeText(document.fixedElements, "保持不变项", { maxLength: 1000 }),
    hook: safeText(document.hook, "前三秒钩子", { maxLength: 600 }),
    spokenScript: safeText(document.spokenScript, "口播稿", { maxLength: 5000 }),
    storyboard: safeText(document.storyboard, "分镜", { maxLength: 4000 }),
    supplementalShots: safeText(document.supplementalShots, "补拍镜头", { maxLength: 2000 }),
    subtitleHighlights: safeText(document.subtitleHighlights, "字幕重点", { maxLength: 1200 }),
    editingRhythm: safeText(document.editingRhythm, "剪辑节奏", { maxLength: 1600 }),
    successMetrics: safeText(document.successMetrics, "成功指标", { maxLength: 1600 }),
    stopCondition: safeText(document.stopCondition, "停止条件", { maxLength: 1600 }),
    notice: CREATIVE_REVISION_NOTICE
  };
  if (!/^AN-[0-9a-f]{8}$/u.test(normalized.sourceAnalysisId)) throw new Error("来源分析编号无效");
  if (serializedBytes(normalized) > MAX_CREATIVE_REVISION_BYTES) throw new Error("可拍任务草稿超过 48 KB 上限");
  return normalized;
}

export function creativeRevisionWithEdits(draft, edits = {}) {
  const current = validateCreativeRevisionDraft(draft);
  const update = assertPlainObject(edits, "草稿编辑");
  assertKnownKeys(update, CREATIVE_REVISION_EDITABLE_FIELDS, "草稿编辑");
  return validateCreativeRevisionDraft({ ...current, ...update });
}

export function creativeRevisionToMarkdown(raw) {
  const draft = validateCreativeRevisionDraft(raw);
  const evidence = draft.evidence.map((item) => `- ${item.sourceLabel}：${item.excerpt}`).join("\n");
  return [
    `# 下一版可拍任务草稿 · ${draft.testId}`,
    "",
    `- 父版本：${draft.parentVersionId || "无（首版）"}`,
    `- 来源分析：${draft.sourceAnalysisId}`,
    `- 唯一测试变量：${draft.primaryVariable.label}`,
    "",
    "## 分析证据",
    "",
    evidence,
    "",
    "## 问题摘要",
    "",
    draft.problemSummary,
    "",
    "## 测试假设",
    "",
    draft.testHypothesis,
    "",
    "## 保持不变",
    "",
    draft.fixedElements,
    "",
    "## 前三秒钩子",
    "",
    draft.hook,
    "",
    "## 口播稿",
    "",
    draft.spokenScript,
    "",
    "## 分镜",
    "",
    draft.storyboard,
    "",
    "## 补拍镜头",
    "",
    draft.supplementalShots,
    "",
    "## 字幕重点",
    "",
    draft.subtitleHighlights,
    "",
    "## 剪辑节奏",
    "",
    draft.editingRhythm,
    "",
    "## 成功指标",
    "",
    draft.successMetrics,
    "",
    "## 停止条件",
    "",
    draft.stopCondition,
    "",
    `> ${draft.notice}`,
    ""
  ].join("\n");
}
