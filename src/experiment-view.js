import { EXPERIMENT_LEDGER_FILTERS, filterExperimentTimeline } from "./experiment-ledger.js";

export const EXPERIMENT_VIEW_PAGE_SIZE = 20;
export const EXPERIMENT_VIEW_QUERY_MAX_LENGTH = 128;

const MAX_PAGE_SIZE = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

function safeTimeline(timeline) {
  if (!Array.isArray(timeline)) throw new Error("实验版本视图格式无效");
  return timeline;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label}必须是有效正整数`);
  return value;
}

function normalizeQuery(value) {
  const query = String(value ?? "").normalize("NFKC").trim();
  if (query.length > EXPERIMENT_VIEW_QUERY_MAX_LENGTH) throw new Error(`版本搜索最多 ${EXPERIMENT_VIEW_QUERY_MAX_LENGTH} 个字符`);
  if (CONTROL_CHARACTERS.test(query)) throw new Error("版本搜索包含不支持的控制字符");
  return query.toLocaleLowerCase("zh-CN");
}

function searchableVersionText(entry) {
  const version = entry?.version || {};
  return [
    version.testId,
    version.parentVersionId,
    version.batchId,
    version.primaryVariable,
    version.baselineCreative,
    version.planItem?.variant
  ]
    .map((value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .join("\n");
}

export function experimentBatchOptions(timeline = []) {
  const entries = safeTimeline(timeline);
  const counts = new Map();
  for (const entry of entries) {
    const id = String(entry?.version?.batchId || "").trim();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count }));
}

export function buildExperimentView(timeline = [], {
  filter = "all",
  batchId = "all",
  query = "",
  page = 1,
  pageSize = EXPERIMENT_VIEW_PAGE_SIZE
} = {}) {
  const entries = safeTimeline(timeline);
  const safeFilter = EXPERIMENT_LEDGER_FILTERS.includes(filter) ? filter : "all";
  const safeBatchId = String(batchId || "all").trim() || "all";
  const safeQuery = normalizeQuery(query);
  const requestedPage = positiveInteger(page, "版本页码");
  const safePageSize = positiveInteger(pageSize, "每页版本数", MAX_PAGE_SIZE);
  const availableBatches = experimentBatchOptions(entries);
  const statusMatches = filterExperimentTimeline(entries, safeFilter);
  const matches = statusMatches.filter((entry) => {
    if (safeBatchId !== "all" && entry?.version?.batchId !== safeBatchId) return false;
    return !safeQuery || searchableVersionText(entry).includes(safeQuery);
  });
  const total = matches.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * safePageSize;
  const items = matches.slice(offset, offset + safePageSize);

  return {
    items,
    total,
    overallTotal: entries.length,
    page: currentPage,
    pageSize: safePageSize,
    totalPages,
    from: total ? offset + 1 : 0,
    to: total ? offset + items.length : 0,
    filter: safeFilter,
    batchId: safeBatchId,
    query: safeQuery,
    availableBatches
  };
}
