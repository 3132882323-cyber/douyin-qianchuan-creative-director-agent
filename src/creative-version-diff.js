export const CREATIVE_VERSION_DIFF_EXCERPT_LIMIT = 800;

const VARIABLE_KEYS = Object.freeze({
  "前三秒钩子": "hook",
  "核心主张": "coreClaim",
  "拍摄场景": "scene",
  "目标受众": "audience",
  hook: "hook",
  sellingPoint: "coreClaim",
  scene: "scene",
  audience: "audience"
});

const SEMANTIC_FIELDS = Object.freeze([
  { key: "audience", label: "目标受众", scope: "item" },
  { key: "hook", label: "前三秒钩子", scope: "item" },
  { key: "coreClaim", label: "核心主张", scope: "item" },
  { key: "scene", label: "拍摄场景", scope: "item" }
]);

const CONTEXT_FIELDS = Object.freeze([
  { key: "variant", label: "声明变量值", scope: "item", guardrail: false },
  { key: "baselineCreative", label: "基线素材", scope: "version", guardrail: true },
  { key: "fixedElements", label: "保持不变项", scope: "item", guardrail: true },
  { key: "observationMetrics", label: "观察指标", scope: "item", guardrail: true },
  { key: "minSpend", label: "最低测试消耗", scope: "version", guardrail: false }
]);

const PRODUCTION_FIELDS = Object.freeze([
  { key: "spokenScript", label: "口播稿" },
  { key: "storyboard", label: "分镜" },
  { key: "shootingTask", label: "拍摄任务单" },
  { key: "editingNotes", label: "剪辑要求" },
  { key: "subtitleHighlights", label: "字幕重点" },
  { key: "complianceChecklist", label: "合规检查" }
]);

const GROUP_LABELS = Object.freeze({ semantic: "创意语义", context: "测试上下文", production: "生产资料" });
const DIFF_NOTICE = "差异仅用于人工核对是否保持单变量；系统不会据此判断因果、效果或发布安全。";

function safeTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("版本内容差异时间线格式无效");
  return timeline;
}

function safeEntry(entry) {
  if (!entry?.version?.testId || !entry.version.planItem) throw new Error("版本内容差异缺少当前拍摄方案");
  return entry;
}

function normalized(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function excerpt(value) {
  const text = normalized(value);
  return text.length > CREATIVE_VERSION_DIFF_EXCERPT_LIMIT ? `${text.slice(0, CREATIVE_VERSION_DIFF_EXCERPT_LIMIT - 1)}…` : text;
}

function fieldValue(entry, definition) {
  if (definition.scope === "version") return entry.version?.[definition.key];
  if (definition.scope === "production") return entry.version?.planItem?.production?.[definition.key];
  return entry.version?.planItem?.[definition.key];
}

function changedField(current, parent, definition, group, expectedKey) {
  const before = normalized(fieldValue(parent, definition));
  const after = normalized(fieldValue(current, definition));
  if (before === after) return null;
  return {
    key: definition.key,
    label: definition.label,
    group,
    groupLabel: GROUP_LABELS[group],
    before: excerpt(before),
    after: excerpt(after),
    expected: group === "semantic" && definition.key === expectedKey,
    guardrail: definition.guardrail === true
  };
}

function missingParent(current) {
  return {
    currentTestId: current.version.testId,
    parentTestId: current.version.parentVersionId,
    code: "parent_missing",
    badge: "无法对照",
    label: "父版本记录不可用",
    summary: "父版本记录不可用",
    declaredVariable: normalized(current.version.primaryVariable),
    expectedKey: VARIABLE_KEYS[normalized(current.version.primaryVariable)] || null,
    variantConsistent: null,
    semanticChanges: [],
    contextChanges: [],
    productionChanges: [],
    changes: [],
    notice: DIFF_NOTICE
  };
}

export function buildCreativeVersionDiff(entry, timeline = []) {
  const current = safeEntry(entry);
  const entries = safeTimeline(timeline);
  const parentTestId = normalized(current.version.parentVersionId);
  if (!parentTestId) return null;
  const projectId = normalized(current.version.projectId);
  const parent = entries.find((candidate) => candidate?.version?.testId === parentTestId
    && (!projectId || candidate?.version?.projectId === projectId));
  if (!parent?.version?.planItem) return missingParent(current);

  const declaredVariable = normalized(current.version.primaryVariable || current.version.planItem.singleVariable);
  const expectedKey = VARIABLE_KEYS[declaredVariable] || null;
  const semanticChanges = SEMANTIC_FIELDS.map((definition) => changedField(current, parent, definition, "semantic", expectedKey)).filter(Boolean);
  const contextChanges = CONTEXT_FIELDS.map((definition) => changedField(current, parent, definition, "context", expectedKey)).filter(Boolean);
  const productionChanges = PRODUCTION_FIELDS
    .map((definition) => changedField(current, parent, { ...definition, scope: "production" }, "production", expectedKey))
    .filter(Boolean);
  const changes = [...semanticChanges, ...contextChanges, ...productionChanges];
  const expectedChanged = Boolean(expectedKey && semanticChanges.some((change) => change.key === expectedKey));
  const unexpectedSemantic = semanticChanges.filter((change) => change.key !== expectedKey);
  const guardrailChanges = contextChanges.filter((change) => change.guardrail);
  const currentVariant = normalized(current.version.planItem.variant);
  const currentExpectedValue = expectedKey ? normalized(current.version.planItem[expectedKey]) : "";
  const variantConsistent = expectedKey ? currentVariant === currentExpectedValue : null;

  let code;
  let badge;
  let label;
  if (!changes.length) {
    code = "unchanged";
    badge = "未变化";
    label = "父子版本的可拍内容没有可见变化";
  } else if (!expectedKey) {
    code = "unknown_variable";
    badge = "需核对";
    label = `无法识别声明变量“${declaredVariable || "未填写"}”`;
  } else if (unexpectedSemantic.length || guardrailChanges.length || !variantConsistent) {
    const review = [
      ...unexpectedSemantic.map((change) => change.label),
      ...guardrailChanges.map((change) => change.label),
      ...(!variantConsistent ? ["声明变量值不一致"] : [])
    ];
    code = "needs_review";
    badge = "需核对";
    label = `除声明的“${declaredVariable}”外，还需核对：${[...new Set(review)].join("、")}`;
  } else if (!expectedChanged) {
    code = "primary_unchanged";
    badge = "需核对";
    label = `声明变量“${declaredVariable}”没有发生可见变化`;
  } else {
    code = "aligned";
    badge = "单变量一致";
    label = `可见创意语义只变化了声明变量“${declaredVariable}”`;
  }

  const summaryLabels = changes.slice(0, 3).map((change) => change.label);
  return {
    currentTestId: current.version.testId,
    parentTestId,
    code,
    badge,
    label,
    summary: changes.length ? `变化 ${changes.length} 项：${summaryLabels.join("、")}${changes.length > summaryLabels.length ? "等" : ""}` : "没有可见内容变化",
    declaredVariable,
    expectedKey,
    variantConsistent,
    semanticChanges,
    contextChanges,
    productionChanges,
    changes,
    notice: DIFF_NOTICE
  };
}
