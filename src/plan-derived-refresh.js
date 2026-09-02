export function createPlanDerivedRefresh({ refresh, requestFrame, cancelFrame, onError } = {}) {
  if (typeof refresh !== "function") throw new TypeError("refresh 必须是函数");
  if (typeof requestFrame !== "function") throw new TypeError("requestFrame 必须是函数");
  if (typeof cancelFrame !== "function") throw new TypeError("cancelFrame 必须是函数");

  const reportError = typeof onError === "function" ? onError : () => {};
  let frameId = null;
  let pending = false;
  let running = false;
  let destroyed = false;

  function requestPendingFrame() {
    if (destroyed || running || frameId !== null || !pending) return;
    frameId = requestFrame(runPendingRefresh);
  }

  function runPendingRefresh() {
    frameId = null;
    if (destroyed || running || !pending) return false;
    pending = false;
    running = true;
    try {
      refresh();
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
      requestPendingFrame();
    }
    return true;
  }

  function schedule() {
    if (destroyed) return false;
    pending = true;
    requestPendingFrame();
    return true;
  }

  function flush() {
    if (destroyed || !pending) return false;
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
    return runPendingRefresh();
  }

  function cancel() {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
    pending = false;
  }

  function destroy() {
    cancel();
    destroyed = true;
  }

  return {
    schedule,
    flush,
    cancel,
    destroy,
    getState: () => ({
      pending,
      running,
      scheduled: frameId !== null,
      destroyed
    })
  };
}

export function derivePlanAsyncFeedback({ saveCode = "idle", saveError = "", refreshError = "" } = {}) {
  const code = ["idle", "pending", "saved", "error"].includes(saveCode) ? saveCode : "idle";
  const storageMessage = String(saveError || "").trim();
  const refreshMessage = String(refreshError || "").trim();
  const error = [storageMessage, refreshMessage].filter(Boolean).join("；");
  if (code === "error") {
    return { status: refreshMessage ? "保存失败 · 提示异常" : "保存失败", good: false, error };
  }
  if (refreshMessage) {
    const prefix = code === "pending" ? "保存中 · " : code === "saved" ? "已保存 · " : "";
    return { status: `${prefix}提示异常`, good: false, error };
  }
  if (code === "pending") return { status: "保存中…", good: false, error };
  if (code === "saved") return { status: "已保存", good: true, error };
  return { status: "", good: false, error };
}
