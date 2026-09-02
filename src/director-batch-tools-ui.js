import {
  buildDirectorBatchBoard,
  directorBatchBoardToText,
  directorBatchCutReviewToText,
  directorBatchEditAssemblyToText
} from "./director-batch-board.js";
import { buildDirectorTakeHandoff, directorTakeHandoffToText } from "./director-take-handoff.js";

const CONTROL_DEFINITIONS = Object.freeze([
  { id: "copy-director-batch-board", kind: "shoot" },
  { id: "copy-director-take-handoff", kind: "take" },
  { id: "copy-director-edit-assembly", kind: "edit" },
  { id: "copy-director-cut-review", kind: "review" }
]);

function safeRoot(root) {
  return root && typeof root.querySelector === "function" ? root : null;
}

function setText(node, value) {
  const text = String(value ?? "");
  if (node && node.textContent !== text) node.textContent = text;
}

export function mountDirectorBatchTools({ root, getPlan, getPlanStale, getRevision, writeText } = {}) {
  const scope = safeRoot(root);
  const planReader = typeof getPlan === "function" ? getPlan : () => null;
  const staleReader = typeof getPlanStale === "function" ? getPlanStale : () => true;
  const revisionReader = typeof getRevision === "function" ? getRevision : () => 0;
  const clipboardWriter = typeof writeText === "function" ? writeText : async () => { throw new Error("剪贴板当前不可用"); };
  const stateNode = scope?.querySelector("#director-batch-board-state") || null;
  const summaryNode = scope?.querySelector("#director-batch-board-summary") || null;
  const feedbackNode = scope?.querySelector("#director-batch-board-feedback") || null;
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
      setText(summaryNode, "至少需要两条字段完整、变量唯一且固定项一致的同批方案。");
      return null;
    }
    if (staleReader()) {
      disableAll(true);
      setText(stateNode, "方案已过期");
      setText(summaryNode, "当前上下文已经变化，请重新生成方案后再编排批次生产资料。");
      return null;
    }
    try {
      const board = buildDirectorBatchBoard(plan);
      const ready = board.copyable === true;
      disableAll(!ready);
      setText(stateNode, ready ? `${board.total} 条 · 只改${board.variableLabel}` : `待修正 ${board.blockers.length} 项`);
      setText(summaryNode, ready
        ? `按 1 拍摄、2 接片、3 剪辑、4 验收顺序使用；B00 锁定后再处理 ${Math.max(0, board.entries.length - 1)} 条变体。`
        : `批次生产资料暂不可用：${board.blockers.slice(0, 3).join("；")}${board.blockers.length > 3 ? `；另有 ${board.blockers.length - 3} 项` : ""}`);
      return board;
    } catch (error) {
      disableAll(true);
      setText(stateNode, "暂不可用");
      setText(summaryNode, error.message || "当前方案无法安全生成批次生产资料。");
      return null;
    }
  }

  async function copy(kind) {
    const operation = ++copySequence;
    const revision = revisionReader();
    const plan = planReader();
    if (!mounted || !plan?.items?.length || staleReader()) return;
    try {
      const board = buildDirectorBatchBoard(plan);
      if (kind === "shoot") {
        await clipboardWriter(directorBatchBoardToText(board));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制 ${board.batchId} 的批次拍摄镜头板；请先锁定 B00，再按场记编号拍 ${Math.max(0, board.entries.length - 1)} 条变量插条。`);
      } else if (kind === "take") {
        const handoff = buildDirectorTakeHandoff(plan);
        await clipboardWriter(directorTakeHandoffToText(handoff));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制 ${handoff.batchId} 的收工接片单；撤场前请逐条填写实际文件与首选 Take，并明确齐全可交剪或必须补拍。`);
      } else if (kind === "edit") {
        await clipboardWriter(directorBatchEditAssemblyToText(board));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制 ${board.batchId} 的批次剪辑装配单；请先锁定 B00 时间轴，再逐个替换 ${Math.max(0, board.entries.length - 1)} 条变体的专属素材。`);
      } else if (kind === "review") {
        await clipboardWriter(directorBatchCutReviewToText(board));
        if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
        setText(feedbackNode, `已复制 ${board.batchId} 的批次成片验收单；请先独立验收 B00，再逐条选择通过、返剪或补拍。`);
      }
      return true;
    } catch (error) {
      if (operation !== copySequence || revisionReader() !== revision || staleReader()) return false;
      const labels = { shoot: "批次拍摄镜头板", take: "批次收工接片单", edit: "批次剪辑装配单", review: "批次成片验收单" };
      setText(feedbackNode, error.message || `${labels[kind] || "批次生产资料"}复制失败，请检查变量边界与现场字段。`);
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
