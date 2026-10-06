export const PRODUCTION_COMMAND_ROUTE_KEY = "pendingProductionCommandRoute";
export const PRODUCTION_COMMAND_ROUTE_MAX_AGE_MS = 5 * 60 * 1000;

const PROJECT_ID_PATTERN = /^prj_[a-z0-9-]{8,64}$/iu;
const COMMAND_ID_PATTERN = /^[a-z0-9._:-]{1,240}$/iu;

function exactIso(value, label) {
  const candidate = String(value || "");
  const parsed = Date.parse(candidate);
  if (!candidate || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== candidate) throw new Error(`${label}时间无效`);
  return candidate;
}

export function createPendingProductionCommandRoute({ projectId, commandId, now = new Date().toISOString() } = {}) {
  const safeProjectId = String(projectId || "");
  const safeCommandId = String(commandId || "");
  if (!PROJECT_ID_PATTERN.test(safeProjectId)) throw new Error("待执行生产动作的项目编号无效");
  if (!COMMAND_ID_PATTERN.test(safeCommandId)) throw new Error("待执行生产动作编号无效");
  return { schemaVersion: 1, projectId: safeProjectId, commandId: safeCommandId, createdAt: exactIso(now, "待执行生产动作") };
}

export function validatePendingProductionCommandRoute(value, {
  currentProjectId,
  now = new Date().toISOString(),
  maxAgeMs = PRODUCTION_COMMAND_ROUTE_MAX_AGE_MS
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("待执行生产动作格式无效");
  if (Object.keys(value).some((key) => !["schemaVersion", "projectId", "commandId", "createdAt"].includes(key)) || value.schemaVersion !== 1) {
    throw new Error("待执行生产动作版本无效");
  }
  const route = createPendingProductionCommandRoute({
    projectId: value.projectId,
    commandId: value.commandId,
    now: value.createdAt
  });
  if (String(currentProjectId || "") !== route.projectId) throw new Error("待执行生产动作不属于当前项目");
  const currentTime = Date.parse(exactIso(now, "当前"));
  const routeTime = Date.parse(route.createdAt);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || currentTime < routeTime || currentTime - routeTime > maxAgeMs) {
    throw new Error("待执行生产动作已经过期");
  }
  return route;
}

export function pendingRouteMatchesCommand(route, command) {
  return Boolean(
    route
    && command
    && command.current === true
    && route.projectId === command.projectId
    && route.commandId === command.id
  );
}
