import { buildDirectorMonitorCard, directorMonitorCardToText } from "./director-monitor-card.js";
import { buildDirectorTakeReview, directorTakeReviewToText } from "./director-take-review.js";

const TOOL_DEFINITIONS = Object.freeze({
  monitor: Object.freeze({
    selector: ".director-monitor-action",
    statePrefix: "director-monitor-state",
    label: "复制前三秒监看卡",
    shortLabel: "监看卡",
    build: (plan, index) => buildDirectorMonitorCard(plan, { itemIndex: index }),
    format: directorMonitorCardToText,
    waiting: "请先生成当前方案，再复制前三秒监看卡。",
    stale: "当前方案已过期，请重新生成后再复制前三秒监看卡。",
    success: (model) => `已复制 ${model.id} 的前三秒现场监看卡；开机前请核对首帧、真人语速和证据承接。`,
    readyStatus: (model) => model.warnings.length
      ? `可复制 · ${model.warnings.length} 项开机前提醒`
      : "可复制 · 首帧、口播、字幕与证据字段已齐"
  }),
  takeReview: Object.freeze({
    selector: ".director-take-review-action",
    statePrefix: "director-take-review-state",
    label: "复制拍后快检卡",
    shortLabel: "快检卡",
    build: (plan, index) => buildDirectorTakeReview(plan, { itemIndex: index }),
    format: directorTakeReviewToText,
    waiting: "请先生成当前方案，再复制拍后快检卡。",
    stale: "当前方案已过期，请重新生成后再复制拍后快检卡。",
    success: (model) => `已复制 ${model.id} 的拍后快检卡；每个 Take 拍完立即五查并人工三选一。`,
    readyStatus: (model) => model.warnings.length
      ? `可复制 · 五项人工快检，另有 ${model.warnings.length} 项提醒`
      : "可复制 · 拍完填写文件与 Take，再完成五查三选一"
  })
});

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

export function mountDirectorMonitorTools({ root, getPlan, getPlanStale, getRevision, beginOperation, isOperationCurrent, writeText, onFeedback } = {}) {
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

  function actionEntries() {
    if (!mounted) return [];
    return Object.entries(TOOL_DEFINITIONS).flatMap(([kind, definition]) => (
      Array.from(listNode.querySelectorAll(definition.selector)).map((button) => ({ button, kind, definition }))
    ));
  }

  function statusNode(definition, index) {
    return index >= 0 ? scope?.querySelector(`#${definition.statePrefix}-${index}`) || null : null;
  }

  function readPlanState() {
    try {
      return { plan: planReader(), stale: Boolean(staleReader()), error: null };
    } catch (error) {
      return { plan: null, stale: true, error };
    }
  }

  function operationStillCurrent(operation, revision, externalToken) {
    if (operation !== copySequence) return false;
    try {
      if (revisionReader() !== revision || staleReader()) return false;
      return !externalOperationGuarded || externalToken === null || isOperationCurrent(externalToken);
    } catch {
      return false;
    }
  }

  async function copy(index, kind) {
    const operation = ++copySequence;
    const definition = TOOL_DEFINITIONS[kind];
    if (!definition || !mounted) return false;
    const snapshot = readPlanState();
    if (snapshot.error) {
      feedbackWriter(snapshot.error?.message || "当前方案状态无法读取，请重新打开侧边栏后重试。");
      render();
      return false;
    }
    const { plan } = snapshot;
    if (!plan?.items?.length) {
      feedbackWriter(definition.waiting);
      render();
      return false;
    }
    if (snapshot.stale) {
      feedbackWriter(definition.stale);
      render();
      return false;
    }
    let revision;
    let externalToken = null;
    try {
      revision = revisionReader();
      const model = definition.build(plan, index);
      const content = definition.format(model);
      externalToken = externalOperationGuarded ? beginOperation() : null;
      await clipboardWriter(content);
      if (!operationStillCurrent(operation, revision, externalToken)) return false;
      feedbackWriter(definition.success(model));
      return true;
    } catch (error) {
      if (operation !== copySequence) return false;
      if (revision !== undefined && !operationStillCurrent(operation, revision, externalToken)) return false;
      feedbackWriter(error?.message || `${definition.shortLabel}复制失败，请补齐现场字段后重试。`);
      return false;
    }
  }

  function syncListeners(entries) {
    const active = new Set(entries.map(({ button }) => button));
    for (const [button, binding] of listeners) {
      if (active.has(button)) continue;
      button.removeEventListener?.("click", binding.listener);
      listeners.delete(button);
    }
    for (const { button, kind } of entries) {
      const current = listeners.get(button);
      if (current?.kind === kind) continue;
      if (current) button.removeEventListener?.("click", current.listener);
      const listener = () => copy(validIndex(button.dataset?.index), kind);
      button.addEventListener?.("click", listener);
      listeners.set(button, { kind, listener });
    }
  }

  function render() {
    if (!mounted) return [];
    const entries = actionEntries();
    syncListeners(entries);
    const snapshot = readPlanState();
    const { plan, stale } = snapshot;
    return entries.map(({ button, definition, kind }) => {
      const index = validIndex(button.dataset?.index);
      const status = statusNode(definition, index);
      if (snapshot.error) {
        button.disabled = true;
        button.dataset.ready = "false";
        setText(button, `${definition.shortLabel}暂不可用`);
        setText(status, snapshot.error?.message || "当前方案状态无法读取，请重新打开侧边栏后重试。");
        return { kind, model: null };
      }
      if (!plan?.items?.length) {
        button.disabled = true;
        button.dataset.ready = "false";
        setText(button, `${definition.shortLabel}暂不可用`);
        setText(status, "等待生成当前方案。");
        return { kind, model: null };
      }
      if (stale) {
        button.disabled = true;
        button.dataset.ready = "false";
        setText(button, `${definition.shortLabel}需重新生成`);
        setText(status, "方案已过期，请重新生成后再复制。");
        return { kind, model: null };
      }
      try {
        const model = definition.build(plan, index);
        button.disabled = !model.copyable;
        button.dataset.ready = String(model.copyable);
        setText(button, model.copyable ? definition.label : `${definition.shortLabel}待补 ${model.missing.length} 项`);
        if (status) {
          status.dataset.ready = String(model.copyable);
          setText(status, model.copyable ? definition.readyStatus(model) : `待补：${model.missing.join("、")}`);
        }
        return { kind, model };
      } catch (error) {
        button.disabled = true;
        button.dataset.ready = "false";
        setText(button, `${definition.shortLabel}暂不可用`);
        setText(status, error?.message || `当前方案无法生成${definition.shortLabel}。`);
        return { kind, model: null };
      }
    });
  }

  return {
    mounted,
    render,
    destroy() {
      copySequence += 1;
      for (const [button, binding] of listeners) button.removeEventListener?.("click", binding.listener);
      listeners.clear();
    }
  };
}
