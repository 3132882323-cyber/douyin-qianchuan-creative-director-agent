const COMPARISON_METRICS = Object.freeze([
  { key: "roi", label: "ROI", kind: "number" },
  { key: "ctr", label: "CTR", kind: "rate" },
  { key: "cvr", label: "CVR", kind: "rate" },
  { key: "threeSecondRate", label: "3 秒播放率", kind: "rate" },
  { key: "completionRate", label: "完播率", kind: "rate" }
]);

const COMPARISON_NOTICE = "仅为同一父子链上的描述性对照，不证明因果、统计显著性或胜负。";

function safeTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("父子版本对照时间线格式无效");
  return timeline;
}

function safeEntry(entry) {
  if (!entry?.version?.testId) throw new Error("父子版本对照缺少当前测试编号");
  return entry;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function displayValue(value, kind) {
  return kind === "rate" ? `${(value * 100).toFixed(2)}%` : value.toFixed(2);
}

function displayDelta(value, kind) {
  const adjusted = kind === "rate" ? value * 100 : value;
  const rounded = Number(adjusted.toFixed(2));
  const suffix = kind === "rate" ? "pp" : "";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}${suffix}`;
}

function sample(entry) {
  return {
    spend: finite(entry?.result?.metrics?.spend),
    minSpend: finite(entry?.version?.minSpend)
  };
}

function status(current, parent, code, label) {
  return {
    currentTestId: current.version.testId,
    parentTestId: current.version.parentVersionId,
    code,
    ready: false,
    label,
    summary: label,
    metrics: [],
    sample: { current: sample(current), parent: parent ? sample(parent) : null },
    notice: COMPARISON_NOTICE
  };
}

export function buildExperimentParentComparison(entry, timeline = []) {
  const current = safeEntry(entry);
  const entries = safeTimeline(timeline);
  const parentTestId = String(current.version.parentVersionId || "");
  if (!parentTestId) return null;
  const projectId = String(current.version.projectId || "");
  const parent = entries.find((candidate) => candidate?.version?.testId === parentTestId
    && (!projectId || candidate?.version?.projectId === projectId));
  if (!parent) return status(current, null, "parent_missing", "父版本记录不可用");
  if (!current.result) return status(current, parent, "current_result_missing", "当前版本尚未回填结果");
  if (!parent.result) return status(current, parent, "parent_result_missing", "父版本尚未回填结果");
  if (current.result.qualityWarnings?.length) return status(current, parent, "current_quality_warning", "当前版本存在指标口径提醒，暂不计算对照");
  if (parent.result.qualityWarnings?.length) return status(current, parent, "parent_quality_warning", "父版本存在指标口径提醒，暂不计算对照");

  const currentSpend = finite(current.result.metrics?.spend);
  const parentSpend = finite(parent.result.metrics?.spend);
  const currentMinSpend = finite(current.version.minSpend);
  const parentMinSpend = finite(parent.version.minSpend);
  if (currentSpend === null || currentMinSpend === null || currentSpend < currentMinSpend) {
    return status(current, parent, "current_insufficient", "当前版本尚未达到最低消耗");
  }
  if (parentSpend === null || parentMinSpend === null || parentSpend < parentMinSpend) {
    return status(current, parent, "parent_insufficient", "父版本尚未达到最低消耗");
  }

  const metrics = COMPARISON_METRICS.flatMap((definition) => {
    const currentValue = finite(current.result.metrics?.[definition.key]);
    const parentValue = finite(parent.result.metrics?.[definition.key]);
    if (currentValue === null || parentValue === null) return [];
    const delta = currentValue - parentValue;
    return [{
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      current: currentValue,
      parent: parentValue,
      delta,
      currentDisplay: displayValue(currentValue, definition.kind),
      parentDisplay: displayValue(parentValue, definition.kind),
      deltaDisplay: displayDelta(delta, definition.kind)
    }];
  });
  if (!metrics.length) return status(current, parent, "no_common_metrics", "父子版本没有可共同对照的效果指标");

  return {
    currentTestId: current.version.testId,
    parentTestId,
    code: "ready",
    ready: true,
    label: "父子指标对照",
    summary: metrics.slice(0, 2).map((metric) => `${metric.label} ${metric.deltaDisplay}`).join(" · "),
    metrics,
    sample: { current: sample(current), parent: sample(parent) },
    notice: COMPARISON_NOTICE
  };
}
