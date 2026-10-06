import { CONTENT_PRIORITY_LANES, buildContentPriorityBoard } from "./content-priority.js";

function safeRoot(root) {
  return root && typeof root.querySelector === "function" && typeof root.createElement === "function" ? root : null;
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

function element(documentRoot, tagName, className = "", text = "") {
  const node = documentRoot.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function laneDefinitions() {
  if (Array.isArray(CONTENT_PRIORITY_LANES)) {
    return CONTENT_PRIORITY_LANES.map((entry) => typeof entry === "string"
      ? { code: entry, label: entry }
      : { code: String(entry.code), label: String(entry.label || entry.code) });
  }
  return Object.entries(CONTENT_PRIORITY_LANES || {}).map(([code, value]) => ({
    code,
    label: typeof value === "string" ? value : String(value?.label || code)
  }));
}

function actionButton(documentRoot, label, action, projectId, disabled = false, projectName = "") {
  const button = element(documentRoot, "button", "secondary content-priority-action", label);
  button.type = "button";
  button.dataset.priorityAction = action;
  button.dataset.priorityProjectId = projectId;
  button.dataset.boundaryDisabled = String(disabled);
  button.disabled = disabled;
  button.setAttribute("aria-label", projectName ? `${projectName}：${label}` : label);
  return button;
}

function inputField(documentRoot, labelText, control) {
  const label = element(documentRoot, "label", "content-priority-field");
  label.append(element(documentRoot, "span", "", labelText), control);
  return label;
}

function projectCard(documentRoot, entry, lane, index, draft = null) {
  const card = element(documentRoot, "article", "content-priority-card");
  card.dataset.projectId = entry.projectId;
  card.dataset.priorityState = entry.status;
  card.tabIndex = -1;
  if (entry.current) card.dataset.current = "true";

  const head = element(documentRoot, "div", "content-priority-card-head");
  const copy = element(documentRoot, "div", "content-priority-card-copy");
  copy.append(
    element(documentRoot, "strong", "", entry.name),
    element(documentRoot, "small", "", `${entry.phaseLabel} · ${entry.nextLabel}`)
  );
  const badgeText = entry.status === "stale"
    ? "需重审"
    : entry.status === "unplanned"
      ? "未排期"
      : entry.overdue
        ? "已到期"
        : entry.current
          ? "当前项目"
          : "有效";
  head.append(copy, element(documentRoot, "b", "content-priority-badge", badgeText));

  const context = element(documentRoot, "p", "content-priority-context", entry.contextSummary);
  const laneSelect = element(documentRoot, "select");
  laneSelect.dataset.priorityField = "lane";
  laneSelect.setAttribute("aria-label", `${entry.name}：人工优先泳道`);
  for (const definition of laneDefinitions()) {
    const option = element(documentRoot, "option", "", definition.label);
    option.value = definition.code;
    option.selected = definition.code === (draft?.lane || entry.lane || "backlog");
    laneSelect.append(option);
  }
  const reason = element(documentRoot, "textarea");
  reason.rows = 2;
  reason.maxLength = 200;
  reason.value = draft?.reason ?? entry.reason ?? "";
  reason.placeholder = "至少 4 个字符：为什么现在做，或为什么暂缓";
  reason.dataset.priorityField = "reason";
  reason.setAttribute("aria-label", `${entry.name}：人工优先理由`);
  const dueOn = element(documentRoot, "input");
  dueOn.type = "date";
  dueOn.value = draft?.dueOn ?? entry.dueOn ?? "";
  dueOn.dataset.priorityField = "dueOn";
  dueOn.setAttribute("aria-label", `${entry.name}：期望完成日期`);

  const form = element(documentRoot, "div", "content-priority-form");
  form.append(
    inputField(documentRoot, "人工泳道", laneSelect),
    inputField(documentRoot, "优先理由", reason),
    inputField(documentRoot, "截止日（可选）", dueOn)
  );

  const movable = lane.items.filter((item) => item.status !== "unplanned");
  const movableIndex = movable.findIndex((item) => item.projectId === entry.projectId);
  const controls = element(documentRoot, "div", "content-priority-card-actions");
  controls.append(
    actionButton(documentRoot, entry.status === "unplanned" ? "保存排期" : entry.status === "stale" ? "重新确认" : "保存修改", "save", entry.projectId, false, entry.name),
    actionButton(documentRoot, "上移", "up", entry.projectId, movableIndex <= 0, entry.name),
    actionButton(documentRoot, "下移", "down", entry.projectId, movableIndex < 0 || movableIndex >= movable.length - 1, entry.name),
    actionButton(documentRoot, "进入项目", "switch", entry.projectId, entry.current, entry.name),
    actionButton(documentRoot, "清除排期", "clear", entry.projectId, entry.status === "unplanned", entry.name)
  );
  card.append(head, context, form, controls);
  return card;
}

function safeProjects(reader) {
  try {
    const projects = reader();
    return { projects: Array.isArray(projects) ? projects : [], error: null };
  } catch (error) {
    return { projects: [], error };
  }
}

export function mountContentPriorityBoard({
  root,
  getProjects,
  getCurrentProjectId,
  savePriority,
  movePriority,
  clearPriority,
  switchProject,
  confirmClear,
  today
} = {}) {
  const scope = safeRoot(root);
  const projectsReader = typeof getProjects === "function" ? getProjects : () => [];
  const currentProjectReader = typeof getCurrentProjectId === "function" ? getCurrentProjectId : () => null;
  const save = typeof savePriority === "function" ? savePriority : async () => { throw new Error("排期存储不可用"); };
  const move = typeof movePriority === "function" ? movePriority : async () => { throw new Error("排期排序不可用"); };
  const clear = typeof clearPriority === "function" ? clearPriority : async () => { throw new Error("排期清理不可用"); };
  const openProject = typeof switchProject === "function" ? switchProject : async () => false;
  const allowClear = typeof confirmClear === "function" ? confirmClear : () => false;
  const stateNode = scope?.querySelector("#content-priority-state") || null;
  const summaryNode = scope?.querySelector("#content-priority-summary") || null;
  const lanesNode = scope?.querySelector("#content-priority-lanes") || null;
  const feedbackNode = scope?.querySelector("#content-priority-feedback") || null;
  const mounted = Boolean(scope && stateNode && summaryNode && lanesNode && feedbackNode);
  let busy = false;
  let operation = 0;
  let destroyed = false;
  let lastBoard = null;

  function todayValue() {
    if (typeof today === "function") return today();
    if (today) return today;
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function disableActions(disabled) {
    for (const button of lanesNode?.querySelectorAll?.("[data-priority-action]") || []) button.disabled = disabled || button.dataset.boundaryDisabled === "true";
    for (const control of lanesNode?.querySelectorAll?.("[data-priority-field]") || []) control.disabled = disabled;
  }

  function currentDrafts() {
    const drafts = new Map();
    for (const card of lanesNode?.querySelectorAll?.("[data-project-id]") || []) {
      const projectId = String(card.dataset.projectId || "");
      if (!projectId) continue;
      drafts.set(projectId, {
        lane: field(card, "lane")?.value,
        reason: field(card, "reason")?.value ?? "",
        dueOn: field(card, "dueOn")?.value ?? ""
      });
    }
    return drafts;
  }

  function render({ preserveDrafts = true, discardDraftProjectId = "" } = {}) {
    if (!mounted || destroyed) return null;
    const drafts = preserveDrafts ? currentDrafts() : new Map();
    if (discardDraftProjectId) drafts.delete(discardDraftProjectId);
    const snapshot = safeProjects(projectsReader);
    if (snapshot.error) {
      lastBoard = null;
      setText(stateNode, "排期暂不可用");
      setText(summaryNode, snapshot.error?.message || "无法读取本地项目集合。");
      lanesNode.replaceChildren();
      return null;
    }
    try {
      const board = buildContentPriorityBoard(snapshot.projects, {
        currentProjectId: currentProjectReader(),
        today: todayValue()
      });
      lastBoard = board;
      const topText = board.topNow.length
        ? board.topNow.map((entry, index) => `${index + 1}. ${entry.name}：${entry.reason}`).join("；")
        : "尚无有效的“立即做”项目；请由内容负责人填写理由并人工排期。";
      const immediateCount = board.lanes
        .find((lane) => lane.code === "now")
        ?.items.filter((entry) => entry.status === "current").length || 0;
      setText(stateNode, `立即做 ${immediateCount} · 需重审 ${board.staleCount} · 未排期 ${board.unplannedCount}`);
      setText(summaryNode, topText);
      lanesNode.replaceChildren();
      for (const lane of board.lanes) {
        const section = element(scope, "section", "content-priority-lane");
        section.dataset.priorityLane = lane.code;
        const heading = element(scope, "h3", "content-priority-lane-title", `${lane.label} · ${lane.items.length}`);
        section.append(heading);
        if (!lane.items.length) {
          section.append(element(scope, "p", "content-priority-empty", "暂无项目"));
        } else {
          lane.items.forEach((entry, index) => section.append(projectCard(scope, entry, lane, index, drafts.get(entry.projectId))));
        }
        lanesNode.append(section);
      }
      const unplanned = board.entries.filter((entry) => entry.status === "unplanned");
      if (unplanned.length) {
        const section = element(scope, "section", "content-priority-lane content-priority-unplanned");
        section.dataset.priorityLane = "unplanned";
        section.append(element(scope, "h3", "content-priority-lane-title", `未排期 · ${unplanned.length}`));
        const lane = { code: "unplanned", label: "未排期", items: unplanned };
        unplanned.forEach((entry, index) => section.append(projectCard(scope, entry, lane, index, drafts.get(entry.projectId))));
        lanesNode.append(section);
      }
      disableActions(busy);
      return board;
    } catch (error) {
      lastBoard = null;
      setText(stateNode, "排期暂不可用");
      setText(summaryNode, error?.message || "当前项目排期格式无效。");
      lanesNode.replaceChildren();
      return null;
    }
  }

  function field(card, name) {
    return card?.querySelector?.(`[data-priority-field="${name}"]`) || null;
  }

  function unsavedDraftCount() {
    if (!mounted || destroyed || !lastBoard) return 0;
    const entries = new Map(lastBoard.entries.map((entry) => [entry.projectId, entry]));
    let count = 0;
    for (const card of lanesNode.querySelectorAll?.("[data-project-id]") || []) {
      const entry = entries.get(String(card.dataset.projectId || ""));
      if (!entry) continue;
      const lane = field(card, "lane")?.value || "";
      const reason = field(card, "reason")?.value ?? "";
      const dueOn = field(card, "dueOn")?.value ?? "";
      if (lane !== (entry.lane || "backlog") || reason !== (entry.reason || "") || dueOn !== (entry.dueOn || "")) count += 1;
    }
    return count;
  }

  async function handleClick(event) {
    const button = event?.target?.closest?.("[data-priority-action]");
    if (!button || busy || destroyed) return;
    const projectId = String(button.dataset.priorityProjectId || "");
    const card = button.closest?.("[data-project-id]");
    const action = button.dataset.priorityAction;
    if (!projectId || !card || !action) return;
    const projectName = card.querySelector?.("strong")?.textContent || "当前项目";
    if (action === "clear" && !allowClear(projectName)) return;
    busy = true;
    const currentOperation = ++operation;
    disableActions(true);
    try {
      if (action === "save") {
        await save(projectId, {
          lane: field(card, "lane")?.value,
          reason: field(card, "reason")?.value,
          dueOn: field(card, "dueOn")?.value || null
        });
        if (currentOperation === operation && !destroyed) setText(feedbackNode, `已保存“${projectName}”的人工排期。`);
      } else if (action === "up" || action === "down") {
        await move(projectId, action);
        if (currentOperation === operation && !destroyed) setText(feedbackNode, `已${action === "up" ? "上移" : "下移"}“${projectName}”。`);
      } else if (action === "clear") {
        await clear(projectId);
        if (currentOperation === operation && !destroyed) setText(feedbackNode, `已清除“${projectName}”的人工排期。`);
      } else if (action === "switch") {
        const switched = await openProject(projectId);
        if (currentOperation === operation && !destroyed && switched === false) setText(feedbackNode, `未切换到“${projectName}”；当前项目保持不变。`);
      }
      if (currentOperation === operation && !destroyed && action !== "switch") {
        render({ preserveDrafts: true, discardDraftProjectId: action === "save" || action === "clear" ? projectId : "" });
        if (action === "up" || action === "down") {
          const movedCard = lanesNode.querySelector?.(`[data-project-id="${projectId}"]`);
          movedCard?.focus?.();
        }
      }
    } catch (error) {
      if (currentOperation === operation && !destroyed) setText(feedbackNode, error?.message || "排期操作失败，原顺序保持不变。");
    } finally {
      if (currentOperation === operation && !destroyed) {
        busy = false;
        disableActions(false);
      }
    }
  }

  const clickListener = (event) => handleClick(event);
  lanesNode?.addEventListener?.("click", clickListener);

  return {
    mounted,
    render,
    unsavedDraftCount,
    destroy() {
      destroyed = true;
      operation += 1;
      lanesNode?.removeEventListener?.("click", clickListener);
    }
  };
}
