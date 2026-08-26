import { experimentDataHealth } from "./experiment-decision.js";

const PARENT_OUTCOME_LABELS = Object.freeze({ keep: "保留方案", continue: "继续测试" });
const WARNING_FOCUS_FIELDS = Object.freeze({ roi_mismatch: "roi", ctr_mismatch: "ctr", cvr_mismatch: "cvr" });

export function buildExperimentVersionActions(entry = {}) {
  const testId = String(entry?.version?.testId || "").trim();
  if (!testId) throw new Error("版本卡操作缺少测试编号");
  const warnings = Array.isArray(entry?.result?.qualityWarnings) ? entry.result.qualityWarnings : [];
  const decisionState = String(entry?.decisionState?.code || (entry?.version?.decision ? "current" : "missing"));
  const outcome = String(entry?.version?.decision?.outcome || "");
  const parentEligible = decisionState === "current" && Object.hasOwn(PARENT_OUTCOME_LABELS, outcome);
  return {
    testId,
    result: {
      label: !entry?.result ? "回填结果" : warnings.length ? "核对结果" : "更新结果",
      focusMetric: warnings.length ? WARNING_FOCUS_FIELDS[warnings[0]] || "roi" : "spend"
    },
    decision: {
      label: decisionState === "stale" ? "重新确认决策" : entry?.version?.decision ? "查看决策" : "记录决策",
      state: decisionState
    },
    parent: parentEligible ? {
      label: "设为下一轮父版本",
      outcome,
      outcomeLabel: PARENT_OUTCOME_LABELS[outcome]
    } : null
  };
}

function action(code, entry, values) {
  return {
    code,
    testId: entry?.version?.testId || null,
    filter: values.filter || "all",
    target: values.target || "none",
    focusMetric: values.focusMetric || "",
    title: values.title,
    description: values.description,
    actionLabel: values.actionLabel || ""
  };
}

export function recommendExperimentParent(timeline = []) {
  if (!Array.isArray(timeline)) throw new Error("父版本建议队列格式无效");
  const current = timeline.filter((entry) => entry?.decisionState?.code === "current" && Object.hasOwn(PARENT_OUTCOME_LABELS, entry?.version?.decision?.outcome));
  const entry = current.find((candidate) => candidate.version.decision.outcome === "keep")
    || current.find((candidate) => candidate.version.decision.outcome === "continue")
    || null;
  if (!entry) return null;
  return {
    testId: entry.version.testId,
    outcome: entry.version.decision.outcome,
    outcomeLabel: PARENT_OUTCOME_LABELS[entry.version.decision.outcome],
    decidedAt: entry.version.decision.decidedAt || null,
    source: "current_manual_decision"
  };
}

export function buildExperimentNextAction(timeline = []) {
  if (!Array.isArray(timeline)) throw new Error("实验行动队列格式无效");
  if (!timeline.length) {
    return action("empty", null, {
      title: "先生成一个测试版本",
      description: "生成下一版任务后，系统才会建立可回填、可复核的实验记录。"
    });
  }

  const stale = timeline.find((entry) => entry?.decisionState?.code === "stale");
  if (stale) {
    return action("decision_stale", stale, {
      filter: "decision_stale",
      target: "decision",
      title: "重新确认已失效的人工决策",
      description: `${stale.version.testId} 的结果、阈值或版本内容已经变化；旧结论仅供审计。`,
      actionLabel: "去重新确认"
    });
  }

  const warning = timeline.find((entry) => entry?.decisionState?.code !== "current" && entry?.result?.qualityWarnings?.length);
  if (warning) {
    const warningField = WARNING_FOCUS_FIELDS[warning.result.qualityWarnings[0]] || "roi";
    return action("quality_warning", warning, {
      filter: "quality_warning",
      target: "manual_result",
      focusMetric: warningField,
      title: "先核对指标口径提醒",
      description: `${warning.version.testId} 存在 ${warning.result.qualityWarnings.length} 条口径提醒；请核对后再记录结论。`,
      actionLabel: "核对并更新结果"
    });
  }

  const readyForDecision = timeline.find((entry) => entry?.decisionState?.code === "missing" && experimentDataHealth({ result: entry.result, evaluation: entry.evaluation }).ready);
  if (readyForDecision) {
    return action("decision_ready", readyForDecision, {
      filter: "decision_missing",
      target: "decision",
      title: "记录一条人工实验决策",
      description: `${readyForDecision.version.testId} 已达到可复核状态；请结合主指标、护栏指标和业务风险填写结论。`,
      actionLabel: "去记录决策"
    });
  }

  const metricMissing = timeline.find((entry) => entry?.decisionState?.code !== "current" && entry?.evaluation?.code === "metric_missing");
  if (metricMissing) {
    return action("metric_missing", metricMissing, {
      filter: "needs_review",
      target: "manual_result",
      focusMetric: "roi",
      title: "补齐用于判断的 ROI",
      description: `${metricMissing.version.testId} 已有消耗，但缺少 ROI 或可推导 ROI 的成交金额。`,
      actionLabel: "补充结果"
    });
  }

  const pending = timeline.find((entry) => entry?.decisionState?.code !== "current" && entry?.evaluation?.code === "pending");
  if (pending) {
    return action("result_pending", pending, {
      filter: "pending",
      target: "manual_result",
      focusMetric: "spend",
      title: "回填最新上线结果",
      description: `${pending.version.testId} 还没有结果；可直接手动回填一条，也可以继续导入 CSV / TSV。`,
      actionLabel: "快速回填"
    });
  }

  const insufficient = timeline.find((entry) => entry?.decisionState?.code !== "current" && entry?.evaluation?.code === "insufficient");
  if (insufficient) {
    return action("insufficient", insufficient, {
      filter: "insufficient",
      target: "manual_result",
      focusMetric: "spend",
      title: "样本仍未达到最低消耗",
      description: `${insufficient.version.testId} 暂不适合做结论；有新结果时再更新，避免提前宣布胜负。`,
      actionLabel: "更新最新结果"
    });
  }

  const recommendedParent = recommendExperimentParent(timeline);
  if (recommendedParent) {
    const entry = timeline.find((candidate) => candidate?.version?.testId === recommendedParent.testId);
    return action("next_round_ready", entry, {
      filter: "decision_current",
      target: "parent",
      title: "准备下一轮单变量测试",
      description: `${recommendedParent.testId} 来自你已确认的“${recommendedParent.outcomeLabel}”结论；选择后仍需人工检查并点击生成。`,
      actionLabel: "设为下一轮起点"
    });
  }

  return action("complete_stopped", timeline[0], {
    filter: "decision_current",
    target: "timeline",
    title: "当前版本均已有人工结论",
    description: "没有可推荐的延续版本；已标记停止的版本不会被自动作为下一轮起点。",
    actionLabel: "查看有效决策"
  });
}
