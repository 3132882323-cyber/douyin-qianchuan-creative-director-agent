import { assessPlanShootReadiness, planToRunSheet } from "./core.js";

function safeRoot(root) {
  return root && typeof root.querySelector === "function" ? root : null;
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

function validIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

export function mountDirectorItemRunSheetTools({
  root,
  getPlan,
  getPlanStale,
  getRevision,
  beginOperation,
  isOperationCurrent,
  writeText,
  onFeedback
} = {}) {
  const scope = safeRoot(root);
  const listNode = scope?.querySelector("#plan-list") || null;
  const feedbackNode = scope?.querySelector("#copy-state") || null;
  const planReader = typeof getPlan === "function" ? getPlan : () => null;
  const staleReader = typeof getPlanStale === "function" ? getPlanStale : () => true;
  const revisionReader = typeof getRevision === "function" ? getRevision : () => 0;
  const externalOperationGuarded = typeof beginOperation === "function" && typeof isOperationCurrent === "function";
  const clipboardWriter = typeof writeText === "function" ? writeText : async () => { throw new Error("剪贴板当前不可用"); };
  const feedbackWriter = typeof onFeedback === "function" ? onFeedback : (message) => setText(feedbackNode, message);
  const listeners = new Map();
  let copySequence = 0;
  const mounted = Boolean(scope && listNode && feedbackNode && typeof listNode.querySelectorAll === "function");

  function actionNodes() {
    return mounted ? Array.from(listNode.querySelectorAll(".director-item-run-sheet-action")) : [];
  }

  function statusNode(index) {
    return index >= 0 ? scope?.querySelector(`#director-item-run-sheet-state-${index}`) || null : null;
  }

  function syncExecutionSummary(index, plan) {
    const item = plan?.items?.[index];
    if (!item) return;
    setText(
      scope?.querySelector(`#director-execution-variable-value-${index}`),
      `${item.singleVariable || "唯一变量待补"} → ${item.variant || "变量值待补"}`
    );
    setText(
      scope?.querySelector(`#director-execution-locks-${index}`),
      `其余锁定：${item.fixedElements || "固定项待补"}`
    );
  }

  function assessmentMatches(candidate, plan) {
    return Boolean(
      candidate
      && candidate.total === plan.items.length
      && Array.isArray(candidate.items)
      && candidate.items.length === plan.items.length
      && candidate.items.every((item, index) => item?.index === index && typeof item.ready === "boolean" && Array.isArray(item.missing))
    );
  }

  function readSnapshot(assessmentOverride) {
    try {
      const plan = planReader();
      const stale = staleReader();
      const assessment = plan?.items?.length && !stale
        ? assessmentMatches(assessmentOverride, plan) ? assessmentOverride : assessPlanShootReadiness(plan)
        : null;
      return { plan, stale, assessment };
    } catch (error) {
      return { plan: null, stale: true, assessment: null, error };
    }
  }

  function inspect(index, snapshot = readSnapshot()) {
    if (!mounted) return { code: "unavailable" };
    try {
      if (snapshot.error) return { code: "unavailable", error: snapshot.error };
      const { plan, stale, assessment: readiness } = snapshot;
      if (!plan?.items?.length) return { code: "waiting" };
      if (stale) return { code: "stale" };
      if (index < 0 || index >= plan.items.length) return { code: "invalid" };
      const item = readiness.items[index];
      if (!item || item.index !== index) return { code: "invalid" };
      return item.ready
        ? { code: "ready", plan, item }
        : { code: "blocked", plan, item };
    } catch (error) {
      return { code: "unavailable", error };
    }
  }

  function feedbackFor(state) {
    if (state.code === "waiting") return "请先生成当前方案，再复制本条开拍单。";
    if (state.code === "stale") return "当前方案已过期，请重新生成后再复制本条开拍单。";
    if (state.code === "invalid") return "当前任务序号无效，请重新生成方案后再复制。";
    if (state.code === "blocked") return `请先补齐 ${state.item.id}：${state.item.missing.join("、")}。`;
    return state.error?.message || "当前方案无法生成本条开拍单。";
  }

  function operationStillCurrent(operation, revision, externalToken) {
    if (operation !== copySequence) return false;
    try {
      if (revisionReader() !== revision || staleReader()) return false;
      return !externalOperationGuarded || isOperationCurrent(externalToken);
    } catch {
      return false;
    }
  }

  async function copy(index) {
    const operation = ++copySequence;
    const state = inspect(index);
    if (state.code !== "ready") {
      feedbackWriter(feedbackFor(state));
      render();
      return false;
    }

    let revision;
    let externalToken = null;
    try {
      revision = revisionReader();
      externalToken = externalOperationGuarded ? beginOperation() : null;
      const content = planToRunSheet(state.plan, { itemIndex: index });
      await clipboardWriter(content);
      if (!operationStillCurrent(operation, revision, externalToken)) return false;
      feedbackWriter(`已复制 ${state.item.id} 的单条开拍单；开机前请再次核对本条唯一变量与固定项。`);
      return true;
    } catch (error) {
      if (revision !== undefined && !operationStillCurrent(operation, revision, externalToken)) return false;
      if (operation !== copySequence) return false;
      feedbackWriter(error?.message || "本条开拍单复制失败，请稍后重试。");
      return false;
    }
  }

  function syncListeners(buttons) {
    const active = new Set(buttons);
    for (const [button, listener] of listeners) {
      if (active.has(button)) continue;
      button.removeEventListener?.("click", listener);
      listeners.delete(button);
    }
    for (const button of buttons) {
      if (listeners.has(button)) continue;
      const listener = () => copy(validIndex(button.dataset?.index));
      button.addEventListener?.("click", listener);
      listeners.set(button, listener);
    }
  }

  function render(assessment) {
    if (!mounted) return [];
    const buttons = actionNodes();
    syncListeners(buttons);
    const snapshot = readSnapshot(assessment);
    return buttons.map((button) => {
      const index = validIndex(button.dataset?.index);
      const status = statusNode(index);
      const state = inspect(index, snapshot);
      const ready = state.code === "ready";
      if (state.plan) syncExecutionSummary(index, state.plan);
      button.disabled = !ready;
      button.dataset.ready = String(ready);
      if (status) status.dataset.ready = String(ready);

      if (state.code === "ready") {
        setText(button, "复制本条开拍单");
        setText(status, `可复制 · ${state.item.id} 现场字段已齐`);
      } else if (state.code === "blocked") {
        setText(button, `开拍单待补 ${state.item.missing.length} 项`);
        setText(status, `待补：${state.item.missing.join("、")}`);
      } else if (state.code === "stale") {
        setText(button, "开拍单需重新生成");
        setText(status, "方案已过期，请重新生成后再复制。");
      } else if (state.code === "waiting") {
        setText(button, "开拍单暂不可用");
        setText(status, "等待生成当前方案。");
      } else if (state.code === "invalid") {
        setText(button, "开拍单暂不可用");
        setText(status, "当前任务序号无效，请重新生成方案。");
      } else {
        setText(button, "开拍单暂不可用");
        setText(status, state.error?.message || "当前方案无法生成本条开拍单。");
      }
      return state;
    });
  }

  return {
    mounted,
    render,
    destroy() {
      copySequence += 1;
      for (const [button, listener] of listeners) button.removeEventListener?.("click", listener);
      listeners.clear();
    }
  };
}
