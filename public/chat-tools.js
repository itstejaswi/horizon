(() => {
  "use strict";

  const active = new Set();
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };

  async function json(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Local tool request failed (${response.status}).`);
    return data;
  }

  function delay(signal) {
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, 750);
      const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped.", "AbortError")); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function prepare(signal) {
    const config = await json("/api/chat-tools", { signal });
    const id = crypto.randomUUID();
    const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": config.csrfToken };
    const control = {
      id, headers, enabled: config.enabled, pending: false, cancellation: null,
      cancel() {
        if (control.cancellation) return control.cancellation;
        if (!control.pending) return Promise.resolve();
        control.cancellation = json("/api/agents/cancel-chat", {
          method: "POST", headers, body: JSON.stringify({ id }), keepalive: true
        }).then(() => { control.pending = false; });
        return control.cancellation;
      },
      finish() { control.pending = false; active.delete(control); },
      async follow(run, parent, signal, onStatus) {
        control.pending = true;
        active.add(control);
        const activity = node("details", "thinking chat-tool-activity");
        activity.open = true;
        const heading = node("summary", "", "Tool activity");
        const log = node("div", "chat-tool-log");
        const plan = node("div", "chat-tool-plan");
        const approval = node("section", "agent-approval");
        activity.append(heading, log, approval, plan);
        parent.append(activity);
        let signature = "";
        let planSignature = "";
        let approvalId = null;
        let approving = false;
        const paint = current => {
          heading.textContent = `Tool activity \u00b7 ${current.status.replaceAll("_", " ")}`;
          const progress = window.HorizonActivity.describe(current);
          onStatus(progress.label, progress.phase);
          const nextPlan = JSON.stringify([current.plan, current.verification]);
          if (planSignature !== nextPlan) {
            planSignature = nextPlan;
            plan.replaceChildren(window.HorizonActivity.planView(current));
          }
          const next = JSON.stringify(current.events);
          if (signature !== next) {
            signature = next;
            log.replaceChildren();
            for (const event of current.events || []) {
              const entry = node("div", "agent-event");
              entry.append(node("p", "field-hint", event.message));
              entry.append(node("div", "agent-muted", [event.type, event.tool].filter(Boolean).join(" · ")));
              if (event.args !== undefined) entry.append(node("pre", "agent-run-text", JSON.stringify(event.args, null, 2)));
              if (event.result !== undefined) entry.append(node("pre", "agent-run-text", typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2)));
              log.append(entry);
            }
          }
          if (approvalId !== (current.approval?.id || null)) {
            approvalId = current.approval?.id || null;
            approval.replaceChildren();
            approval.hidden = !approvalId;
            if (approvalId) {
              approval.append(node("strong", "", `Approval required: ${current.approval.tool}`));
              approval.append(node("pre", "agent-run-text", JSON.stringify(current.approval.args, null, 2)));
              const actions = node("div", "agent-form-actions");
              for (const [label, approve] of [["Deny", false], ["Approve", true]]) {
                const button = node("button", approve ? "btn-primary" : "btn-subtle is-danger", label);
                button.type = "button";
                button.addEventListener("click", async () => {
                  if (approving || signal.aborted) return;
                  approving = true;
                  for (const item of actions.children) item.disabled = true;
                  try {
                    await json("/api/agents/approve", {
                      method: "POST", headers, signal,
                      body: JSON.stringify({ id, approvalId: current.approval.id, approve })
                    });
                    approval.append(node("p", "field-hint", approve ? "Approved. Resuming..." : "Denied."));
                  } catch (error) {
                    if (!signal.aborted) {
                      approval.append(node("p", "is-error", error.message));
                      for (const item of actions.children) item.disabled = false;
                    }
                  } finally {
                    approving = false;
                  }
                });
                actions.append(button);
              }
              approval.append(actions);
            }
          }
        };
        try {
          for (;;) {
            signal.throwIfAborted();
            paint(run);
            if (terminal.has(run.status)) {
              control.finish();
              if (run.status !== "completed") {
                const stage = run.failure?.stage ? `Horizon Native (${run.failure.stage}): ` : "";
                throw new Error(stage + (run.error || `Conversation ${run.status}.`));
              }
              activity.open = false;
              return { reply: run.result, agentRunId: id };
            }
            await delay(signal);
            run = await json(`/api/agents/run?id=${encodeURIComponent(id)}`, { signal });
          }
        } finally {
          for (const button of approval.querySelectorAll("button")) button.disabled = true;
          if (control.pending) {
            try {
              await control.cancel();
              heading.textContent = "Tool activity \u00b7 cancellation requested";
            }
            catch (error) { onStatus(`Could not confirm tool cancellation: ${error.message}`); }
          }
          active.delete(control);
          window.dispatchEvent(new Event("horizon-agents-changed"));
        }
      }
    };
    active.add(control);
    return control;
  }

  window.addEventListener("pagehide", () => {
    for (const control of active) {
      control.cancel().catch(error => {
        window.dispatchEvent(new CustomEvent("horizon-tool-error", { detail: { message: `Could not confirm tool cancellation: ${error.message}` } }));
      });
    }
  });
  window.HorizonChatTools = { prepare };
})();
