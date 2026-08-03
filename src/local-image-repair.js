export const IMAGE_REPAIR_LIMITS = Object.freeze({
  maxFileBytes: 40 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 16_000_000,
  estimatedBytesPerPixel: 16,
  maxEstimatedBytes: 256 * 1024 * 1024,
  maxMaskCoverage: 0.45,
  maxSelectedPixels: 400_000,
  maxFeatherRadius: 96,
  maxSearchRadius: 128,
  maxHistoryStates: 50
});

export const SUPPORTED_REPAIR_TYPES = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
});

const TYPE_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
});

const SAMPLE_DIRECTIONS = Object.freeze(Array.from({ length: 24 }, (_, index) => {
  const angle = (Math.PI * 2 * index) / 24;
  return [Math.cos(angle), Math.sin(angle)];
}));

function integer(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须在 ${min}-${max} 之间`);
  }
  return parsed;
}

function finiteNumber(value, fallback, label, min, max) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}必须在 ${min}-${max} 之间`);
  }
  return parsed;
}

function inferredMime(file = {}) {
  const explicit = String(file.type || "").toLowerCase();
  if (Object.hasOwn(SUPPORTED_REPAIR_TYPES, explicit)) return explicit;
  const name = String(file.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? TYPE_BY_EXTENSION[name.slice(dot)] || "" : "";
}

export function validateRepairFile(file = {}) {
  const mime = inferredMime(file);
  if (!mime) throw new Error("仅支持 PNG、JPEG 或静态 WebP 图片");
  const size = Number(file.size || 0);
  if (!Number.isFinite(size) || size <= 0) throw new Error("图片文件为空或大小无效");
  if (size > IMAGE_REPAIR_LIMITS.maxFileBytes) {
    throw new Error(`图片文件超过 ${Math.round(IMAGE_REPAIR_LIMITS.maxFileBytes / 1024 / 1024)} MB 限制`);
  }
  return { mime, extension: SUPPORTED_REPAIR_TYPES[mime], size };
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function validateStaticWebpBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new Error("WebP 文件头无效或文件已损坏");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (size < 0 || offset + 8 + size > bytes.length) throw new Error("WebP 数据块长度无效或文件已损坏");
    if (kind === "ANIM" || kind === "ANMF" || (kind === "VP8X" && size > 0 && (bytes[offset + 8] & 0x02) !== 0)) {
      throw new Error("暂不支持动态 WebP，请从自有工程导出静态 PNG、JPEG 或 WebP 后再试");
    }
    offset += 8 + size + (size % 2);
  }
  return true;
}

export function validateRepairDimensions(width, height) {
  const safeWidth = integer(width, "图片宽度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  const safeHeight = integer(height, "图片高度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  const pixels = safeWidth * safeHeight;
  if (pixels > IMAGE_REPAIR_LIMITS.maxPixels) {
    throw new Error(`图片共 ${pixels.toLocaleString("zh-CN")} 像素，超过 ${IMAGE_REPAIR_LIMITS.maxPixels.toLocaleString("zh-CN")} 像素保护上限`);
  }
  const estimatedBytes = pixels * IMAGE_REPAIR_LIMITS.estimatedBytesPerPixel;
  if (estimatedBytes > IMAGE_REPAIR_LIMITS.maxEstimatedBytes) {
    throw new Error("预计处理内存过高，请先使用自有工程缩小图片后再试");
  }
  return { width: safeWidth, height: safeHeight, pixels, estimatedBytes };
}

function clonePoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function cloneStroke(stroke) {
  return {
    tool: stroke.tool === "eraser" ? "eraser" : "brush",
    size: Number(stroke.size),
    points: Array.isArray(stroke.points) ? stroke.points.map(clonePoint) : []
  };
}

function cloneStrokes(strokes = []) {
  return Array.isArray(strokes) ? strokes.map(cloneStroke) : [];
}

export function createMaskHistory(initialStrokes = []) {
  return { states: [cloneStrokes(initialStrokes)], index: 0 };
}

export function currentMaskStrokes(history) {
  if (!history?.states?.length) return [];
  return cloneStrokes(history.states[history.index] || []);
}

export function commitMaskState(history, strokes) {
  const states = (history?.states || [[]]).slice(0, Number(history?.index || 0) + 1).map(cloneStrokes);
  states.push(cloneStrokes(strokes));
  const trimmed = states.slice(-IMAGE_REPAIR_LIMITS.maxHistoryStates);
  return { states: trimmed, index: trimmed.length - 1 };
}

export function undoMaskState(history) {
  if (!history?.states?.length) return createMaskHistory();
  return { states: history.states.map(cloneStrokes), index: Math.max(0, history.index - 1) };
}

export function redoMaskState(history) {
  if (!history?.states?.length) return createMaskHistory();
  return { states: history.states.map(cloneStrokes), index: Math.min(history.states.length - 1, history.index + 1) };
}

export function clearMaskState(history) {
  return commitMaskState(history, []);
}

export function maskSelectionStats(mask) {
  if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray)) throw new Error("Mask 数据格式无效");
  let selected = 0;
  for (const value of mask) if (value > 0) selected += 1;
  return { selected, total: mask.length, coverage: mask.length ? selected / mask.length : 0 };
}

export function resampleMaskNearest(mask, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray)) throw new Error("Mask 数据格式无效");
  const sw = integer(sourceWidth, "Mask 宽度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  const sh = integer(sourceHeight, "Mask 高度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  const tw = integer(targetWidth, "目标宽度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  const th = integer(targetHeight, "目标高度", 1, IMAGE_REPAIR_LIMITS.maxDimension);
  if (mask.length !== sw * sh) throw new Error("Mask 尺寸与数据长度不一致");
  const output = new Uint8ClampedArray(tw * th);
  for (let y = 0; y < th; y += 1) {
    const sourceY = Math.min(sh - 1, Math.floor((y * sh) / th));
    for (let x = 0; x < tw; x += 1) {
      const sourceX = Math.min(sw - 1, Math.floor((x * sw) / tw));
      output[y * tw + x] = mask[sourceY * sw + sourceX];
    }
  }
  return output;
}

export function featherMaskInward(mask, width, height, radius = 0) {
  const { pixels } = validateRepairDimensions(width, height);
  if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray) || mask.length !== pixels) {
    throw new Error("Mask 尺寸与图片不一致");
  }
  const safeRadius = integer(Math.round(Number(radius || 0)), "羽化半径", 0, IMAGE_REPAIR_LIMITS.maxFeatherRadius);
  if (safeRadius === 0) return new Uint8ClampedArray(mask);

  const infinity = 65535;
  const distances = new Uint16Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      distances[index] = mask[index] === 0 ? 0 : (x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : infinity);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distances[index] === 0) continue;
      let value = distances[index];
      if (x > 0) value = Math.min(value, distances[index - 1] + 1);
      if (y > 0) value = Math.min(value, distances[index - width] + 1);
      if (x > 0 && y > 0) value = Math.min(value, distances[index - width - 1] + 1);
      if (x + 1 < width && y > 0) value = Math.min(value, distances[index - width + 1] + 1);
      distances[index] = value;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distances[index] === 0) continue;
      let value = distances[index];
      if (x + 1 < width) value = Math.min(value, distances[index + 1] + 1);
      if (y + 1 < height) value = Math.min(value, distances[index + width] + 1);
      if (x + 1 < width && y + 1 < height) value = Math.min(value, distances[index + width + 1] + 1);
      if (x > 0 && y + 1 < height) value = Math.min(value, distances[index + width - 1] + 1);
      distances[index] = value;
    }
  }

  const output = new Uint8ClampedArray(pixels);
  const denominator = safeRadius + 1;
  for (let index = 0; index < pixels; index += 1) {
    if (mask[index] === 0) continue;
    const edgeFactor = Math.min(1, distances[index] / denominator);
    output[index] = Math.round(mask[index] * edgeFactor);
  }
  return output;
}

function validateRepairRequest(request = {}) {
  if (request.authorizationConfirmed !== true) {
    throw new Error("请先确认拥有该素材或已取得明确编辑授权");
  }
  const dimensions = validateRepairDimensions(request.width, request.height);
  if (!(request.rgba instanceof Uint8Array || request.rgba instanceof Uint8ClampedArray) || request.rgba.length !== dimensions.pixels * 4) {
    throw new Error("图片像素数据格式无效");
  }
  if (!(request.mask instanceof Uint8Array || request.mask instanceof Uint8ClampedArray) || request.mask.length !== dimensions.pixels) {
    throw new Error("Mask 尺寸与图片不一致");
  }
  const stats = maskSelectionStats(request.mask);
  if (!stats.selected) throw new Error("请先用画笔手动圈选需要修复的普通瑕疵区域");
  if (stats.selected > IMAGE_REPAIR_LIMITS.maxSelectedPixels) {
    throw new Error(`选区超过 ${IMAGE_REPAIR_LIMITS.maxSelectedPixels.toLocaleString("zh-CN")} 像素同步处理上限，请缩小选区、分区处理或先从自有工程缩小图片`);
  }
  if (stats.coverage > IMAGE_REPAIR_LIMITS.maxMaskCoverage) {
    throw new Error("选区超过图片面积的 45%，局部修复只适合小范围瑕疵；请优先使用自有母版或原工程重新导出");
  }
  return {
    ...dimensions,
    stats,
    featherRadius: integer(Math.round(Number(request.featherRadius || 0)), "羽化半径", 0, IMAGE_REPAIR_LIMITS.maxFeatherRadius),
    searchRadius: integer(Math.round(Number(request.searchRadius || 48)), "纹理采样半径", 8, IMAGE_REPAIR_LIMITS.maxSearchRadius)
  };
}

function surroundingColor(source, mask, width, height, x, y, maxRadius) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let weightTotal = 0;
  let samples = 0;
  const radiusStep = Math.max(2, Math.round(maxRadius / 10));
  for (let radius = radiusStep; radius <= maxRadius; radius += radiusStep) {
    for (const [dx, dy] of SAMPLE_DIRECTIONS) {
      const sampleX = Math.round(x + dx * radius);
      const sampleY = Math.round(y + dy * radius);
      if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= height) continue;
      const sampleIndex = sampleY * width + sampleX;
      if (mask[sampleIndex] > 0) continue;
      const pixelIndex = sampleIndex * 4;
      const weight = 1 / Math.max(1, radius);
      red += source[pixelIndex] * weight;
      green += source[pixelIndex + 1] * weight;
      blue += source[pixelIndex + 2] * weight;
      weightTotal += weight;
      samples += 1;
    }
    if (samples >= 10) break;
  }
  return weightTotal ? [red / weightTotal, green / weightTotal, blue / weightTotal] : null;
}

export function repairLocalImage(request = {}) {
  const validated = validateRepairRequest(request);
  const source = new Uint8ClampedArray(request.rgba);
  const result = new Uint8ClampedArray(source);
  const featheredMask = featherMaskInward(request.mask, validated.width, validated.height, validated.featherRadius);
  let changedPixels = 0;

  for (let y = 0; y < validated.height; y += 1) {
    for (let x = 0; x < validated.width; x += 1) {
      const maskIndex = y * validated.width + x;
      const blend = featheredMask[maskIndex] / 255;
      if (blend <= 0) continue;
      const fill = surroundingColor(source, request.mask, validated.width, validated.height, x, y, validated.searchRadius);
      if (!fill) continue;
      const pixelIndex = maskIndex * 4;
      result[pixelIndex] = Math.round(source[pixelIndex] * (1 - blend) + fill[0] * blend);
      result[pixelIndex + 1] = Math.round(source[pixelIndex + 1] * (1 - blend) + fill[1] * blend);
      result[pixelIndex + 2] = Math.round(source[pixelIndex + 2] * (1 - blend) + fill[2] * blend);
      result[pixelIndex + 3] = source[pixelIndex + 3];
      changedPixels += 1;
    }
  }

  if (!changedPixels) throw new Error("选区周围没有足够的可用纹理，请缩小选区或改用自有母版重新导出");
  return {
    data: result,
    featheredMask,
    width: validated.width,
    height: validated.height,
    changedPixels,
    selectedPixels: validated.stats.selected,
    coverage: validated.stats.coverage,
    alphaPreserved: true
  };
}

export function resolveRepairExport({ requestedFormat = "auto", sourceMime = "image/png", jpegQuality = 0.92 } = {}) {
  const format = ["auto", "png", "jpeg"].includes(requestedFormat) ? requestedFormat : "auto";
  const mime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
  return {
    mime,
    extension: mime === "image/jpeg" ? ".jpg" : ".png",
    quality: mime === "image/jpeg" ? finiteNumber(jpegQuality, 0.92, "JPEG 质量", 0.8, 1) : undefined,
    preservesAlpha: mime === "image/png"
  };
}

export function repairOutputName(inputName, extension = ".png") {
  const name = String(inputName || "image").split(/[\\/]/).pop() || "image";
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "image";
  const safeExtension = extension === ".jpg" ? ".jpg" : ".png";
  return `${stem}_repaired${safeExtension}`;
}
