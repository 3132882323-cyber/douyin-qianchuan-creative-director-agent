const ANALYSIS_KIND = "qianchuan-rule-based-copy-structure-v1";
const ANALYSIS_METHOD = "local_deterministic_rules";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

function stableHash(value) {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function exactIso(value, label) {
  if (typeof value !== "string" || value.length > 40) throw new Error(`${label}格式无效`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(`${label}格式无效`);
  return value;
}

export function normalizeRevisionIdentifier(value, label = "版本编号", { allowEmpty = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return "";
  if (!IDENTIFIER_PATTERN.test(text)) throw new Error(`${label}只允许 1–80 位字母、数字、点、下划线、冒号或连字符`);
  return text;
}

export function analysisReferenceId(analysis) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) throw new Error("来源分析格式无效");
  if (analysis.kind !== ANALYSIS_KIND || analysis.method !== ANALYSIS_METHOD) throw new Error("来源分析类型不受支持");
  if (!analysis.summary || !Array.isArray(analysis.segments)) throw new Error("来源分析缺少摘要或分段");
  const fingerprintSource = {
    generatedAt: exactIso(analysis.generatedAt, "分析时间"),
    summary: analysis.summary,
    coverage: Object.fromEntries(Object.entries(analysis.coverage || {}).map(([id, item]) => [id, {
      count: item?.count,
      segmentIndexes: item?.segmentIndexes
    }])),
    segments: analysis.segments.map((segment) => ({
      index: segment?.index,
      content: segment?.content,
      tags: segment?.tags,
      startMs: segment?.source?.startMs ?? null,
      endMs: segment?.source?.endMs ?? null
    }))
  };
  return `AN-${stableHash(fingerprintSource)}`;
}

function localEntropy() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint32Array(2);
    globalThis.crypto.getRandomValues(bytes);
    return `${bytes[0].toString(16)}${bytes[1].toString(16)}`;
  }
  return `${Date.now()}-${Math.random()}`;
}

export function createRevisionIdentity(analysis, options = {}) {
  const sourceAnalysisId = analysisReferenceId(analysis);
  const createdAt = exactIso(options.createdAt || new Date().toISOString(), "草稿时间");
  const parentVersionId = normalizeRevisionIdentifier(options.parentVersionId, "父版本编号");
  const entropy = String(options.entropy || localEntropy());
  if (!entropy || entropy.length > 200) throw new Error("本地测试编号随机量无效");
  const datePart = createdAt.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const revisionId = `QC-${datePart}-${stableHash({ sourceAnalysisId, parentVersionId, createdAt, entropy })}`;
  return {
    revisionId: normalizeRevisionIdentifier(revisionId, "测试编号", { allowEmpty: false }),
    sourceAnalysisId,
    parentVersionId,
    createdAt
  };
}
