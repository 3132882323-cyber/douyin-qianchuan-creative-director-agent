import {
  buildDirectorBlindReview,
  directorBlindReviewDecisionSheetToText,
  directorBlindReviewKeyToText,
  directorBlindReviewPackToText
} from "./director-blind-review.js";

const CONTROL_DEFINITIONS = Object.freeze([
  { id: "copy-director-blind-review", kind: "pack" },
  { id: "copy-director-blind-review-key", kind: "key" },
  { id: "copy-director-blind-review-decision", kind: "decision" }
]);

function safeRoot(root) {
  return root && typeof root.querySelector === "function" ? root : null;
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

export function mountDirectorBlindReview({ root, getPlan, getPlanStale, getRevision, writeText } = {}) {
  const scope = safeRoot(root);
  const planReader = typeof getPlan === "function" ? getPlan : () => null;
  const staleReader = typeof getPlanStale === "function" ? getPlanStale : () => true;
  const revisionReader = typeof getRevision === "function" ? getRevision : () => 0;
  const clipboardWriter = typeof writeText === "function" ? writeText : async () => { throw new Error("剪贴板当前不可用"); };
  const stateNode = scope?.querySelector("#director-blind-review-state") || null;
  const summaryNode = scope?.querySelector("#director-blind-review-summary") || null;
  const feedbackNode = scope?.querySelector("#director-blind-review-feedback") || null;
  const controls = CONTROL_DEFINITIONS.map((definition) => ({
    ...definition,
    node: scope?.querySelector(`#${definition.id}`) || null
  }));
  const mounted = Boolean(scope && stateNode && summaryNode && feedbackNode && controls.every((control) => control.node));
  let copySequence = 0;

  function disableAll(disabled) {
    for (const control of controls) if (control.node) control.node.disabled = disabled;
  }

  function render() {
    if (!mounted) return null;
    const plan = planReader();
    if (!plan?.items?.length) {
      disableAll(true);
      setText(stateNode, "等待方案");
      setText(summaryNode, "至少需要两条字段完整的同批方案。");
      return null;
    }
    if (staleReader()) {
      disableAll(true);
      setText(stateNode, "方案已过期");
      setText(summaryNode, "当前上下文已经变化，请重新生成方案后再发起盲审。");
      return null;
    }
    try {
      const review = buildDirectorBlindReview(plan);
      const ready = review.copyable === true;
      disableAll(!ready);
      setText(stateNode, ready ? `${review.cards.length} 条 · 已匿名打乱` : `待补 ${review.blockers.length} 项`);
      setText(summaryNode, ready
        ? `${review.reviewId} · 按 1 盲审、2 揭晓、3 合议顺序使用；编辑方案后编号会变化。`
        : `盲审包暂不可用：${review.blockers.slice(0, 3).join("；")}${review.blockers.length > 3 ? `；另有 ${review.blockers.length - 3} 项` : ""}`);
      return review;
    } catch (error) {
      disableAll(true);
      setText(stateNode, "暂不可用");
      setText(summaryNode, error.message || "当前方案无法安全生成盲审包。");
      return null;
    }
  }

  async function copy(kind) {
    const operation = ++copySequence;
    const revision = revisionReader();
    const plan = planReader();
    if (!mounted || !plan?.items?.length || staleReader()) return;
    try {
      const review = buildDirectorBlindReview(plan);
      if (kind === "pack") {
        await clipboardWriter(directorBlindReviewPackToText(review));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制匿名盲审包 ${review.reviewId}；请先收齐并锁定反馈，再揭示导演映射。`);
      } else if (kind === "key") {
        await clipboardWriter(directorBlindReviewKeyToText(review));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制导演映射 ${review.reviewId}；请勿发给评审者，并确认编号与盲审包一致。`);
      } else if (kind === "decision") {
        await clipboardWriter(directorBlindReviewDecisionSheetToText(review));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制导演合议单 ${review.reviewId}；请先填回收事实，再在保留、单变量重写和淘汰中三选一。`);
      }
      return true;
    } catch (error) {
      if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
      const labels = { pack: "匿名盲审包", key: "导演映射", decision: "导演合议单" };
      setText(feedbackNode, error.message || `${labels[kind] || "拍前盲审资料"}复制失败，请检查方案字段与剪贴板权限。`);
      return false;
    }
  }

  const listeners = controls.map((control) => {
    const listener = () => copy(control.kind);
    control.node?.addEventListener("click", listener);
    return { node: control.node, listener };
  });

  return {
    mounted,
    render,
    destroy() {
      copySequence += 1;
      for (const { node, listener } of listeners) node?.removeEventListener("click", listener);
    }
  };
}
