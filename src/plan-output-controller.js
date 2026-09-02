function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} 参数无效`);
  return value;
}

function outputOptions(options = {}) {
  const label = String(options.label || "").trim();
  const successMessage = String(options.successMessage || "").trim();
  const failureMessage = String(options.failureMessage || "").trim();
  const completionFailureMessage = String(options.completionFailureMessage || "").trim();
  if (!label || !successMessage || !failureMessage || typeof options.createContent !== "function") {
    throw new Error("方案输出参数无效");
  }
  return { ...options, label, successMessage, failureMessage, completionFailureMessage };
}

export function createPlanCompletionTracker({
  getPlan,
  getReceipt,
  hasCompletion,
  setReceipt,
  matchesRevision,
  createReceipt,
  writeReceipt,
  removeReceipt,
  persist
} = {}) {
  const planReader = requiredFunction(getPlan, "方案读取");
  const receiptReader = requiredFunction(getReceipt, "完成凭据读取");
  const completionReader = typeof hasCompletion === "function" ? hasCompletion : () => Boolean(receiptReader());
  const receiptWriter = requiredFunction(setReceipt, "完成凭据更新");
  const revisionMatcher = requiredFunction(matchesRevision, "方案修订校验");
  const receiptFactory = requiredFunction(createReceipt, "完成凭据生成");
  const storedReceiptWriter = requiredFunction(writeReceipt, "完成凭据存储");
  const storedReceiptRemover = requiredFunction(removeReceipt, "完成凭据清理");
  const projectPersist = requiredFunction(persist, "项目持久化");
  let desiredSyncRevision = 0;
  let completedSyncRevision = 0;
  let requiredProjectSyncRevision = 0;
  let latestSyncDurable = true;
  let projectSyncInFlight = false;
  let syncTask = null;

  function replaceReceipt(receipt, { persistProject = true } = {}) {
    receiptWriter(receipt);
    desiredSyncRevision += 1;
    if (persistProject || projectSyncInFlight) requiredProjectSyncRevision = desiredSyncRevision;
    return desiredSyncRevision;
  }

  async function runSyncLoop() {
    while (completedSyncRevision < desiredSyncRevision) {
      const targetRevision = desiredSyncRevision;
      const targetReceipt = receiptReader();
      let receiptStored = false;
      let projectStored = false;
      try {
        if (targetReceipt) await storedReceiptWriter(targetReceipt);
        else await storedReceiptRemover();
        receiptStored = true;
      } catch {
        // 输出已完成时，单一存储写入失败不应被误报为输出失败。
      }
      if (targetRevision === desiredSyncRevision && targetRevision === requiredProjectSyncRevision) {
        try {
          projectSyncInFlight = true;
          projectStored = await projectPersist() !== false;
        } catch {
          // 当前工作区仍留在页面；项目层会通过自己的错误提示说明降级状态。
        } finally {
          projectSyncInFlight = false;
        }
      }
      completedSyncRevision = targetRevision;
      latestSyncDurable = receiptStored || projectStored;
    }
  }

  function syncCompletion() {
    if (!syncTask) {
      syncTask = runSyncLoop().finally(() => {
        syncTask = null;
        if (completedSyncRevision < desiredSyncRevision) return syncCompletion();
        return undefined;
      });
    }
    return syncTask;
  }

  function clearCompletion({ persistProject = true } = {}) {
    if (!completionReader()) return false;
    replaceReceipt(null, { persistProject });
    void syncCompletion();
    return true;
  }

  async function markCompleted(token) {
    if (!revisionMatcher(token)) return false;
    const plan = planReader();
    if (!plan) return false;
    const receipt = receiptFactory(plan);
    if (!receipt || typeof receipt !== "object") throw new Error("方案完成凭据无效");
    const completionRevision = replaceReceipt(receipt);
    await syncCompletion();
    if (!revisionMatcher(token) || receiptReader() !== receipt) {
      if (receiptReader() === receipt) replaceReceipt(null);
      await syncCompletion();
      return false;
    }
    if (completedSyncRevision < completionRevision || !latestSyncDurable) {
      if (receiptReader() === receipt) replaceReceipt(null);
      await syncCompletion();
      throw new Error("方案已输出，但完成状态未能保存");
    }
    return true;
  }

  return Object.freeze({ clearCompletion, flush: syncCompletion, markCompleted });
}

export function createPlanOutputController({
  isAvailable,
  beginOperation,
  isCurrentOperation,
  isLatestOperation,
  writeText,
  downloadFile,
  markCompleted,
  onFeedback,
  onOutdated,
  onCompletionChange
} = {}) {
  const availabilityReader = requiredFunction(isAvailable, "方案可用性");
  const operationStarter = requiredFunction(beginOperation, "输出操作启动");
  const currentOperationReader = requiredFunction(isCurrentOperation, "当前操作校验");
  const latestOperationReader = requiredFunction(isLatestOperation, "最新操作校验");
  const clipboardWriter = requiredFunction(writeText, "剪贴板写入");
  const fileDownloader = requiredFunction(downloadFile, "文件导出");
  const completionWriter = requiredFunction(markCompleted, "完成状态更新");
  const feedbackWriter = requiredFunction(onFeedback, "输出反馈");
  const outdatedWriter = requiredFunction(onOutdated, "旧版本反馈");
  const completionChangeWriter = requiredFunction(onCompletionChange, "完成状态刷新");

  function reportOutdated(token, label) {
    if (!latestOperationReader(token)) return;
    outdatedWriter(token, label);
  }

  async function finish(token, options) {
    if (!currentOperationReader(token)) {
      reportOutdated(token, options.label);
      return false;
    }
    feedbackWriter(options.successMessage);
    const completion = completionWriter(token);
    completionChangeWriter();
    const completed = await completion;
    if (completed !== true || !currentOperationReader(token)) {
      reportOutdated(token, options.label);
      return false;
    }
    return true;
  }

  async function copy(optionsValue) {
    if (!availabilityReader()) return false;
    let token = null;
    let delivered = false;
    let options;
    try {
      options = outputOptions(optionsValue);
      token = operationStarter();
      const content = options.createContent();
      await clipboardWriter(content);
      delivered = true;
      return await finish(token, options);
    } catch (error) {
      if (!token || currentOperationReader(token)) {
        if (delivered) completionChangeWriter();
        feedbackWriter(delivered && options?.completionFailureMessage
          ? options.completionFailureMessage
          : options?.failureMessage || error?.message || "方案复制失败");
      }
      return false;
    }
  }

  async function exportFile(optionsValue) {
    if (!availabilityReader()) return false;
    let token = null;
    let delivered = false;
    let options;
    try {
      options = outputOptions(optionsValue);
      const name = String(options.name || "").trim();
      const type = String(options.type || "").trim();
      if (!name || !type) throw new Error("方案导出参数无效");
      token = operationStarter();
      const content = options.createContent();
      await fileDownloader(name, content, type);
      delivered = true;
      return await finish(token, options);
    } catch (error) {
      if (!token || currentOperationReader(token)) {
        if (delivered) completionChangeWriter();
        feedbackWriter(delivered && options?.completionFailureMessage
          ? options.completionFailureMessage
          : options?.failureMessage || error?.message || "方案导出失败");
      }
      return false;
    }
  }

  return Object.freeze({ copy, exportFile });
}
