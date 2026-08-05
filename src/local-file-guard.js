const MIB = 1024 * 1024;
const MATCH_MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpeg", ".mpg", ".mts", ".m2ts",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"
]);

export const MASTER_MATCH_LIMITS = Object.freeze({
  maxPlatformFiles: 40,
  maxMasterFiles: 120,
  maxSingleFileBytes: 256 * MIB,
  maxTotalBytes: 1024 * MIB
});

export function formatLocalBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * MIB) return `${(bytes / 1024 / MIB).toFixed(1)} GB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.max(0, bytes)} B`;
}

export function isSupportedMatchMedia(file = {}) {
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("video/") || type.startsWith("image/")) return true;
  const name = String(file.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && MATCH_MEDIA_EXTENSIONS.has(name.slice(dot));
}

function validateBatch(files, label, maxFiles, limits) {
  const list = [...(files || [])];
  if (!list.length) throw new Error(`请选择${label}`);
  if (list.length > maxFiles) throw new Error(`${label}最多选择 ${maxFiles} 个文件`);
  let totalBytes = 0;
  for (const file of list) {
    const name = String(file?.name || "未命名文件");
    if (!isSupportedMatchMedia(file)) throw new Error(`${label}“${name}”不是支持的视频或图片格式`);
    const size = Number(file?.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`${label}“${name}”大小无效`);
    if (size > limits.maxSingleFileBytes) {
      throw new Error(`${label}“${name}”超过单文件 ${formatLocalBytes(limits.maxSingleFileBytes)} 上限`);
    }
    totalBytes += size;
  }
  return { files: list, totalBytes };
}

export function validateMasterMatchSelection(platformFiles, masterFiles, limits = MASTER_MATCH_LIMITS) {
  const platform = validateBatch(platformFiles, "平台素材", limits.maxPlatformFiles, limits);
  const masters = validateBatch(masterFiles, "团队母版", limits.maxMasterFiles, limits);
  const totalBytes = platform.totalBytes + masters.totalBytes;
  if (totalBytes > limits.maxTotalBytes) {
    throw new Error(`本轮匹配文件总大小超过 ${formatLocalBytes(limits.maxTotalBytes)} 上限`);
  }
  return {
    platformFiles: platform.files,
    masterFiles: masters.files,
    totalFiles: platform.files.length + masters.files.length,
    totalBytes
  };
}
