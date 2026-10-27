(() => {
  "use strict";

  const tools = {
    file_list: ["reading", "Browsing files"],
    file_read: ["reading", "Reading a file"],
    file_search: ["reading", "Searching files"],
    file_write: ["writing", "Writing a file"],
    command_run: ["command", "Running a command"],
    browser_open: ["browsing", "Opening a page"],
    browser_snapshot: ["browsing", "Reading a page"],
    browser_click: ["browsing", "Using the browser"],
    browser_fill: ["browsing", "Filling a field"],
    browser_close: ["browsing", "Closing the browser"],
    mcp_list_tools: ["connecting", "Discovering MCP tools"],
    mcp_call_tool: ["connecting", "Calling an MCP tool"]
  };
  const labels = {
    thinking: "Thinking", answering: "Writing a reply", queued: "Queued",
    approval: "Waiting for your approval", completed: "Done", failed: "Failed",
    cancelled: "Stopped", interrupted: "Interrupted", skipped: "Skipped",
    stopping: "Cancellation requested", acting: "Using a tool",
    planning: "Planning native tasks", verifying: "Checking an outcome"
  };
  function describe(run) {
    if (run.status === "awaiting_approval") return { phase: "approval", label: labels.approval };
    if (run.status !== "running") return { phase: run.status, label: labels[run.status] || "Unknown state" };
    const last = run.events?.at(-1);
    if (last?.type === "planning" || last?.type === "plan") {
      return { phase: "planning", label: labels.planning };
    }
    if (last?.type === "verifying") return { phase: "verifying", label: labels.verifying };
    if (last?.type === "retry") return { phase: "reading", label: "Retrying a transient read-only failure" };
    if (last?.type === "verified") return { phase: "verifying", label: "Outcome check recorded" };
    if (last?.type === "step") return { phase: "acting", label: "Executing a planned step" };
    if (last?.type === "tool") {
      const [phase, label] = tools[last.tool] || ["acting", labels.acting];
      return { phase, label };
    }
    return { phase: "thinking", label: labels.thinking };
  }
  function create(phase = "thinking") {
    const element = document.createElement("span");
    element.className = "horizon-activity";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    const mark = document.createElement("span");
    mark.className = "activity-mark";
    mark.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) mark.append(document.createElement("i"));
    const text = document.createElement("span");
    text.className = "activity-label";
    element.append(mark, text);
    let current = null;
    return {
      element,
      set(next, label = labels[next] || next) {
        if (next === current && text.textContent === label) return;
        current = next;
        element.setAttribute("data-phase", next);
        text.textContent = label;
      },
      init() { this.set(phase); return this; }
    }.init();
  }
  function planView(run) {
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const view = node("section", "agent-plan");
    if (Array.isArray(run.plan?.steps)) {
      view.append(node("strong", "", `Native plan · ${run.plan.status || "unknown"}`));
      view.append(node("p", "agent-help", "A plan is not permission or approval. Checks only measure specified predicates, not the whole task's intent."));
      const steps = node("ol", "agent-plan-steps");
      for (const step of run.plan.steps) {
        const item = node("li", "agent-plan-step");
        item.append(node("strong", "", step.title || step.tool || "Planned step"));
        item.append(node("div", "agent-muted", `${step.tool || "Unknown tool"} · ${step.status || "pending"}`));
        const checkLabels = {
          pending: "Outcome check pending",
          passed: "Configured outcome check passed",
          failed: "Outcome check failed",
          not_configured: step.status === "completed"
            ? "Tool succeeded; no outcome check configured"
            : "No outcome check configured"
        };
        const interrupted = run.plan.status === "interrupted" || step.status === "interrupted";
        const checkLabel = interrupted && step.verification !== "passed"
          ? "Not verified — execution interrupted; no automatic resume"
          : checkLabels[step.verification] || "Outcome check status unavailable";
        item.append(node("div", "agent-plan-check", checkLabel));
        const detail = node("details", "agent-plan-detail");
        detail.append(node("summary", "", "Arguments and evidence"));
        detail.append(node("pre", "agent-run-text", JSON.stringify(step.args ?? {}, null, 2)));
        if (step.evidence !== undefined) detail.append(node("pre", "agent-run-text", String(step.evidence)));
        item.append(detail);
        steps.append(item);
      }
      view.append(steps);
    }
    if (run.verification) {
      const labels = {
        passed: "Verification: configured checks passed",
        partial: "Verification: partial — not every step has a passed check",
        not_configured: "Verification: no outcome checks configured"
      };
      view.append(node("strong", "agent-verification", labels[run.verification.status] || "Verification status unavailable"));
      if (run.verification.message) view.append(node("p", "agent-help", run.verification.message));
    }
    view.hidden = !run.plan && !run.verification;
    return view;
  }
  window.HorizonActivity = { create, describe, planView };
})();
