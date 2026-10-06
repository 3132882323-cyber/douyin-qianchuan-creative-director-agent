import test from "node:test";
import assert from "node:assert/strict";
import {
  createPendingProductionCommandRoute,
  pendingRouteMatchesCommand,
  validatePendingProductionCommandRoute
} from "../src/production-command-route.js";

const NOW = "2026-09-02T08:00:00.000Z";

test("creates and validates a short-lived project-bound command route", () => {
  const route = createPendingProductionCommandRoute({
    projectId: "prj_12345678",
    commandId: "prj_12345678:reshoot:batch-a01",
    now: NOW
  });
  assert.deepEqual(validatePendingProductionCommandRoute(route, {
    currentProjectId: route.projectId,
    now: "2026-09-02T08:04:59.000Z"
  }), route);
  assert.equal(pendingRouteMatchesCommand(route, { ...route, id: route.commandId, current: true }), true);
});

test("rejects foreign, expired, future and unknown-field routes", () => {
  const route = createPendingProductionCommandRoute({ projectId: "prj_12345678", commandId: "prj_12345678:planned:project", now: NOW });
  assert.throws(() => validatePendingProductionCommandRoute(route, { currentProjectId: "prj_87654321", now: NOW }), /不属于当前项目/u);
  assert.throws(() => validatePendingProductionCommandRoute(route, { currentProjectId: route.projectId, now: "2026-09-02T08:05:01.000Z" }), /已经过期/u);
  assert.throws(() => validatePendingProductionCommandRoute(route, { currentProjectId: route.projectId, now: "2026-09-02T07:59:59.000Z" }), /已经过期/u);
  assert.throws(() => validatePendingProductionCommandRoute({ ...route, route: "task" }, { currentProjectId: route.projectId, now: NOW }), /版本无效/u);
});

test("matches only the freshly rebuilt current-project command identity", () => {
  const route = createPendingProductionCommandRoute({ projectId: "prj_12345678", commandId: "prj_12345678:hold:a01", now: NOW });
  assert.equal(pendingRouteMatchesCommand(route, { id: route.commandId, projectId: route.projectId, current: true }), true);
  assert.equal(pendingRouteMatchesCommand(route, { id: route.commandId, projectId: route.projectId, current: false }), false);
  assert.equal(pendingRouteMatchesCommand(route, { id: "prj_12345678:reshoot:a01", projectId: route.projectId, current: true }), false);
  assert.equal(pendingRouteMatchesCommand(route, { id: route.commandId, projectId: "prj_87654321", current: true }), false);
});

test("rejects malformed identifiers and timestamps", () => {
  assert.throws(() => createPendingProductionCommandRoute({ projectId: "bad", commandId: "valid", now: NOW }), /项目编号无效/u);
  assert.throws(() => createPendingProductionCommandRoute({ projectId: "prj_12345678", commandId: "contains spaces", now: NOW }), /动作编号无效/u);
  assert.throws(() => createPendingProductionCommandRoute({ projectId: "prj_12345678", commandId: "valid", now: "today" }), /时间无效/u);
});
