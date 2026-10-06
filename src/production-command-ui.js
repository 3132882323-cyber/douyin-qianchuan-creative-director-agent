import { buildProductionCommandBoard } from "./production-command.js";

const MAX_VISIBLE_COMMANDS = 3;

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

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function commandAction(command) {
  return String(command?.actionCode || command?.action || command?.route?.type || command?.id || "next");
}

function commandTestId(command) {
  return String(command?.testId || command?.route?.testId || "");
}

function commandLaneLabel(command) {
  if (command?.laneLabel) return String(command.laneLabel);
  return { now: "立即做", week: "本周", backlog: "候选", paused: "暂停" }[command?.lane] || "已排期";
}

function assignmentNode(documentRoot, command) {
  const assignment = command?.assignment;
  if (!assignment || assignment.source !== "manual_take_review" || !assignment.ownerLabel) return null;
  const node = element(documentRoot, "div", "production-command-assignment");
  const facts = [assignment.materialCode, assignment.takeNumber, assignment.issueTimecode]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  node.append(
    element(documentRoot, "strong", "", `人工责任 · ${assignment.ownerLabel}`),
    element(documentRoot, "small", "", facts.join(" · ") || "来自当前人工过条记录"),
    element(documentRoot, "small", "", `下一条修正 · ${String(assignment.nextCorrection || "请查看人工过条记录")}`)
  );
  return node;
}

function summaryText(board, visibleCount) {
  if (typeof board?.summary === "string" && board.summary.trim()) return board.summary.trim();
  const total = Number.isInteger(board?.total) && board.total >= 0 ? board.total : board.commands.length;
  const hidden = Number.isInteger(board?.hiddenCount) && board.hiddenCount >= 0
    ? board.hiddenCount
    : Math.max(0, total - visibleCount);
  const parts = [
    `待执行 ${total}`,
    `阻塞 ${Number.isInteger(board?.blockedCount) ? board.blockedCount : 0}`,
    `待重审 ${Number.isInteger(board?.staleCount) ? board.staleCount : 0}`,
    `未排期 ${Number.isInteger(board?.unplannedCount) ? board.unplannedCount : 0}`
  ];
  if (hidden > 0) parts.push(`另有 ${hidden} 项请在内容排期中查看`);
  return parts.join(" · ");
}

function commandCard(documentRoot, command, index, currentProjectId) {
  const projectId = String(command?.projectId || "");
  const action = commandAction(command);
  const testId = commandTestId(command);
  const isCurrent = projectId === currentProjectId;
  const card = element(documentRoot, "article", "production-command-card");
  card.dataset.commandIndex = String(index);
  card.dataset.commandId = String(command?.id || "");
  card.dataset.commandProjectId = projectId;
  card.dataset.commandAction = action;
  card.dataset.commandTestId = testId;
  card.dataset.commandCurrent = String(isCurrent);
  card.dataset.commandBlocked = String(command?.blocked === true);

  const head = element(documentRoot, "div", "production-command-card-head");
  const copy = element(documentRoot, "div", "production-command-card-copy");
  copy.append(
    element(documentRoot, "strong", "", String(command?.name || "未命名项目")),
    element(documentRoot, "small", "", String(command?.statusLabel || "待执行"))
  );
  head.append(copy, element(documentRoot, "b", "production-command-badge", isCurrent ? "当前项目" : commandLaneLabel(command)));

  const reason = element(documentRoot, "p", "production-command-reason", String(command?.reason || "请按内容负责人的人工排期执行"));
  const targetVersion = testId
    ? element(documentRoot, "p", "production-command-target", `目标版本 · ${testId}`)
    : null;
  const nextAction = element(
    documentRoot,
    "p",
    "production-command-next",
    `唯一下一步 · ${String(command?.actionLabel || "执行下一步")}`
  );
  const detail = element(documentRoot, "p", "production-command-detail", String(command?.detail || command?.blocker || ""));
  if (!detail.textContent) detail.hidden = true;
  const due = command?.dueOn
    ? `${command.overdue ? "已到期" : "截止"}：${command.dueOn}`
    : "无硬性截止日";
  const meta = element(documentRoot, "small", "production-command-meta", due);
  const assignment = assignmentNode(documentRoot, command);

  const button = element(
    documentRoot,
    "button",
    "primary production-command-action",
    isCurrent ? "前往处理" : "切换到项目"
  );
  button.type = "button";
  button.dataset.commandIndex = String(index);
  button.dataset.commandId = String(command?.id || "");
  button.dataset.commandProjectId = projectId;
  button.dataset.commandAction = action;
  button.dataset.commandTestId = testId;
  button.dataset.commandKind = isCurrent ? "current" : "switch";
  button.setAttribute("aria-label", isCurrent
    ? `${command?.name || "当前项目"}：前往处理 ${command?.actionLabel || "下一步"}`
    : `切换到项目：${command?.name || projectId}`);
  card.append(head, reason);
  if (targetVersion) card.append(targetVersion);
  card.append(nextAction, detail);
  if (assignment) card.append(assignment);
  card.append(meta, button);
  return card;
}

export function mountProductionCommandBoard({
  root,
  loadSnapshot,
  buildBoard = buildProductionCommandBoard,
  getCurrentProjectId,
  getToday,
  switchProject,
  runCurrentAction,
  copyBrief,
  managePriority
} = {}) {
  const scope = safeRoot(root);
  const snapshotLoader = typeof loadSnapshot === "function"
    ? loadSnapshot
    : async () => { throw new Error("无法读取本地跨项目快照"); };
  const boardBuilder = typeof buildBoard === "function" ? buildBoard : buildProductionCommandBoard;
  const currentProjectReader = typeof getCurrentProjectId === "function" ? getCurrentProjectId : () => "";
  const todayReader = typeof getToday === "function" ? getToday : localToday;
  const openProject = typeof switchProject === "function"
    ? switchProject
    : async () => { throw new Error("项目切换暂不可用"); };
  const executeCurrent = typeof runCurrentAction === "function"
    ? runCurrentAction
    : async () => { throw new Error("当前动作暂不可用"); };
  const copyCurrentBrief = typeof copyBrief === "function"
    ? copyBrief
    : async () => { throw new Error("今日排产单暂不可复制"); };
  const openPriority = typeof managePriority === "function" ? managePriority : () => {};
  const stateNode = scope?.querySelector("#production-command-state") || null;
  const boardNode = scope?.querySelector("#production-command-board") || null;
  const summaryNode = scope?.querySelector("#production-command-summary") || null;
  const listNode = scope?.querySelector("#production-command-list") || null;
  const feedbackNode = scope?.querySelector("#production-command-feedback") || null;
  const copyNode = scope?.querySelector("#copy-production-shift-brief") || null;
  const manageNode = scope?.querySelector("#manage-content-priority") || null;
  const refreshNode = scope?.querySelector("#refresh-production-command") || null;
  const mounted = Boolean(scope && stateNode && summaryNode && listNode && feedbackNode && copyNode && manageNode);
  let destroyed = false;
  let busy = false;
  let refreshing = false;
  let refreshOperation = 0;
  let actionOperation = 0;
  let lastBoard = null;
  let visibleCommands = [];

  function setViewState(kind, state, summary) {
    if (!mounted || destroyed) return;
    stateNode.dataset.commandState = kind;
    setText(stateNode, state);
    setText(summaryNode, summary);
  }

  function disableActions(disabled) {
    for (const button of listNode?.querySelectorAll?.("[data-command-kind]") || []) button.disabled = disabled || refreshing;
    if (copyNode) copyNode.disabled = disabled || refreshing || !lastBoard?.commands?.length;
    if (manageNode) manageNode.disabled = disabled || refreshing;
    if (refreshNode) refreshNode.disabled = disabled || refreshing;
  }

  function showLoading() {
    if (!mounted || destroyed) return;
    lastBoard = null;
    visibleCommands = [];
    boardNode?.setAttribute?.("aria-busy", "true");
    setViewState("loading", "正在读取今日生产指令…", "仅读取浏览器本地已保存的人工排期与今日项目快照。");
    listNode.replaceChildren();
    setText(feedbackNode, "");
    disableActions(busy);
  }

  function renderBoard(board) {
    if (!mounted || destroyed) return null;
    if (!board || !Array.isArray(board.commands)) throw new Error("今日生产指令格式无效");
    lastBoard = board;
    boardNode?.setAttribute?.("aria-busy", "false");
    visibleCommands = board.commands.slice(0, MAX_VISIBLE_COMMANDS);
    listNode.replaceChildren();
    if (!visibleCommands.length) {
      setViewState("empty", "今日暂无待执行项目", summaryText(board, 0));
      disableActions(busy);
      return board;
    }
    const currentProjectId = String(currentProjectReader() || "");
    visibleCommands.forEach((command, index) => listNode.append(commandCard(scope, command, index, currentProjectId)));
    const total = Number.isInteger(board.total) && board.total >= 0 ? board.total : board.commands.length;
    setViewState("ready", `今日生产指令 ${Math.min(total, visibleCommands.length)}/${total}`, summaryText(board, visibleCommands.length));
    disableActions(busy);
    return board;
  }

  async function refresh(snapshot) {
    if (!mounted || destroyed) return null;
    if (busy) return lastBoard;
    const currentOperation = ++refreshOperation;
    refreshing = true;
    showLoading();
    try {
      const source = arguments.length > 0 ? snapshot : await snapshotLoader();
      if (currentOperation !== refreshOperation || destroyed) return null;
      const board = await boardBuilder(source, {
        currentProjectId: String(currentProjectReader() || ""),
        today: String(todayReader() || localToday())
      });
      if (currentOperation !== refreshOperation || destroyed) return null;
      return renderBoard(board);
    } catch (error) {
      if (currentOperation !== refreshOperation || destroyed) return null;
      lastBoard = null;
      visibleCommands = [];
      boardNode?.setAttribute?.("aria-busy", "false");
      setViewState("error", "今日生产指令暂不可用", error?.message || "无法读取本地跨项目快照。");
      listNode.replaceChildren();
      disableActions(busy);
      return null;
    } finally {
      if (currentOperation === refreshOperation && !destroyed) {
        refreshing = false;
        disableActions(busy);
      }
    }
  }

  async function handleCommand(event) {
    const button = event?.target?.closest?.("[data-command-kind]");
    if (!button || busy || destroyed) return;
    const index = Number(button.dataset.commandIndex);
    const command = Number.isInteger(index) ? visibleCommands[index] : null;
    if (
      !command
      || String(command.projectId || "") !== String(button.dataset.commandProjectId || "")
      || String(command.id || "") !== String(button.dataset.commandId || "")
      || commandAction(command) !== String(button.dataset.commandAction || "")
      || commandTestId(command) !== String(button.dataset.commandTestId || "")
    ) return;
    busy = true;
    const currentOperation = ++actionOperation;
    disableActions(true);
    setText(feedbackNode, "");
    try {
      let completed = true;
      if (button.dataset.commandKind === "current") {
        completed = await executeCurrent(command);
      } else if (button.dataset.commandKind === "switch") {
        completed = await openProject(String(command.projectId), command);
      }
      if (currentOperation === actionOperation && !destroyed) {
        if (completed === false) {
          setText(feedbackNode, button.dataset.commandKind === "current"
            ? "操作已取消，未改变项目状态。"
            : "已取消切换，当前项目未变化。");
        } else {
          const defaultFeedback = button.dataset.commandKind === "current"
            ? `已定位：${command.actionLabel || "下一步"}；是否完成仍以人工保存状态为准。`
            : `已切换到“${command.name || command.projectId}”。`;
          setText(feedbackNode, typeof completed === "string" && completed.trim() ? completed.trim() : defaultFeedback);
        }
      }
    } catch (error) {
      if (currentOperation === actionOperation && !destroyed) {
        setText(feedbackNode, error?.message || "指令执行失败，当前项目保持不变。");
      }
    } finally {
      if (currentOperation === actionOperation && !destroyed) {
        busy = false;
        disableActions(false);
      }
    }
  }

  async function handleManage() {
    if (busy || destroyed) return;
    busy = true;
    const currentOperation = ++actionOperation;
    disableActions(true);
    try {
      await openPriority();
    } catch (error) {
      if (currentOperation === actionOperation && !destroyed) {
        setText(feedbackNode, error?.message || "暂时无法打开内容排期。");
      }
    } finally {
      if (currentOperation === actionOperation && !destroyed) {
        busy = false;
        disableActions(false);
      }
    }
  }

  async function handleCopyBrief() {
    if (busy || refreshing || destroyed || !lastBoard?.commands?.length) return;
    const board = lastBoard;
    busy = true;
    const currentOperation = ++actionOperation;
    disableActions(true);
    setText(feedbackNode, "");
    try {
      await copyCurrentBrief(board);
      if (currentOperation === actionOperation && !destroyed && board === lastBoard) {
        setText(feedbackNode, `已复制今日素材生产排产单，共 ${Math.min(MAX_VISIBLE_COMMANDS, board.commands.length)} 个项目；请由内容负责人确认实际人员安排。`);
      }
    } catch (error) {
      if (currentOperation === actionOperation && !destroyed) {
        setText(feedbackNode, error?.message || "今日排产单复制失败，请重试。");
      }
    } finally {
      if (currentOperation === actionOperation && !destroyed) {
        busy = false;
        disableActions(false);
      }
    }
  }

  const commandListener = (event) => handleCommand(event);
  const manageListener = () => handleManage();
  const copyListener = () => handleCopyBrief();
  const refreshListener = () => {
    if (!busy && !refreshing && !destroyed) return refresh();
    return undefined;
  };
  listNode?.addEventListener?.("click", commandListener);
  manageNode?.addEventListener?.("click", manageListener);
  copyNode?.addEventListener?.("click", copyListener);
  refreshNode?.addEventListener?.("click", refreshListener);
  if (mounted) showLoading();

  return {
    mounted,
    refresh,
    get board() {
      return lastBoard;
    },
    destroy() {
      destroyed = true;
      refreshOperation += 1;
      actionOperation += 1;
      listNode?.removeEventListener?.("click", commandListener);
      manageNode?.removeEventListener?.("click", manageListener);
      copyNode?.removeEventListener?.("click", copyListener);
      refreshNode?.removeEventListener?.("click", refreshListener);
    }
  };
}
