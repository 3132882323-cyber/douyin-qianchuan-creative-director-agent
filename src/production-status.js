export const PRODUCTION_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ code: "planned", label: "待拍" }),
  Object.freeze({ code: "shooting", label: "拍摄中" }),
  Object.freeze({ code: "editing", label: "剪辑中" }),
  Object.freeze({ code: "ready", label: "待投放" }),
  Object.freeze({ code: "launched", label: "已上线" }),
  Object.freeze({ code: "paused", label: "已搁置" })
]);

export const PRODUCTION_STAGE_CODES = Object.freeze(PRODUCTION_STAGE_DEFINITIONS.map((entry) => entry.code));
export const PRODUCTION_STAGE_LABELS = Object.freeze(Object.fromEntries(PRODUCTION_STAGE_DEFINITIONS.map((entry) => [entry.code, entry.label])));

function exactIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间格式无效`);
  return candidate;
}

export function sanitizeProductionStatus(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("人工制作状态格式无效");
  const stage = String(value.stage || "").trim();
  if (!PRODUCTION_STAGE_CODES.includes(stage)) throw new Error("人工制作状态代码无效");
  return {
    stage,
    updatedAt: exactIso(value.updatedAt, "人工制作状态更新")
  };
}

export function createProductionStatus(stage, updatedAt = new Date().toISOString()) {
  return sanitizeProductionStatus({ stage, updatedAt });
}

export function productionStageCode(value) {
  return sanitizeProductionStatus(value)?.stage || "untracked";
}

export function productionStageLabel(value) {
  const code = productionStageCode(value);
  return code === "untracked" ? "未标记" : PRODUCTION_STAGE_LABELS[code];
}

export function summarizeProductionTimeline(timeline = []) {
  if (!Array.isArray(timeline)) throw new Error("制作进度时间线格式无效");
  const counts = Object.fromEntries(["untracked", ...PRODUCTION_STAGE_CODES].map((code) => [code, 0]));
  for (const entry of timeline) counts[productionStageCode(entry?.version?.productionStatus)] += 1;
  return {
    total: timeline.length,
    counts,
    active: counts.planned + counts.shooting + counts.editing + counts.ready,
    launched: counts.launched,
    paused: counts.paused,
    untracked: counts.untracked
  };
}
