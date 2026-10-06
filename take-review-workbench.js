import { buildDirectorTakeReview } from "./src/director-take-review.js";
import { createProjectRepository, openProjectDatabase } from "./src/project-store.js";
import {
  TAKE_REVIEW_CHECKS,
  TAKE_REVIEW_HANDOFF_ROLES,
  TAKE_REVIEW_OUTCOMES,
  TAKE_REVIEW_OWNER_ROLES,
  assessTakeReviewRecord,
  deriveTakeReviewFollowUps,
  summarizeTakeReviewBatch,
  summarizeTakeReviewHistory,
  takeReviewBatchHandoffToText,
  takeReviewFollowUpsToText,
  takeReviewPlanFingerprint,
  takeReviewPlanMatchesWorkspace,
  takeReviewRecordSnapshot,
  takeReviewVersionMatchesPlan
} from "./src/take-review-record.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  repository: null,
  project: null,
  plan: null,
  versions: [],
  reviews: [],
  records: [],
  summary: null,
  selectedTestId: "",
  editingId: "",
  dirty: false,
  saving: false,
  outputBusy: false,
  refreshRequired: false,
  mutationRevision: 0,
  loadRevision: 0
};

const outcomeLabels = new Map(TAKE_REVIEW_OUTCOMES.map((entry) => [entry.code, entry.label]));
const handoffLabels = new Map(TAKE_REVIEW_HANDOFF_ROLES.map((entry) => [entry.code, entry.label]));
const ownerLabels = new Map(TAKE_REVIEW_OWNER_ROLES.map((entry) => [entry.code, entry.label]));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = String(value ?? "");
}

function setFeedback(message = "", { error = false } = {}) {
  const node = $("#workbench-feedback");
  node.textContent = message;
  node.dataset.error = String(error);
}

function setFormError(message = "") {
  setText("#form-error", message);
}

function setFormState(code, label) {
  const node = $("#form-state");
  node.dataset.code = code;
  node.textContent = label;
}

function markDirty() {
  if (state.refreshRequired || !state.selectedTestId) return;
  state.mutationRevision += 1;
  const wasDirty = state.dirty;
  state.dirty = true;
  setFormState("dirty", "未保存");
  if (wasDirty) return;
  renderOverview(currentSummary());
  renderHistoryArchive();
  $("#copy-follow-up-sheet").disabled = true;
}

function safeFilePart(value) {
  return String(value || "batch").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").replace(/\s+/gu, "-").slice(0, 80) || "batch";
}

function takeReviewRecordsSnapshot(records = []) {
  return JSON.stringify(records
    .map(takeReviewRecordSnapshot)
    .sort((left, right) => left.localeCompare(right)));
}

function expectedRecordSet(records = []) {
  return records.map((record) => ({
    id: record.id,
    revision: record.revision,
    createdOrder: record.createdOrder || 0,
    contentSnapshot: takeReviewRecordSnapshot(record)
  }));
}

function recordsForSource(records, batchId, planFingerprint) {
  return records.filter((record) => record.source.batchId === batchId && record.source.planFingerprint === planFingerprint);
}

function currentSourceRecords(records = state.records) {
  if (!state.plan) return [];
  return recordsForSource(records, state.plan.batchId, takeReviewPlanFingerprint(state.plan));
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function selectedContext() {
  const index = state.plan?.items?.findIndex((item) => item.id === state.selectedTestId) ?? -1;
  if (index < 0) return null;
  return {
    index,
    item: state.plan.items[index],
    version: state.versions.find((entry) => entry.testId === state.selectedTestId),
    review: state.reviews[index]
  };
}

function currentSummary() {
  if (!state.summary) {
    state.summary = summarizeTakeReviewBatch({ plan: state.plan, versions: state.versions, reviews: state.reviews, records: state.records });
  }
  return state.summary;
}

function validateStoredSnapshot(snapshot) {
  const project = snapshot?.project;
  if (!project || project.archived) throw new Error("目标项目不存在或已归档，请从侧边栏重新打开片场过条台。");
  const plan = project.workspace?.creativePlan;
  if (!plan?.items?.length) throw new Error("当前项目还没有已保存的拍摄方案，请先在侧边栏生成并保存下一版任务。");
  if (plan.items.length < 2 || plan.items.length > 20) throw new Error("片场过条台仅支持包含 2–20 个版本的同批方案。");
  if (!takeReviewPlanMatchesWorkspace(plan, project.workspace)) {
    throw new Error("当前拍摄方案对应的创作任务或分析已变化，请返回侧边栏重新生成并保存方案。");
  }
  const versions = Array.isArray(snapshot.versions) ? snapshot.versions : [];
  const currentVersions = plan.items.map((item) => {
    const matches = versions.filter((entry) => entry.testId === item.id);
    if (matches.length !== 1 || !takeReviewVersionMatchesPlan(matches[0], plan)) {
      throw new Error("当前方案尚未完整同步到本地版本库，请返回侧边栏等待保存完成后重试。");
    }
    return matches[0];
  });
  const reviews = plan.items.map((_, index) => buildDirectorTakeReview(plan, { itemIndex: index }));
  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  return {
    project,
    plan,
    versions: currentVersions,
    reviews,
    records,
    summary: summarizeTakeReviewBatch({ plan, versions: currentVersions, reviews, records })
  };
}

async function readFreshContext(projectId) {
  return validateStoredSnapshot(await state.repository.getTakeReviewSnapshot(projectId));
}

function applyStoredContext(context, { requestedTestId = "" } = {}) {
  state.project = context.project;
  state.plan = context.plan;
  state.versions = context.versions;
  state.reviews = context.reviews;
  state.records = context.records;
  state.summary = context.summary;
  state.refreshRequired = false;
  const planIds = new Set(context.plan.items.map((item) => item.id));
  if (!state.selectedTestId || !planIds.has(state.selectedTestId)) {
    const firstFollowUp = deriveTakeReviewFollowUps(context.summary)[0]?.testId;
    state.selectedTestId = planIds.has(requestedTestId) ? requestedTestId : firstFollowUp || context.plan.items[0].id;
  }
}

function nextReviewTestId(summary, currentTestId) {
  const followUps = deriveTakeReviewFollowUps(summary);
  if (followUps.some((item) => item.testId === currentTestId)) return currentTestId;
  return followUps[0]?.testId || currentTestId;
}

function recordsForSelected() {
  const context = selectedContext();
  if (!context?.version || !context.review) return { current: [], stale: [] };
  const current = [];
  const stale = [];
  for (const record of state.records.filter((entry) => entry.source.testId === state.selectedTestId)) {
    const assessment = assessTakeReviewRecord(record, { plan: state.plan, version: context.version, review: context.review });
    (assessment.current ? current : stale).push({ record: assessment.record, reasons: assessment.reasons });
  }
  const newest = (left, right) => (right.record.createdOrder || 0) - (left.record.createdOrder || 0)
    || right.record.createdAt.localeCompare(left.record.createdAt)
    || right.record.id.localeCompare(left.record.id);
  current.sort(newest);
  stale.sort(newest);
  return { current, stale };
}

function renderOwnerOptions() {
  const select = $("#owner-role");
  select.replaceChildren();
  for (const role of TAKE_REVIEW_OWNER_ROLES) {
    const option = element("option", "", role.label);
    option.value = role.code;
    select.append(option);
  }
}

function renderChecks(review, values = new Map()) {
  const list = $("#check-list");
  list.replaceChildren();
  TAKE_REVIEW_CHECKS.forEach((definition, index) => {
    const planned = review?.checks?.find((entry) => entry.code === definition.code);
    const row = element("div", "check-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-labelledby", `take-check-label-${definition.code}`);
    const copy = element("span", "check-copy");
    const title = element("strong", "", `${index + 1} · ${definition.label}`);
    title.id = `take-check-label-${definition.code}`;
    copy.append(
      title,
      element("small", "", `计划参考：${planned?.reference || "请回到当前方案核对"}`),
      element("small", "", `怎么查：${planned?.instruction || "请在现场人工回看并判断。"}`),
      element("small", "", `未通过：${planned?.failureAction || "记录问题并由编导人工选择重拍或停机核实。"}`)
    );
    const choices = element("span", "check-choices");
    for (const [value, label] of [["pass", "通过"], ["issue", "有问题"]]) {
      const input = element("input", "check-choice-input");
      input.type = "radio";
      input.name = `take-check-${definition.code}`;
      input.id = `take-check-${definition.code}-${value}`;
      input.value = value;
      input.dataset.checkCode = definition.code;
      input.required = true;
      input.checked = values.get(definition.code) === value;
      const choiceLabel = element("label", "check-choice-label", label);
      choiceLabel.htmlFor = input.id;
      choices.append(input, choiceLabel);
    }
    row.append(copy, choices);
    list.append(row);
  });
}

function syncConditionalFields({ clearInvalidRole = true } = {}) {
  const outcome = $("#review-outcome").value;
  const checks = [...document.querySelectorAll("[data-check-code]:checked")].map((node) => node.value);
  const allPass = checks.length === TAKE_REVIEW_CHECKS.length && checks.every((value) => value === "pass");
  const canAssign = outcome === "keep" && allPass;
  const handoff = $("#handoff-role");
  for (const option of handoff.options) option.disabled = option.value !== "none" && !canAssign;
  if (clearInvalidRole && !canAssign && handoff.value !== "none") handoff.value = "none";
  const hasIssue = checks.includes("issue");
  const needsTimecode = outcome === "reshoot" || hasIssue;
  const needsAction = needsTimecode || outcome === "hold";
  $("#issue-timecode").required = needsTimecode;
  $("#next-correction").required = needsAction;
  $("#owner-role").required = needsAction;
  $("#issue-fields-title").textContent = needsAction ? "问题与下一条修正 · 必填" : "问题与下一条修正 · 可选";
  const currentFollowUp = state.plan ? deriveTakeReviewFollowUps(currentSummary()).find((item) => item.testId === state.selectedTestId) : null;
  const cleanTakeReady = outcome === "keep" && allPass;
  let nextActionLabel = "保存并到下一条";
  if (!cleanTakeReady && currentFollowUp?.status === "order_ambiguous") nextActionLabel = "保存并确认最新结论";
  else if (needsAction || (!cleanTakeReady && ["hold", "reshoot"].includes(currentFollowUp?.status))) nextActionLabel = "保存并继续补拍";
  else if (cleanTakeReady) nextActionLabel = "保存并检查下一项";
  $("#save-and-next-take-review").textContent = nextActionLabel;
}

function resetForm({ announce = false } = {}) {
  const context = selectedContext();
  state.editingId = "";
  $("#review-id").value = "";
  $("#review-revision").value = "0";
  $("#material-code").value = "";
  $("#take-number").value = "";
  $("#review-outcome").value = "";
  $("#handoff-role").value = "none";
  $("#issue-timecode").value = "";
  $("#next-correction").value = "";
  $("#owner-role").value = "none";
  renderChecks(context?.review);
  syncConditionalFields();
  setFormError();
  state.dirty = false;
  setFormState("idle", "新记录");
  if (announce) setFeedback("表单已重置；已保存的过条记录未改变。");
}

function fillForm(record) {
  state.mutationRevision += 1;
  state.editingId = record.id;
  $("#review-id").value = record.id;
  $("#review-revision").value = String(record.revision);
  $("#material-code").value = record.materialCode;
  $("#take-number").value = record.takeNumber;
  $("#review-outcome").value = record.outcome;
  $("#handoff-role").value = record.handoffRole;
  $("#issue-timecode").value = record.issueTimecode;
  $("#next-correction").value = record.nextCorrection;
  $("#owner-role").value = record.ownerRole;
  renderChecks(selectedContext()?.review, new Map(record.checks.map((entry) => [entry.code, entry.status])));
  syncConditionalFields({ clearInvalidRole: false });
  setFormError();
  state.dirty = false;
  setFormState("saved", `已保存 · r${record.revision}`);
  const summary = currentSummary();
  renderOverview(summary);
  renderFollowUps(summary);
  $("#material-code").focus();
}

function renderSource() {
  const context = selectedContext();
  setText("#source-test-id", context?.item?.id || "—");
  setText("#source-variable", context?.item ? `${context.item.singleVariable} → ${context.item.variant}` : "—");
  setText("#source-fixed", context?.item?.fixedElements || "—");
  const warningRoot = $("#source-warnings");
  const warningList = $("#source-warning-list");
  warningList.replaceChildren();
  const warnings = context?.review?.warnings || [];
  warnings.forEach((warning) => warningList.append(element("li", "", warning)));
  warningRoot.hidden = warnings.length === 0;
  const cannotSave = !context?.version || !context.review || state.saving || state.outputBusy || state.refreshRequired;
  $("#save-take-review").disabled = cannotSave;
  $("#save-and-next-take-review").disabled = cannotSave;
  $("#take-review-form").inert = state.saving || state.outputBusy || state.refreshRequired;
  $("#take-review-form").setAttribute("aria-busy", String(state.saving));
  $("#version-list").inert = state.saving || state.outputBusy;
  $("#current-review-list").inert = state.saving || state.outputBusy || state.refreshRequired;
  $("#stale-review-list").inert = state.saving || state.outputBusy || state.refreshRequired;
  $("#follow-up-panel").inert = state.saving || state.outputBusy || state.refreshRequired;
}

function selectVersion(testId) {
  if (state.saving || state.outputBusy) return false;
  if (testId === state.selectedTestId) return true;
  if (state.dirty && !window.confirm("当前 Take 表单尚未保存。切换版本会丢弃这些输入，是否继续？")) return false;
  state.selectedTestId = testId;
  resetForm();
  renderAll();
  $("#material-code").focus();
  return true;
}

function focusVersionForReview(testId, { followUpStatus = "" } = {}) {
  const shouldStartNewRecord = ["order_ambiguous", "hold", "reshoot", "unreviewed"].includes(followUpStatus);
  if (testId === state.selectedTestId && shouldStartNewRecord) {
    if (state.dirty && !window.confirm("当前 Take 表单尚未保存。开始登记新的 Take 会丢弃这些输入，是否继续？")) return;
    resetForm();
    renderAll();
  }
  if (testId === state.selectedTestId && followUpStatus === "needs_primary" && state.dirty
    && !window.confirm("当前 Take 表单尚未保存。载入已保留 Take 会丢弃这些输入，是否继续？")) return;
  if (!selectVersion(testId)) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  document.querySelector(".review-panel")?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  if (followUpStatus === "needs_primary") {
    const candidate = recordsForSelected().current
      .map((entry) => entry.record)
      .find((record) => record.outcome === "keep" && record.checks.every((check) => check.status === "pass"));
    if (candidate) {
      fillForm(candidate);
      $("#handoff-role").focus({ preventScroll: true });
      return;
    }
  }
  $("#material-code").focus({ preventScroll: true });
}

function renderVersions(summary) {
  const list = $("#version-list");
  list.replaceChildren();
  summary.entries.forEach((entry, index) => {
    const button = element("button", "version-button");
    button.type = "button";
    button.disabled = state.saving || state.outputBusy;
    button.dataset.testId = entry.testId;
    button.setAttribute("aria-current", String(entry.testId === state.selectedTestId));
    const status = entry.orderingAmbiguous
      ? "旧记录待核对"
      : entry.latestRecord?.outcome === "hold"
        ? "停机核实"
        : entry.actionUnresolved
          ? "需补拍"
          : entry.primaryRecords.length === 1
            ? "首选已定"
            : entry.currentRecords.length
              ? `${entry.currentRecords.length} 个 Take`
              : "待过条";
    button.append(
      element("strong", "", entry.testId),
      element("small", "", `${index === 0 ? "基线" : `变体 ${index}`} · ${entry.review.singleVariable} → ${entry.review.variant}`)
    );
    const progress = element("span", "version-progress");
    progress.append(element("small", "", status), element("small", "", entry.primaryRecords.length ? `首选 ${entry.primaryRecords[0].takeNumber}` : "未指定首选"));
    button.append(progress);
    button.addEventListener("click", () => selectVersion(entry.testId));
    list.append(button);
  });
  setText("#version-count", summary.totalVersions);
}

function reviewCard(entry, { stale = false } = {}) {
  const record = entry.record;
  const card = element("article", `review-card${stale ? " stale" : ""}`);
  const head = element("div", "review-card-head");
  head.append(
    element("strong", "", `${record.materialCode} · ${record.takeNumber}`),
    element("span", "", stale ? "旧方案" : handoffLabels.get(record.handoffRole) || "已记录")
  );
  const createdLabel = new Date(record.createdAt).toLocaleString("zh-CN");
  const revisedLabel = record.updatedAt === record.createdAt ? "" : ` · 修订 ${new Date(record.updatedAt).toLocaleString("zh-CN")}`;
  card.append(
    head,
    element("p", "", `${outcomeLabels.get(record.outcome) || record.outcome} · 登记 ${createdLabel}${revisedLabel}`)
  );
  const issueLabels = record.checks
    .filter((check) => check.status === "issue")
    .map((check) => TAKE_REVIEW_CHECKS.find((definition) => definition.code === check.code)?.label || check.code);
  card.append(element("p", "", issueLabels.length ? `检查问题：${issueLabels.join("、")}` : `${record.checks.length}/${TAKE_REVIEW_CHECKS.length} 项人工确认通过`));
  if (record.nextCorrection) card.append(element("p", "", `${ownerLabels.get(record.ownerRole) || "负责人"}：${record.nextCorrection}${record.issueTimecode ? `（${record.issueTimecode}）` : ""}`));
  if (stale) {
    card.append(element("p", "", `只读原因：${entry.reasons.join("、") || "来源方案已变化"}`));
    return card;
  }
  const actions = element("div", "review-card-actions");
  const edit = element("button", "button secondary", "编辑");
  edit.type = "button";
  edit.disabled = state.saving || state.outputBusy || state.refreshRequired;
  edit.addEventListener("click", () => {
    if (state.saving || state.outputBusy || state.refreshRequired) return;
    if (state.dirty && !window.confirm("当前表单尚未保存。载入这条记录会丢弃当前输入，是否继续？")) return;
    fillForm(record);
  });
  const remove = element("button", "button danger", "删除");
  remove.type = "button";
  remove.disabled = state.saving || state.outputBusy || state.refreshRequired;
  remove.addEventListener("click", () => void removeRecord(record));
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function renderHistory() {
  const { current, stale } = recordsForSelected();
  setText("#history-panel-title", state.selectedTestId ? `本条记录 · ${state.selectedTestId}` : "本条记录");
  const currentList = $("#current-review-list");
  currentList.replaceChildren();
  if (!current.length) currentList.append(element("p", "empty-list", "这个版本还没有当前方案下的人工过条记录。"));
  else current.forEach((entry) => currentList.append(reviewCard(entry)));
  const staleRoot = $("#stale-reviews");
  staleRoot.hidden = stale.length === 0;
  setText("#stale-review-count", stale.length);
  const staleList = $("#stale-review-list");
  staleList.replaceChildren();
  stale.forEach((entry) => staleList.append(reviewCard(entry, { stale: true })));
  setText("#history-count", current.length);
}

function renderOverview(summary) {
  setText("#project-name", `项目：${state.project.name}`);
  setText("#batch-title", summary.batchId || "未命名批次");
  const badge = $("#batch-status");
  badge.dataset.code = summary.code;
  badge.textContent = summary.label;
  setText("#metric-versions", summary.totalVersions);
  setText("#metric-reviewed", `${summary.reviewedCount} / ${summary.totalVersions}`);
  setText("#metric-primary", `${summary.primaryCount} / ${summary.totalVersions}`);
  setText("#metric-issues", deriveTakeReviewFollowUps(summary).length);
  setText("#metric-stale", summary.staleCount);
  setText("#batch-summary", state.dirty
    ? "当前表单有未保存输入；接片复制与记录导出已暂停，请先保存或重置。"
    : state.refreshRequired
      ? "刚才的操作已经提交，但本页没有读回最新列表；保存、删除、导出和接片复制已暂停，请重新载入。"
    : summary.ready
    ? "本批已达到可接片条件：每个版本都有一个人工首选，且最新结论没有待重拍或停机项。"
    : summary.blockers.join("；") || "请逐条完成人工过条。系统不会自动判断或选择 Take。");
  $("#copy-take-handoff").disabled = !summary.ready || state.dirty || state.saving || state.outputBusy || state.refreshRequired;
  $("#export-take-reviews").disabled = state.dirty || state.saving || state.outputBusy || state.refreshRequired;
  $("#clear-take-reviews").disabled = state.saving || state.outputBusy || state.refreshRequired || currentSourceRecords().length === 0;
  $("#reload-workbench").disabled = state.saving || state.outputBusy;
  setText("#handoff-summary", summary.ready
    ? "人工首选已齐，可以生成预填接片单；复制不会自动修改制作状态。"
    : "每个版本都有一个人工首选 Take，且没有未解决的重拍或停机项后，才可生成预填接片单。");
}

function renderFollowUps(summary) {
  const followUps = deriveTakeReviewFollowUps(summary);
  const list = $("#follow-up-list");
  list.replaceChildren();
  setText("#follow-up-count", followUps.length);
  if (!followUps.length) {
    list.append(element("p", "follow-up-empty", summary.ready
      ? "当前批次的人工过条已闭环。收工前请核对下方首选与备选，再复制接片单。"
      : "当前没有可定位的现场待办；请先核对批次版本数量和方案同步状态。"));
  } else {
    followUps.forEach((item) => {
      const button = element("button", "follow-up-item");
      button.type = "button";
      button.disabled = state.saving || state.outputBusy || state.refreshRequired;
      const head = element("span", "follow-up-item-head");
      head.append(element("strong", "", item.testId), element("span", "follow-up-item-status", item.statusLabel));
      button.append(head);
      if (item.status === "order_ambiguous") {
        button.append(element("small", "", `${item.ambiguousRecordCount} 条旧记录 · 不自动猜测先后`));
      } else if (item.hasManualRecord) {
        const owner = ownerLabels.get(item.ownerRole) || "未指定负责人";
        button.append(element("small", "", `${item.materialCode} · ${item.takeNumber}${item.issueTimecode ? ` · ${item.issueTimecode}` : ""} · ${owner}`));
      }
      button.append(element("span", "", item.prompt));
      button.addEventListener("click", () => focusVersionForReview(item.testId, { followUpStatus: item.status }));
      list.append(button);
    });
  }
  const first = followUps[0];
  setText("#follow-up-summary", first
    ? `先处理 ${first.statusLabel}：${first.testId}。排序仅依据当前方案顺序与人工记录，不代表系统检查或判断了素材。`
    : summary.ready
      ? "全部版本已有唯一人工首选，且最新登记没有未解决问题。"
      : "没有生成自动结论；请人工核对当前批次结构。");
  const jump = $("#jump-next-follow-up");
  jump.disabled = state.saving || state.outputBusy || state.refreshRequired || (!first && !summary.ready);
  jump.textContent = first ? `定位 ${first.testId} · ${first.statusLabel}` : summary.ready ? "前往收工接片" : "暂无可定位项";
  $("#copy-follow-up-sheet").disabled = !followUps.length || state.dirty || state.saving || state.outputBusy || state.refreshRequired;
}

function renderHistoryArchive() {
  const history = summarizeTakeReviewHistory({
    projectId: state.project.id,
    currentBatchId: state.plan.batchId,
    currentPlanFingerprint: takeReviewPlanFingerprint(state.plan),
    records: state.records
  });
  setText("#history-capacity", `${history.totalCount} / ${history.capacityLimit} 条`);
  setText("#history-group-count", `${history.groups.length} 组`);
  setText("#history-archive-summary", history.groups.length
    ? `当前来源 ${history.currentSourceCount} 条，历史 ${history.historicalCount} 条。历史组不会自动删除；确认不再需要时请先导出，再人工删除以释放本地额度。单组 JSON 仅供留档，完整恢复请使用侧边栏的全部项目备份。`
    : `当前来源 ${history.currentSourceCount} 条，暂无历史记录。系统不会按时间自动清理。`);
  const warning = $("#history-capacity-warning");
  warning.hidden = !history.capacityWarning;
  warning.textContent = history.capacityWarning
    ? `容量提醒：已使用 ${history.totalCount} / ${history.capacityLimit} 条。请核对并导出不再需要的历史组；系统不会自动删除。`
    : "";
  const list = $("#history-batch-list");
  list.replaceChildren();
  const archive = $("#take-history-archive");
  archive.setAttribute("aria-busy", String(state.saving || state.outputBusy));
  if (!archive.open) return;
  const disabled = state.dirty || state.saving || state.outputBusy || state.refreshRequired;
  for (const group of history.groups) {
    const card = element("article", "history-batch-card");
    card.dataset.historyBatchId = group.batchId;
    card.dataset.historyPlanFingerprint = group.planFingerprint;
    const head = element("div", "history-batch-card-head");
    head.append(
      element("strong", "", group.batchId),
      element("span", "count", `${group.recordCount} 条`)
    );
    const updated = new Date(group.latestUpdatedAt).toLocaleString("zh-CN");
    card.append(
      head,
      element("p", "", `${group.versionCount} 个版本 · 最近登记 ${updated}`),
      element("p", "", `来源校验 ${group.planFingerprint.slice(-8)} · 仅结构化人工记录，不含媒体`)
    );
    const actions = element("div", "history-batch-actions");
    const exportButton = element("button", "button secondary", "导出本组 JSON");
    exportButton.type = "button";
    exportButton.dataset.historyAction = "export";
    exportButton.disabled = disabled;
    exportButton.setAttribute("aria-label", `${group.batchId}：导出 ${group.recordCount} 条历史过条记录`);
    const deleteButton = element("button", "button danger", "删除本组");
    deleteButton.type = "button";
    deleteButton.dataset.historyAction = "delete";
    deleteButton.disabled = disabled;
    deleteButton.setAttribute("aria-label", `${group.batchId}：删除 ${group.recordCount} 条历史过条记录`);
    actions.append(exportButton, deleteButton);
    card.append(actions);
    list.append(card);
  }
  if (!history.groups.length) list.append(element("p", "empty-list", "旧方案来源或旧批次的人工记录会显示在这里，当前没有可管理的历史组。"));
}

function renderAll() {
  const summary = currentSummary();
  renderOverview(summary);
  renderFollowUps(summary);
  renderVersions(summary);
  renderSource();
  renderHistory();
  renderHistoryArchive();
}

function readDraft() {
  return {
    expectedRevision: Number($("#review-revision").value || 0),
    materialCode: $("#material-code").value,
    takeNumber: $("#take-number").value,
    checks: TAKE_REVIEW_CHECKS.map((definition) => {
      const selected = document.querySelector(`[name="take-check-${definition.code}"]:checked`);
      return { code: definition.code, status: selected?.value || "" };
    }),
    outcome: $("#review-outcome").value,
    handoffRole: $("#handoff-role").value,
    issueTimecode: $("#issue-timecode").value,
    nextCorrection: $("#next-correction").value,
    ownerRole: $("#owner-role").value
  };
}

async function saveRecord(event) {
  event.preventDefault();
  const shouldAdvance = event.submitter?.id === "save-and-next-take-review";
  if (state.saving || state.outputBusy) return;
  if (state.refreshRequired) {
    setFormError("本页需要重新载入最新记录后才能继续保存。");
    return;
  }
  const context = selectedContext();
  if (!context?.version || !context.review) {
    setFormError("当前版本没有可用的本地方案来源，请返回侧边栏重新保存方案。");
    return;
  }
  const draft = readDraft();
  const conflict = draft.handoffRole === "none" ? null : recordsForSelected().current
    .map((entry) => entry.record)
    .find((record) => record.id !== state.editingId && record.handoffRole === draft.handoffRole);
  let replaceHandoffRole = false;
  if (conflict) {
    const label = handoffLabels.get(draft.handoffRole);
    replaceHandoffRole = window.confirm(`${context.item.id} 已有${label}“${conflict.materialCode} · ${conflict.takeNumber}”。是否将旧记录降为“暂不指定”，并把当前 Take 设为新的${label}？`);
    if (!replaceHandoffRole) {
      setFormError(`已取消替换，原${label}保持不变。`);
      return;
    }
  }
  const submittedMutationRevision = state.mutationRevision;
  const expectedVersionRecords = expectedRecordSet(state.records
    .filter((record) => record.projectId === state.project.id && record.source.testId === context.version.testId));
  state.saving = true;
  setFormError();
  setFormState("saving", "保存中…");
  renderOverview(currentSummary());
  renderSource();
  let saved;
  try {
    saved = await state.repository.saveTakeReview(state.project.id, context.version.testId, draft, {
      takeId: state.editingId || undefined,
      expectedRevision: draft.expectedRevision,
      expectedPlanFingerprint: takeReviewPlanFingerprint(state.plan),
      expectedVersionRecords,
      replaceHandoffRole,
      expectedRoleConflict: conflict ? { id: conflict.id, revision: conflict.revision } : null
    });
  } catch (error) {
    state.dirty = true;
    setFormState("error", "未保存 · 可重试");
    setFormError(error.message || "过条记录未能保存；当前输入仍保留，请重试。");
    state.saving = false;
    renderAll();
    $("#save-take-review").focus({ preventScroll: true });
    return;
  }

  if (state.mutationRevision !== submittedMutationRevision) {
    state.refreshRequired = true;
    setFormState("saved", "已保存提交值 · 待重新载入");
    setFeedback("提交时页面又出现了新的输入；刚才读取的值已经保存，当前输入仍保留，请先复制后重新载入。", { error: true });
    state.saving = false;
    renderAll();
    $("#reload-workbench").focus({ preventScroll: true });
    return;
  }
  state.dirty = false;
  setFormState("saved", `已保存 · r${saved.revision}`);
  try {
    const fresh = await readFreshContext(state.project.id);
    if (state.mutationRevision !== submittedMutationRevision) {
      throw new Error("读取最新列表期间表单发生变化，当前输入已保留，请重新载入后继续");
    }
    applyStoredContext(fresh);
    const nextTestId = shouldAdvance ? nextReviewTestId(fresh.summary, context.version.testId) : context.version.testId;
    if (shouldAdvance) state.selectedTestId = nextTestId;
    resetForm();
    state.saving = false;
    renderAll();
    if (shouldAdvance && fresh.summary.ready) {
      document.querySelector(".handoff-panel")?.scrollIntoView({ block: "start", behavior: "auto" });
      $("#copy-take-handoff").focus({ preventScroll: true });
      setFeedback(`${context.version.testId} 已保存，本批人工过条已闭环；请完成收工接片核对。`);
    } else {
      const currentFollowUp = deriveTakeReviewFollowUps(fresh.summary).find((item) => item.testId === context.version.testId);
      if (shouldAdvance && currentFollowUp?.status === "needs_primary") {
        focusVersionForReview(context.version.testId, { followUpStatus: currentFollowUp.status });
      } else {
        $("#material-code").focus();
      }
      setFeedback(shouldAdvance && currentFollowUp?.status === "needs_primary"
        ? `${context.version.testId} 的最新人工结论已通过，但本版本仍缺唯一首选；请从已保留 Take 中人工指定。`
        : shouldAdvance && currentFollowUp
          ? `${context.version.testId} 已保存，仍为“${currentFollowUp.statusLabel}”；已留在本版本，请登记下一 Take。`
        : shouldAdvance && nextTestId !== context.version.testId
          ? `${context.version.testId} 已闭环，已定位下一项 ${nextTestId}。`
          : `${context.version.testId} 的人工过条结论已保存到当前浏览器。`);
    }
  } catch (error) {
    state.refreshRequired = true;
    setFormState("saved", "已保存 · 待重新载入");
    state.saving = false;
    renderAll();
    setFeedback(`记录已经保存，但列表未能刷新：${error.message || "请重新载入后继续。"}`, { error: true });
    $("#reload-workbench").focus({ preventScroll: true });
  }
}

async function removeRecord(record) {
  if (state.saving || state.outputBusy) return;
  if (state.refreshRequired) {
    setFeedback("本页需要重新载入最新记录后才能删除。", { error: true });
    return;
  }
  if (state.dirty) {
    setFeedback("当前表单有未保存输入；请先保存或重置，再删除历史记录。", { error: true });
    return;
  }
  if (!window.confirm(`删除“${record.materialCode} · ${record.takeNumber}”的人工过条记录？此操作只删除本地记录，不会删除素材文件。`)) return;
  state.saving = true;
  renderOverview(currentSummary());
  renderSource();
  try {
    await state.repository.deleteTakeReview(state.project.id, record.id, {
      expectedRevision: record.revision,
      expectedContentSnapshot: takeReviewRecordSnapshot(record),
      expectedPlanFingerprint: takeReviewPlanFingerprint(state.plan)
    });
  } catch (error) {
    setFeedback(error.message || "过条记录未能删除，请重新载入后重试。", { error: true });
    state.saving = false;
    renderAll();
    $("#material-code").focus({ preventScroll: true });
    return;
  }

  const wasEditing = state.editingId === record.id;
  state.records = state.records.filter((entry) => entry.id !== record.id);
  state.summary = null;
  if (wasEditing) resetForm();
  try {
    applyStoredContext(await readFreshContext(state.project.id));
    if (wasEditing) resetForm();
    state.saving = false;
    renderAll();
    setFeedback("人工过条记录已删除；素材文件和制作状态未改变。");
    $("#material-code").focus({ preventScroll: true });
  } catch (error) {
    state.refreshRequired = true;
    state.saving = false;
    renderAll();
    setFeedback(`记录已经删除，但列表未能刷新：${error.message || "请重新载入后继续。"}`, { error: true });
    $("#reload-workbench").focus({ preventScroll: true });
  }
}

async function clearBatch() {
  if (state.saving || state.outputBusy) return;
  if (state.refreshRequired) {
    setFeedback("本页需要重新载入最新记录后才能清空批次。", { error: true });
    return;
  }
  const summary = currentSummary();
  const batchRecords = currentSourceRecords();
  const count = batchRecords.length;
  if (!count) return;
  if (state.dirty && !window.confirm("当前表单尚未保存。继续清空会同时丢弃这些输入，是否继续？")) return;
  if (!window.confirm(`清空批次“${summary.batchId}”当前方案来源下的 ${count} 条人工过条记录？其他历史来源、当前方案、素材文件、投放结果和制作状态都不会被删除。此操作无法撤销。`)) return;
  state.saving = true;
  renderOverview(summary);
  renderSource();
  try {
    await state.repository.clearTakeReviewBatch(state.project.id, summary.batchId, {
      expectedPlanFingerprint: takeReviewPlanFingerprint(state.plan),
      expectedRecords: expectedRecordSet(batchRecords)
    });
  } catch (error) {
    setFeedback(error.message || "本批记录未能清空。", { error: true });
    state.saving = false;
    renderAll();
    $("#clear-take-reviews").focus({ preventScroll: true });
    return;
  }

  state.dirty = false;
  const currentPlanFingerprint = takeReviewPlanFingerprint(state.plan);
  state.records = state.records.filter((entry) => !(
    entry.source.batchId === summary.batchId && entry.source.planFingerprint === currentPlanFingerprint
  ));
  state.summary = null;
  resetForm();
  try {
    applyStoredContext(await readFreshContext(state.project.id));
    resetForm();
    state.saving = false;
    renderAll();
    setFeedback(`批次“${summary.batchId}”当前方案来源下的人工过条记录已清空；历史组未改变。`);
    $("#material-code").focus({ preventScroll: true });
  } catch (error) {
    state.refreshRequired = true;
    state.saving = false;
    renderAll();
    setFeedback(`批次记录已经清空，但列表未能刷新：${error.message || "请重新载入后继续。"}`, { error: true });
    $("#reload-workbench").focus({ preventScroll: true });
  }
}

async function exportHistoricalGroup(group) {
  if (state.dirty || state.saving || state.outputBusy || state.refreshRequired) {
    setFeedback("当前有未保存输入或页面尚未刷新，不能导出历史记录。", { error: true });
    return;
  }
  const expectedPlanFingerprint = takeReviewPlanFingerprint(state.plan);
  const expectedRecords = recordsForSource(state.records, group.batchId, group.planFingerprint);
  if (!expectedRecords.length) {
    setFeedback("目标历史记录组已不在当前页面，请重新载入。", { error: true });
    return;
  }
  const expectedRecordSnapshot = takeReviewRecordsSnapshot(expectedRecords);
  const mutationRevision = state.mutationRevision;
  state.outputBusy = true;
  renderAll();
  try {
    const fresh = await readFreshContext(state.project.id);
    const freshRecords = recordsForSource(fresh.records, group.batchId, group.planFingerprint);
    if (state.dirty || mutationRevision !== state.mutationRevision) {
      throw new Error("读取最新历史记录期间表单发生变化，本次没有导出；请先保存或重置。");
    }
    if (takeReviewPlanFingerprint(fresh.plan) !== expectedPlanFingerprint
      || takeReviewRecordsSnapshot(freshRecords) !== expectedRecordSnapshot) {
      state.refreshRequired = true;
      throw new Error("当前方案或目标历史记录组已在其他页面变化，请重新载入后再导出。");
    }
    const history = summarizeTakeReviewHistory({
      projectId: fresh.project.id,
      currentBatchId: fresh.plan.batchId,
      currentPlanFingerprint: expectedPlanFingerprint,
      records: fresh.records
    });
    if (!history.groups.some((entry) => entry.batchId === group.batchId && entry.planFingerprint === group.planFingerprint)) {
      state.refreshRequired = true;
      throw new Error("目标来源不再属于历史记录，请重新载入核对。");
    }
    downloadJson(`qianchuan-take-history-${safeFilePart(group.batchId)}-${group.planFingerprint.slice(-8)}-${new Date().toISOString().slice(0, 10)}.json`, {
      schemaVersion: 1,
      kind: "qianchuan-take-review-history",
      exportedAt: new Date().toISOString(),
      project: { id: fresh.project.id, name: fresh.project.name },
      source: { batchId: group.batchId, planFingerprint: group.planFingerprint },
      notice: "仅包含用户主动保存的结构化人工过条记录，不含视频、图片、音频或平台数据；本文件不会自动上传，仅供留档与人工检查，不支持单组一键回导。",
      records: freshRecords
    });
    setFeedback(`已导出历史组“${group.batchId}”的 ${freshRecords.length} 条人工记录；本地原记录仍保留。`);
  } catch (error) {
    setFeedback(error.message || "历史记录组未能导出。", { error: true });
  } finally {
    state.outputBusy = false;
    renderAll();
    if (state.refreshRequired) {
      $("#reload-workbench").focus();
    } else {
      $("#take-history-archive").open = true;
      const card = [...document.querySelectorAll("#history-batch-list .history-batch-card")]
        .find((entry) => entry.dataset.historyBatchId === group.batchId
          && entry.dataset.historyPlanFingerprint === group.planFingerprint);
      (card?.querySelector('[data-history-action="export"]') || $("#take-history-archive summary"))
        .focus({ preventScroll: true });
    }
  }
}

async function deleteHistoricalGroup(group) {
  if (state.dirty || state.saving || state.outputBusy || state.refreshRequired) {
    setFeedback("当前有未保存输入或页面尚未刷新，不能删除历史记录。", { error: true });
    return;
  }
  const records = recordsForSource(state.records, group.batchId, group.planFingerprint);
  if (!records.length) {
    setFeedback("目标历史记录组已不在当前页面，请重新载入。", { error: true });
    return;
  }
  if (!window.confirm(`准备删除历史组“${group.batchId}”的 ${records.length} 条人工记录。建议先导出本组 JSON；是否继续？`)) return;
  if (!window.confirm(`再次确认：永久删除“${group.batchId} · 来源 ${group.planFingerprint.slice(-8)}”的 ${records.length} 条记录？此操作无法撤销，且不会删除任何素材文件。`)) return;
  const expectedPlanFingerprint = takeReviewPlanFingerprint(state.plan);
  state.saving = true;
  renderAll();
  let deleted;
  try {
    deleted = await state.repository.deleteHistoricalTakeReviewGroup(state.project.id, {
      batchId: group.batchId,
      planFingerprint: group.planFingerprint
    }, {
      expectedPlanFingerprint,
      expectedRecords: expectedRecordSet(records)
    });
  } catch (error) {
    state.refreshRequired = true;
    state.saving = false;
    renderAll();
    setFeedback(error.message || "历史记录组未能删除；请重新载入核对。", { error: true });
    $("#reload-workbench").focus({ preventScroll: true });
    return;
  }
  try {
    applyStoredContext(await readFreshContext(state.project.id));
    state.saving = false;
    renderAll();
    $("#take-history-archive").open = true;
    setFeedback(`已删除历史组“${deleted.batchId}”的 ${deleted.deletedCount} 条人工记录并释放本地额度；当前来源和素材文件未改变。`);
    $("#take-history-archive summary").focus({ preventScroll: true });
  } catch (error) {
    state.refreshRequired = true;
    state.saving = false;
    renderAll();
    setFeedback(`历史记录已经删除，但列表未能刷新：${error.message || "请重新载入后继续。"}`, { error: true });
    $("#reload-workbench").focus({ preventScroll: true });
  }
}

async function reloadContext({ initial = false } = {}) {
  if (state.dirty && !initial) {
    setFeedback("检测到页面重新获得焦点，但当前表单尚未保存；为保护输入，暂未载入其他页面的变更。", { error: true });
    return;
  }
  const revision = ++state.loadRevision;
  const mutationRevision = state.mutationRevision;
  setText("#loading-state", "正在读取当前项目与批次记录…");
  $("#loading-state").hidden = false;
  $("#fatal-state").hidden = true;
  try {
    if (!state.repository) state.repository = createProjectRepository(await openProjectDatabase());
    const parameters = new URLSearchParams(location.search);
    const requestedProjectId = parameters.get("projectId") || "";
    let projectId = requestedProjectId;
    if (!projectId) {
      const current = await state.repository.currentProject();
      if (revision !== state.loadRevision) return;
      projectId = current?.id || "";
    }
    if (!projectId) throw new Error("当前没有可用项目，请从侧边栏选择项目后重新打开片场过条台。");
    const context = await readFreshContext(projectId);
    if (revision !== state.loadRevision) return;
    if (state.dirty || state.saving || state.outputBusy || mutationRevision !== state.mutationRevision) {
      $("#loading-state").hidden = true;
      setFeedback("重新载入期间表单开始编辑；为保护当前输入，本次没有覆盖页面。", { error: true });
      return;
    }
    const requestedTestId = parameters.get("testId") || "";
    applyStoredContext(context, { requestedTestId });
    resetForm();
    renderAll();
    $("#loading-state").hidden = true;
    $("#workbench").hidden = false;
    setFeedback(initial ? "片场过条记录已从当前浏览器载入。" : "已重新载入当前项目和其他页面保存的记录。");
  } catch (error) {
    if (revision !== state.loadRevision) return;
    $("#loading-state").hidden = true;
    $("#workbench").hidden = true;
    $("#fatal-state").hidden = false;
    setText("#fatal-message", error.message || "本地项目数据无法读取，请返回侧边栏重试。");
    $("#reload-workbench").focus({ preventScroll: true });
  }
}

$("#take-review-form").addEventListener("submit", saveRecord);
$("#take-review-form").addEventListener("input", (event) => {
  if (event.target.matches("input, textarea, select")) markDirty();
});
$("#take-review-form").addEventListener("change", (event) => {
  if (event.target.matches("select, [data-check-code]")) {
    syncConditionalFields();
    markDirty();
  }
});
$("#reset-take-review").addEventListener("click", () => {
  if (state.saving || state.outputBusy || state.refreshRequired) return;
  if (state.dirty && !window.confirm("重置会清空当前尚未保存的输入，是否继续？")) return;
  resetForm({ announce: true });
  renderAll();
  $("#material-code").focus();
});
$("#reload-workbench").addEventListener("click", () => {
  if (state.saving || state.outputBusy) return;
  if (state.dirty && !window.confirm("重新载入会丢弃当前尚未保存的输入，是否继续？")) return;
  state.dirty = false;
  void reloadContext();
});
$("#jump-next-follow-up").addEventListener("click", () => {
  if (state.saving || state.outputBusy || state.refreshRequired) return;
  const summary = currentSummary();
  const first = deriveTakeReviewFollowUps(summary)[0];
  if (first) {
    focusVersionForReview(first.testId, { followUpStatus: first.status });
    return;
  }
  if (summary.ready) {
    document.querySelector(".handoff-panel")?.scrollIntoView({ block: "start", behavior: "auto" });
    $("#copy-take-handoff").focus({ preventScroll: true });
  }
});
$("#copy-follow-up-sheet").addEventListener("click", async () => {
  if (state.dirty || state.saving || state.outputBusy || state.refreshRequired) {
    setFeedback("当前有未保存输入或页面尚未刷新，不能生成现场追拍单。", { error: true });
    return;
  }
  const mutationRevision = state.mutationRevision;
  const expectedPlanFingerprint = takeReviewPlanFingerprint(state.plan);
  const expectedRecordSnapshot = takeReviewRecordsSnapshot(state.records);
  state.outputBusy = true;
  renderAll();
  try {
    const fresh = await readFreshContext(state.project.id);
    if (state.dirty || mutationRevision !== state.mutationRevision) {
      throw new Error("读取最新记录期间表单发生变化，本次没有复制；请先保存或重置。");
    }
    if (takeReviewPlanFingerprint(fresh.plan) !== expectedPlanFingerprint
      || takeReviewRecordsSnapshot(fresh.records) !== expectedRecordSnapshot) {
      state.refreshRequired = true;
      throw new Error("当前方案或过条记录已在其他页面变化，请重新载入后再生成现场追拍单。");
    }
    const text = takeReviewFollowUpsToText({ projectName: fresh.project.name, summary: fresh.summary });
    await navigator.clipboard.writeText(text);
    setFeedback("现场追拍单已复制；内容来自当前方案结构与当前来源下已保存的人工记录，不代表系统检查了素材。");
  } catch (error) {
    setFeedback(error.message || "现场追拍单未能复制。", { error: true });
  } finally {
    state.outputBusy = false;
    renderAll();
    if (state.refreshRequired) $("#reload-workbench").focus();
  }
});
$("#copy-take-handoff").addEventListener("click", async () => {
  if (state.dirty || state.saving || state.outputBusy || state.refreshRequired) {
    setFeedback("当前有未保存输入或页面尚未刷新，不能生成接片单。", { error: true });
    return;
  }
  const mutationRevision = state.mutationRevision;
  const expectedRecordSnapshot = takeReviewRecordsSnapshot(state.records);
  state.outputBusy = true;
  renderAll();
  try {
    const expectedPlanFingerprint = takeReviewPlanFingerprint(state.plan);
    const fresh = await readFreshContext(state.project.id);
    if (state.dirty || mutationRevision !== state.mutationRevision) {
      throw new Error("读取最新记录期间表单发生变化，本次没有复制；请先保存或重置。");
    }
    if (takeReviewPlanFingerprint(fresh.plan) !== expectedPlanFingerprint
      || takeReviewRecordsSnapshot(fresh.records) !== expectedRecordSnapshot) {
      state.refreshRequired = true;
      throw new Error("当前方案或过条记录已在其他页面变化，请重新载入后再生成接片单。");
    }
    if (!fresh.summary.ready) {
      state.refreshRequired = true;
      renderAll();
      throw new Error("过条记录已在其他页面变化，本批当前不满足接片条件；请重新载入核对。");
    }
    const text = takeReviewBatchHandoffToText({ projectName: fresh.project.name, summary: fresh.summary });
    await navigator.clipboard.writeText(text);
    setFeedback(state.dirty || mutationRevision !== state.mutationRevision
      ? "点击时的已保存接片单已经复制；当前表单此后出现了未保存输入，请勿把该副本当作最新状态。"
      : "预填接片单已复制；首选与备选均来自人工明确指定，制作状态未改变。");
  } catch (error) {
    setFeedback(error.message || "接片单未能复制。", { error: true });
  } finally {
    state.outputBusy = false;
    renderAll();
    if (state.refreshRequired) $("#reload-workbench").focus();
  }
});
$("#export-take-reviews").addEventListener("click", async () => {
  if (state.dirty || state.saving || state.outputBusy || state.refreshRequired) {
    setFeedback("当前有未保存输入或页面尚未刷新，不能导出记录。", { error: true });
    return;
  }
  const mutationRevision = state.mutationRevision;
  const expectedRecordSnapshot = takeReviewRecordsSnapshot(state.records);
  state.outputBusy = true;
  renderAll();
  try {
    const expectedPlanFingerprint = takeReviewPlanFingerprint(state.plan);
    const fresh = await readFreshContext(state.project.id);
    if (state.dirty || mutationRevision !== state.mutationRevision) {
      throw new Error("读取最新记录期间表单发生变化，本次没有导出；请先保存或重置。");
    }
    if (takeReviewPlanFingerprint(fresh.plan) !== expectedPlanFingerprint
      || takeReviewRecordsSnapshot(fresh.records) !== expectedRecordSnapshot) {
      state.refreshRequired = true;
      throw new Error("当前方案或过条记录已在其他页面变化，请重新载入后再导出。");
    }
    const summary = fresh.summary;
    const currentPlanFingerprint = takeReviewPlanFingerprint(fresh.plan);
    const records = recordsForSource(fresh.records, summary.batchId, currentPlanFingerprint);
    downloadJson(`qianchuan-take-reviews-${safeFilePart(summary.batchId)}-${currentPlanFingerprint.slice(-8)}-${new Date().toISOString().slice(0, 10)}.json`, {
      schemaVersion: 1,
      kind: "qianchuan-take-review-current-source",
      exportedAt: new Date().toISOString(),
      project: { id: fresh.project.id, name: fresh.project.name },
      source: { batchId: summary.batchId, planFingerprint: currentPlanFingerprint },
      notice: "仅包含当前方案来源的人工过条文字记录，不含视频、图片或平台数据；不会自动读取或采集文件路径，仅供留档与人工检查。",
      records
    });
    setFeedback(`已导出当前来源的 ${records.length} 条人工过条记录；素材文件未被读取或复制。`);
  } catch (error) {
    setFeedback(error.message || "当前来源记录未能导出。", { error: true });
  } finally {
    state.outputBusy = false;
    renderAll();
    if (state.refreshRequired) $("#reload-workbench").focus();
  }
});
$("#clear-take-reviews").addEventListener("click", () => void clearBatch());
$("#take-history-archive").addEventListener("toggle", (event) => {
  if (event.currentTarget.open) {
    renderHistoryArchive();
  } else {
    $("#history-batch-list").replaceChildren();
  }
});
$("#history-batch-list").addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-history-action]");
  const card = button?.closest?.("[data-history-batch-id][data-history-plan-fingerprint]");
  if (!button || !card || state.saving || state.outputBusy || state.refreshRequired) return;
  const batchId = String(card.dataset.historyBatchId || "");
  const planFingerprint = String(card.dataset.historyPlanFingerprint || "");
  const history = summarizeTakeReviewHistory({
    projectId: state.project.id,
    currentBatchId: state.plan.batchId,
    currentPlanFingerprint: takeReviewPlanFingerprint(state.plan),
    records: state.records
  });
  const group = history.groups.find((entry) => entry.batchId === batchId && entry.planFingerprint === planFingerprint);
  if (!group) {
    setFeedback("目标历史记录组已变化，请重新载入后再操作。", { error: true });
    return;
  }
  if (button.dataset.historyAction === "export") void exportHistoricalGroup(group);
  if (button.dataset.historyAction === "delete") void deleteHistoricalGroup(group);
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty && !state.saving && !state.outputBusy) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.repository && !state.saving && !state.outputBusy) void reloadContext();
});
window.addEventListener("focus", () => {
  if (state.repository && !state.saving && !state.outputBusy) void reloadContext();
});

renderOwnerOptions();
void reloadContext({ initial: true });
