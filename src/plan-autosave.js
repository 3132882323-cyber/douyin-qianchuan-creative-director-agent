function safeDelay(value) {
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("方案自动保存延迟无效");
  return delay;
}

function safeError(error) {
  return error instanceof Error ? error : new Error(String(error || "方案保存失败"));
}

export function createPlanAutosave({ save, delay = 450, setTimer = setTimeout, clearTimer = clearTimeout, onState } = {}) {
  if (typeof save !== "function") throw new Error("方案自动保存缺少保存函数");
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") throw new Error("方案自动保存计时器无效");
  const delayMs = safeDelay(delay);
  const stateWriter = typeof onState === "function" ? onState : () => {};
  let timer = null;
  let revision = 0;
  let savedRevision = 0;
  let running = null;
  let destroyed = false;
  let lastError = null;

  function emit(code, extra = {}) {
    if (!destroyed) stateWriter({ code, revision, savedRevision, pending: savedRevision < revision, ...extra });
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  async function startSave() {
    if (running) return running;
    if (savedRevision >= revision) return { ok: true, revision: savedRevision };
    const targetRevision = revision;
    const operation = (async () => {
      try {
        await save({ revision: targetRevision });
        savedRevision = Math.max(savedRevision, targetRevision);
        lastError = null;
        emit(savedRevision >= revision ? "saved" : "pending");
        return { ok: true, revision: targetRevision };
      } catch (error) {
        lastError = safeError(error);
        emit(targetRevision >= revision ? "error" : "pending", { error: lastError });
        return { ok: false, revision: targetRevision, error: lastError };
      }
    })();
    running = operation;
    operation.finally(() => {
      if (running === operation) running = null;
    });
    return operation;
  }

  async function runScheduled() {
    timer = null;
    if (destroyed) return false;
    if (running) await running;
    if (destroyed || timer !== null || savedRevision >= revision) return savedRevision >= revision;
    const result = await startSave();
    return result.ok;
  }

  function schedule() {
    if (destroyed) return revision;
    revision += 1;
    lastError = null;
    cancelTimer();
    emit("pending");
    timer = setTimer(() => runScheduled(), delayMs);
    return revision;
  }

  async function flush() {
    if (destroyed) return savedRevision >= revision;
    cancelTimer();
    while (savedRevision < revision) {
      const result = running ? await running : await startSave();
      if (!result.ok && result.revision >= revision) return false;
      cancelTimer();
    }
    return true;
  }

  return {
    schedule,
    flush,
    getState() {
      return {
        revision,
        savedRevision,
        pending: savedRevision < revision,
        running: Boolean(running),
        scheduled: timer !== null,
        error: lastError
      };
    },
    destroy() {
      destroyed = true;
      cancelTimer();
    }
  };
}
