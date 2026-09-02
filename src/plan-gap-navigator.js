import { PLAN_EDITOR_FIELD_PATHS } from "./plan-editor-ui.js";

const ALLOWED_PATHS = new Set(PLAN_EDITOR_FIELD_PATHS);
const MAX_PLAN_ITEMS = 100;

function safeRoot(root) {
  return root && typeof root.querySelector === "function" ? root : null;
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

function setAttribute(node, name, value) {
  const text = String(value ?? "");
  if (node?.getAttribute?.(name) === text) return;
  node?.setAttribute?.(name, text);
}

function safeIndex(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return Number.isInteger(fallback) && fallback >= 0 && fallback < MAX_PLAN_ITEMS ? fallback : -1;
  }
  const index = Number(value);
  if (Number.isInteger(index) && index >= 0 && index < MAX_PLAN_ITEMS) return index;
  return -1;
}

function safeField(value) {
  const path = String(value?.path || "");
  if (!ALLOWED_PATHS.has(path)) return null;
  const label = String(value?.label || path).trim().slice(0, 120) || path;
  return { path, label };
}

export function firstPlanGap(assessment) {
  if (!assessment || assessment.ready === true || !Array.isArray(assessment.items)) return null;
  for (let position = 0; position < assessment.items.length; position += 1) {
    const item = assessment.items[position];
    const index = safeIndex(item?.index, position);
    if (index < 0 || !Array.isArray(item?.missingFields)) continue;
    for (const candidate of item.missingFields) {
      const field = safeField(candidate);
      if (!field) continue;
      return {
        index,
        path: field.path,
        label: field.label,
        id: String(item?.id || `任务 ${index + 1}`).trim().slice(0, 160) || `任务 ${index + 1}`
      };
    }
  }
  return null;
}

function defaultReveal(target, onUnavailable) {
  if (target?.isConnected === false) {
    onUnavailable?.();
    return false;
  }
  target.focus?.();
  target.scrollIntoView?.({ block: "center", inline: "nearest" });
  return true;
}

export function mountPlanGapNavigator({
  root,
  getAssessment,
  getPlanStale,
  revealTarget,
  onFeedback
} = {}) {
  const scope = safeRoot(root);
  const button = scope?.querySelector("#focus-plan-gap") || null;
  const list = scope?.querySelector("#plan-list") || null;
  const assessmentReader = typeof getAssessment === "function" ? getAssessment : () => null;
  const staleReader = typeof getPlanStale === "function" ? getPlanStale : () => false;
  const reveal = typeof revealTarget === "function" ? revealTarget : defaultReveal;
  const feedbackWriter = typeof onFeedback === "function" ? onFeedback : () => {};
  const mounted = Boolean(button && list && typeof button.addEventListener === "function" && typeof list.querySelectorAll === "function");
  let destroyed = false;

  function readView(assessmentOverride) {
    if (destroyed) return { code: "destroyed", gap: null };
    try {
      if (staleReader()) return { code: "stale", gap: null };
      const assessment = assessmentOverride === undefined ? assessmentReader() : assessmentOverride;
      if (!assessment || !Array.isArray(assessment.items) || !assessment.items.length) return { code: "waiting", gap: null };
      if (assessment.ready === true) return { code: "complete", gap: null };
      const gap = firstPlanGap(assessment);
      return gap ? { code: "missing", gap } : { code: "unavailable", gap: null };
    } catch {
      return { code: "unavailable", gap: null };
    }
  }

  function syncButton(view = readView()) {
    if (!button) return view;
    button.dataset.state = view.code;
    button.disabled = view.code !== "missing";
    button.hidden = view.code === "waiting" || view.code === "destroyed";
    if (view.code === "missing") {
      setText(button, `定位下一个缺项 · ${view.gap.id} · ${view.gap.label}`);
      setAttribute(button, "aria-label", `定位到 ${view.gap.id} 的${view.gap.label}`);
    } else if (view.code === "complete") {
      setText(button, "开拍项已齐");
      setAttribute(button, "aria-label", "全部开拍字段已齐全");
    } else if (view.code === "stale") {
      setText(button, "方案需重新生成");
      setAttribute(button, "aria-label", "当前方案已过期，需要重新生成");
    } else if (view.code === "unavailable") {
      setText(button, "缺项暂无法定位");
      setAttribute(button, "aria-label", "当前缺项无法定位，请人工检查方案字段");
    } else {
      setText(button, "等待方案");
      setAttribute(button, "aria-label", "等待生成方案");
    }
    return view;
  }

  function findTarget(gap) {
    const fields = Array.from(list?.querySelectorAll?.("[data-index][data-path]") || []);
    return fields.find((node) => Number(node?.dataset?.index) === gap.index && String(node?.dataset?.path || "") === gap.path) || null;
  }

  function navigate() {
    const view = syncButton(readView());
    if (!mounted || view.code !== "missing" || !view.gap) return false;
    const target = findTarget(view.gap);
    if (!target) {
      feedbackWriter(`${view.gap.id} 的${view.gap.label}暂时无法定位，请重新打开方案卡后重试。`);
      return false;
    }
    try {
      const card = target.closest?.("details");
      if (card) card.open = true;
      let revealFailed = false;
      const reportRevealFailure = () => {
        if (revealFailed) return;
        revealFailed = true;
        feedbackWriter(`${view.gap.id} 的${view.gap.label}定位失败，方案卡可能已经刷新；请重试。`);
      };
      const revealed = reveal(target, reportRevealFailure);
      if (revealed === false) reportRevealFailure();
      return !revealFailed;
    } catch {
      feedbackWriter(`${view.gap.id} 的${view.gap.label}定位失败，请人工展开对应方案。`);
      return false;
    }
  }

  const clickListener = () => navigate();
  if (mounted) button.addEventListener("click", clickListener);
  syncButton();

  return {
    mounted,
    render(assessment) {
      return syncButton(readView(assessment));
    },
    navigate,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (mounted) button.removeEventListener?.("click", clickListener);
      syncButton({ code: "destroyed", gap: null });
    }
  };
}
