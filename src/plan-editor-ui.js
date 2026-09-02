export const PLAN_EDITOR_FIELD_PATHS = Object.freeze([
  "hypothesis",
  "baselineCreative",
  "variant",
  "audience",
  "hook",
  "coreClaim",
  "sellingPoint",
  "scene",
  "fixedElements",
  "observationMetrics",
  "minSpend",
  "stopCondition",
  "successAction",
  "production.spokenScript",
  "production.storyboard",
  "production.shootingTask",
  "production.editingNotes",
  "production.subtitleHighlights",
  "production.complianceChecklist"
]);

const ALLOWED_PATHS = new Set(PLAN_EDITOR_FIELD_PATHS);

function safeRoot(root) {
  return root && typeof root.querySelector === "function" ? root : null;
}

function editableTarget(event) {
  const target = event?.target;
  const tagName = String(target?.tagName || "").toUpperCase();
  if (tagName !== "INPUT" && tagName !== "TEXTAREA") return null;
  const index = Number(target.dataset?.index);
  const path = String(target.dataset?.path || "");
  if (!Number.isInteger(index) || index < 0 || index > 99 || !ALLOWED_PATHS.has(path)) return null;
  return { target, index, path, value: target.value ?? "" };
}

export function mountPlanEditor({ root, getItemCount, onEdit, onError } = {}) {
  const scope = safeRoot(root);
  const listNode = scope?.querySelector("#plan-list") || null;
  const itemCountReader = typeof getItemCount === "function" ? getItemCount : () => 100;
  const editWriter = typeof onEdit === "function" ? onEdit : null;
  const errorWriter = typeof onError === "function" ? onError : () => {};
  const mounted = Boolean(listNode && editWriter && typeof listNode.addEventListener === "function");
  const composingTargets = new WeakSet();
  const compositionStartValues = new WeakMap();
  const completedCompositionValues = new WeakMap();

  function writeEdit(event, writer) {
    const edit = editableTarget(event);
    if (!edit || typeof writer !== "function") return false;
    try {
      const itemCount = Number(itemCountReader());
      if (!Number.isInteger(itemCount) || itemCount < 0 || itemCount > 100 || edit.index >= itemCount) return false;
      writer({ index: edit.index, path: edit.path, value: edit.value, node: edit.target });
      return true;
    } catch (error) {
      errorWriter(error instanceof Error ? error : new Error(String(error || "方案字段编辑失败")));
      return false;
    }
  }

  function handleCompositionStart(event) {
    const edit = editableTarget(event);
    if (!edit) return;
    composingTargets.add(edit.target);
    compositionStartValues.set(edit.target, edit.value);
    completedCompositionValues.delete(edit.target);
  }

  function handleCompositionEnd(event) {
    const edit = editableTarget(event);
    if (!edit || !composingTargets.has(edit.target)) return;
    composingTargets.delete(edit.target);
    const startValue = compositionStartValues.get(edit.target);
    compositionStartValues.delete(edit.target);
    completedCompositionValues.set(edit.target, edit.value);
    if (startValue === edit.value) return;
    writeEdit(event, editWriter);
  }

  function handleInput(event) {
    const edit = editableTarget(event);
    if (!edit) return;
    if (event?.isComposing === true) {
      composingTargets.add(edit.target);
      return;
    }
    if (composingTargets.has(edit.target)) {
      if (event?.isComposing === undefined) {
        return;
      }
      composingTargets.delete(edit.target);
      compositionStartValues.delete(edit.target);
      completedCompositionValues.set(edit.target, edit.value);
      writeEdit(event, editWriter);
      return;
    }
    if (completedCompositionValues.get(edit.target) === edit.value) {
      completedCompositionValues.delete(edit.target);
      return;
    }
    completedCompositionValues.delete(edit.target);
    writeEdit(event, editWriter);
  }

  if (mounted) {
    listNode.addEventListener("compositionstart", handleCompositionStart);
    listNode.addEventListener("compositionend", handleCompositionEnd);
    listNode.addEventListener("input", handleInput);
  }

  return {
    mounted,
    destroy() {
      if (!mounted) return;
      listNode.removeEventListener?.("compositionstart", handleCompositionStart);
      listNode.removeEventListener?.("compositionend", handleCompositionEnd);
      listNode.removeEventListener?.("input", handleInput);
    }
  };
}
