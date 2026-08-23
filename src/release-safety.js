const MIB = 1024 * 1024;

export const NON_MEDIA_IMPORT_POLICIES = Object.freeze({
  report: Object.freeze({ label: "素材报表", maxBytes: 8 * MIB, extensions: Object.freeze([".csv", ".tsv"]) }),
  experimentResult: Object.freeze({ label: "测试结果", maxBytes: 2 * MIB, extensions: Object.freeze([".csv", ".tsv"]) }),
  backup: Object.freeze({ label: "工作区备份", maxBytes: 12 * MIB, extensions: Object.freeze([".json"]) }),
  executionResult: Object.freeze({ label: "本机执行结果", maxBytes: 2 * MIB, extensions: Object.freeze([".json"]) }),
  transcript: Object.freeze({ label: "转写文本", maxBytes: 4 * MIB, extensions: Object.freeze([".txt", ".md", ".srt", ".vtt"]) })
});

function extensionOf(name) {
  const text = String(name || "").trim().toLowerCase();
  const dot = text.lastIndexOf(".");
  return dot >= 0 ? text.slice(dot) : "";
}

export function formatByteLimit(bytes) {
  return bytes % MIB === 0 ? `${bytes / MIB} MB` : `${(bytes / MIB).toFixed(1)} MB`;
}

export function validateNonMediaImport(file, policyName) {
  const policy = NON_MEDIA_IMPORT_POLICIES[policyName];
  if (!policy) throw new Error("未知的本地导入类型");
  if (!file || typeof file !== "object") throw new Error(`请选择${policy.label}文件`);
  const name = String(file.name || "").trim();
  const extension = extensionOf(name);
  if (!name || !policy.extensions.includes(extension)) {
    throw new Error(`${policy.label}仅支持 ${policy.extensions.join("、")} 文件`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error(`${policy.label}为空或文件大小无效`);
  if (size > policy.maxBytes) throw new Error(`${policy.label}超过 ${formatByteLimit(policy.maxBytes)} 上限`);
  return { name, extension, size, maxBytes: policy.maxBytes };
}

export function parseJsonDocument(text, label = "JSON 文件") {
  const source = String(text ?? "").replace(/^\uFEFF/u, "").trim();
  if (!source) throw new Error(`${label}为空`);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
}

export function spreadsheetSafeText(value) {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const text = String(value ?? "");
  return /^(?:[\t\r]|[\s\uFEFF]*[=+\-@])/u.test(text) ? `'${text}` : text;
}
