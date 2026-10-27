/* global */
(() => {
  "use strict";

  const TOOL_NAMES = [
    "file_list", "file_read", "file_search", "file_write",
    "command_run", "browser_open", "browser_snapshot", "browser_click",
    "browser_fill", "browser_close", "mcp_list_tools", "mcp_call_tool"
  ];
  const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);
  const $ = id => document.getElementById(id);
  const modal = $("agents-modal");
  const dialog = modal.querySelector('[role="dialog"]');
  const content = $("agents-content");
  const openButton = $("agents-btn");
  const closeButton = $("agents-close");
  const state = {
    open: false, tab: "agents", token: "", agents: [], runs: [],
    settings: null, pollTimer: null, polling: false, previousFocus: null,
    selectedAgent: null
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(label, className, action, attrs = {}) {
    const element = node("button", className, label);
    element.type = "button";
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "disabled") element.disabled = Boolean(value);
      else element.setAttribute(key, value);
    }
    if (action) element.addEventListener("click", action);
    return element;
  }

  function field(labelText, control, helpText) {
    const wrap = node("label", "agent-field");
    wrap.append(node("span", "agent-label", labelText), control);
    if (helpText) wrap.append(node("span", "agent-help", helpText));
    return wrap;
  }

  function input(value, attrs = {}) {
    const element = node("input", "agent-input");
    element.value = value || "";
    for (const [key, val] of Object.entries(attrs)) element.setAttribute(key, String(val));
    return element;
  }

  function textarea(value, attrs = {}) {
    const element = node("textarea", "agent-input agent-textarea");
    element.value = value || "";
    for (const [key, val] of Object.entries(attrs)) element.setAttribute(key, String(val));
    return element;
  }

  function checkbox(labelText, checked, onChange, helpText) {
    const wrap = node("label", "agent-check");
    const control = node("input");
    control.type = "checkbox";
    control.checked = Boolean(checked);
    control.addEventListener("change", () => onChange(control.checked));
    wrap.append(control, node("span", "", labelText));
    if (helpText) wrap.append(node("small", "", helpText));
    return wrap;
  }

  function showError(message) {
    let notice = $("agents-error");
    if (!notice) {
      notice = node("div", "agent-error");
      notice.id = "agents-error";
      notice.setAttribute("role", "alert");
      content.prepend(notice);
    }
    notice.textContent = message;
  }

  function clearError() {
    const notice = $("agents-error");
    if (notice) notice.remove();
  }

  function notifyAgentsChanged() {
    window.dispatchEvent(new Event("horizon-agents-changed"));
  }

  async function request(url, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-Horizon-Agent-Token"] = state.token;
    }
    let response;
    try {
      response = await fetch(url, { ...options, headers, cache: "no-store" });
    } catch (error) {
      throw new Error(`Could not reach the local Horizon server: ${error.message}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`The server returned an unreadable response (${response.status}).`);
    }
    if (!response.ok) throw new Error(data.error || `The request failed (${response.status}).`);
    return data;
  }

  async function refreshData() {
    const data = await request("/api/agents");
    if (!data || !data.settings || !Array.isArray(data.agents) || !Array.isArray(data.runs)) {
      throw new Error("The Agents API returned data in an unexpected format.");
    }
    state.token = data.csrfToken || "";
    state.settings = data.settings;
    state.agents = data.agents;
    state.runs = data.runs;
    const schedulerNotice = data.schedulerError ? `Agent scheduler error: ${data.schedulerError}` : "";
    let notice = $("agents-scheduler-warning");
    if (schedulerNotice) {
      if (!notice) {
        notice = node("div", "agent-warning");
        notice.id = "agents-scheduler-warning";
        notice.setAttribute("role", "alert");
        content.prepend(notice);
      }
      notice.textContent = schedulerNotice;
    } else if (notice) {
      notice.remove();
    }
    renderAgentList();
    renderRuns();
  }

  function formatTimestamp(value) {
    if (value === null || value === undefined || value === "") return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function ensurePanel() {
    content.replaceChildren();
    const tabs = node("div", "agent-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Agents sections");
    const agentsTab = button("Agents", "agent-tab", () => switchTab("agents"), {
      role: "tab", id: "agents-tab", "aria-controls": "agents-pane"
    });
    const settingsTab = button("Settings", "agent-tab", () => switchTab("settings"), {
      role: "tab", id: "agent-settings-tab", "aria-controls": "agent-settings-pane"
    });
    tabs.append(agentsTab, settingsTab);
    content.append(tabs);

    const agentsPane = node("section", "agent-pane");
    agentsPane.id = "agents-pane";
    agentsPane.setAttribute("role", "tabpanel");
    agentsPane.setAttribute("aria-labelledby", "agents-tab");
    const agentsLayout = node("div", "agent-layout");
    const listPane = node("section", "agent-list-pane");
    listPane.append(node("div", "agent-section-head", "Your agents"));
    const listControls = node("div", "agent-list-controls");
    listControls.append(
      button("New agent", "btn-primary", () => editAgent(null)),
      button("Stop all", "btn-subtle is-danger", stopAll)
    );
    listPane.append(listControls);
    const agentList = node("div", "agent-list");
    agentList.id = "agent-list";
    listPane.append(agentList);
    const editorPane = node("section", "agent-editor-pane");
    editorPane.id = "agent-editor";
    agentsLayout.append(listPane, editorPane);
    const runsPane = node("section", "agent-runs-pane");
    runsPane.append(node("div", "agent-section-head", "Recent runs"));
    const runs = node("div", "agent-runs");
    runs.id = "agent-runs";
    runsPane.append(runs);
    agentsPane.append(agentsLayout, runsPane);

    const settingsPane = node("section", "agent-pane");
    settingsPane.id = "agent-settings-pane";
    settingsPane.setAttribute("role", "tabpanel");
    settingsPane.setAttribute("aria-labelledby", "agent-settings-tab");
    const form = node("form", "agent-settings-form");
    settingsPane.append(form);
    content.append(agentsPane, settingsPane);
    content.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!event.target.matches('[role="tab"]')) return;
      event.preventDefault();
      const next = event.target.id === "agents-tab" ? "settings" : "agents";
      switchTab(next);
      $(next === "agents" ? "agents-tab" : "agent-settings-tab").focus();
    });
    switchTab(state.tab);
    renderAgentList();
    renderRuns();
    renderEditor();
  }

  function switchTab(tab) {
    state.tab = tab;
    const agentsTab = $("agents-tab");
    const settingsTab = $("agent-settings-tab");
    const agentsPane = $("agents-pane");
    const settingsPane = $("agent-settings-pane");
    if (!agentsTab || !settingsTab || !agentsPane || !settingsPane) return;
    agentsTab.setAttribute("aria-selected", String(tab === "agents"));
    settingsTab.setAttribute("aria-selected", String(tab === "settings"));
    agentsTab.tabIndex = tab === "agents" ? 0 : -1;
    settingsTab.tabIndex = tab === "settings" ? 0 : -1;
    agentsPane.hidden = tab !== "agents";
    settingsPane.hidden = tab !== "settings";
    if (tab === "settings") renderSettingsForm();
  }

  function renderAgentList() {
    const list = $("agent-list");
    if (!list) return;
    const signature = JSON.stringify([state.agents, Boolean(state.settings?.enabled)]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    if (!state.agents.length) {
      list.append(node("p", "agent-empty", "No agents yet. Create one to get started."));
      return;
    }
    for (const agent of state.agents) {
      const card = node("article", "agent-card");
      const detail = node("div", "agent-card-detail");
      detail.append(node("strong", "", agent.name || "Untitled agent"));
      detail.append(node("span", "agent-muted", agent.schedule && agent.schedule.enabled
        ? `Scheduled · every ${agent.schedule.intervalMinutes || 60} minutes`
        : "Manual"));
      const nextRunAt = agent.nextRunAt || agent.schedule?.nextRunAt;
      if (agent.schedule?.enabled && nextRunAt) {
        detail.append(node("span", "agent-muted", `Next run: ${formatTimestamp(nextRunAt)}`));
      }
      const actions = node("div", "agent-card-actions");
      actions.append(
        button("Run", "btn-subtle", () => runAgent(agent.id), {
          "aria-label": `Run ${agent.name || "agent"}`,
          title: state.settings?.enabled ? "Run this agent" : "Enable agent execution in Settings first",
          disabled: !state.settings?.enabled
        }),
        button("Edit", "btn-subtle", () => editAgent(agent), { "aria-label": `Edit ${agent.name || "agent"}` }),
        button("Delete", "btn-subtle is-danger", () => deleteAgent(agent), { "aria-label": `Delete ${agent.name || "agent"}` })
      );
      card.append(detail, actions);
      list.append(card);
    }
  }

  function renderEditor() {
    const pane = $("agent-editor");
    if (!pane) return;
    pane.replaceChildren();
    const agent = state.selectedAgent;
    pane.append(node("div", "agent-section-head", agent ? "Edit agent" : "Create an agent"));
    const form = node("form", "agent-form");
    const name = input(agent?.name || "", { required: true, maxlength: 120, "aria-label": "Agent name" });
    name.name = "name";
    const instructions = textarea(agent?.instructions || "", { rows: 3, "aria-label": "Instructions" });
    instructions.name = "instructions";
    const prompt = textarea(agent?.prompt || "", { rows: 3, "aria-label": "Default prompt" });
    prompt.name = "prompt";
    const protocol = node("select", "agent-input");
    for (const [value, label] of [["structured", "Structured actions"], ["native", "Native tool calls"]]) {
      const option = node("option", "", label);
      option.value = value;
      protocol.append(option);
    }
    protocol.value = agent?.protocol === "native" ? "native" : "structured";
    protocol.setAttribute("aria-label", "Tool protocol");
    const maxSteps = input(agent?.maxSteps ?? 8, { type: "number", min: 1, max: 32, "aria-label": "Maximum steps" });
    const timeout = input(agent?.timeoutMs ?? 300000, { type: "number", min: 1000, max: 1800000, "aria-label": "Timeout in milliseconds" });
    const tools = textarea(JSON.stringify(agent?.tools || ["file_list", "file_read", "file_search"], null, 2), { rows: 4, "aria-label": "Allowed tools JSON" });
    const unattended = textarea(JSON.stringify(agent?.unattendedTools || [], null, 2), { rows: 3, "aria-label": "Unattended tools JSON" });
    const steps = textarea(JSON.stringify(agent?.steps || [], null, 2), { rows: 5, "aria-label": "Fixed workflow steps JSON" });
    const stepExamples = node("details", "agent-examples");
    const examplesSummary = node("summary", "", "View fixed-step examples and argument shapes");
    const examplesText = node("pre", "agent-run-text");
    examplesText.textContent = [
      "Each item has a tool name and an args object. Example (path must be absolute and under an approved root):",
      JSON.stringify([{ tool: "file_list", args: { path: "C:\\Users\\you\\Documents" } }], null, 2),
      "",
      "Other argument shapes:",
      JSON.stringify([
        { tool: "file_read", args: { path: "C:\\Users\\you\\Documents\\notes.txt" } },
        { tool: "file_search", args: { path: "C:\\Users\\you\\Documents", query: "meeting", limit: 20 } },
        { tool: "command_run", args: { commandId: "configured-command-id" } },
        { tool: "browser_open", args: { url: "https://example.com" } },
        { tool: "browser_click", args: { selector: "button.submit" } },
        { tool: "browser_fill", args: { selector: "input[name=q]", value: "search words" } },
        { tool: "mcp_list_tools", args: { serverId: "configured-server-id" } },
        { tool: "mcp_call_tool", args: { serverId: "configured-server-id", toolName: "tool-name", arguments: {} } }
      ], null, 2),
      "Each step must name a tool in Allowed tools. Steps run in order; args are passed as written. A fixed workflow does not use model inference to choose its next action."
    ].join("\n");
    stepExamples.append(examplesSummary, examplesText);
    const scheduleEnabled = node("input");
    scheduleEnabled.type = "checkbox";
    scheduleEnabled.checked = Boolean(agent?.schedule?.enabled);
    scheduleEnabled.setAttribute("aria-label", "Enable recurring schedule");
    const interval = input(agent?.schedule?.intervalMinutes ?? 60, {
      type: "number", min: 1, max: 525600, "aria-label": "Schedule interval in minutes"
    });
    const override = textarea("", { rows: 2, "aria-label": "Optional one-time prompt override" });
    const scheduleToggle = node("label", "agent-check");
    scheduleToggle.append(scheduleEnabled, node("span", "", "Enable recurring schedule"));
    const stepsHelp = "When steps are provided they run deterministically in order; an empty list uses model-driven actions.";
    form.append(
      field("Name", name),
      field("Instructions", instructions, "Guidance for this agent."),
      field("Default prompt", prompt, "The task prompt used for scheduled runs and runs without an override."),
      field("Protocol", protocol, "Model support varies; structured and native calls are not equally reliable across models."),
      field("Maximum steps", maxSteps),
      field("Timeout (ms)", timeout),
      field("Allowed tools JSON", tools, `Tool names: ${TOOL_NAMES.join(", ")}. Default capabilities are read-only file tools.`),
      field("Unattended tools JSON", unattended, "Explicitly grants listed tools to run without approval. Use only for tools you trust."),
      field("Fixed workflow steps JSON", steps, stepsHelp),
      stepExamples,
      scheduleToggle,
      field("Schedule interval (minutes)", interval, "Persistent interval schedule. Scheduled agents need a default prompt or fixed workflow steps. Missed runs are skipped; overlaps are skipped; interrupted runs are not resumed."),
      field("Run prompt override", override, "Optional prompt for this manual run only."),
      node("p", "agent-help", "Up to 32 workflow steps, with no more steps than the maximum-step limit. Schedules use server-computed next-run times and run only while the server and computer are awake."),
      node("div", "agent-form-actions")
    );
    const actions = form.lastElementChild;
    if (agent?.id) actions.append(button("Run now", "btn-subtle", () => runAgent(agent.id, override.value)));
    actions.append(button("Save agent", "btn-primary", null, { type: "submit" }));
    form.addEventListener("submit", event => {
      event.preventDefault();
      saveAgent(event, { agent, name, instructions, prompt, protocol, maxSteps, timeout, tools, unattended, steps, scheduleEnabled, interval });
    });
    pane.append(form);
  }

  function editAgent(agent) {
    state.selectedAgent = agent ? { ...agent } : null;
    renderEditor();
    const first = $("agent-editor").querySelector("input");
    if (first) first.focus();
  }

  async function saveAgent(event, formState) {
    event.preventDefault();
    if (!formState) return;
    clearError();
    try {
      const parseArray = (control, label) => {
        let value;
        try { value = JSON.parse(control.value || "[]"); }
        catch { throw new Error(`${label} must be valid JSON.`); }
        if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
        return value;
      };
      const body = {
        ...(formState.agent?.id ? { id: formState.agent.id } : {}),
        name: formState.name.value.trim(),
        instructions: formState.instructions.value,
        prompt: formState.prompt.value,
        tools: parseArray(formState.tools, "Allowed tools"),
        unattendedTools: parseArray(formState.unattended, "Unattended tools"),
        protocol: formState.protocol.value,
        maxSteps: Number(formState.maxSteps.value),
        timeoutMs: Number(formState.timeout.value),
        steps: parseArray(formState.steps, "Fixed workflow steps"),
        schedule: { enabled: formState.scheduleEnabled.checked, intervalMinutes: Number(formState.interval.value) }
      };
      const result = await request("/api/agents/save", { method: "POST", body: JSON.stringify(body) });
      const savedAgent = result.agent || result;
      if (!savedAgent || !savedAgent.id) throw new Error("The server did not return the saved agent.");
      notifyAgentsChanged();
      state.selectedAgent = { ...savedAgent };
      await refreshData();
      renderEditor();
    } catch (error) {
      showError(error.message);
    }
  }

  async function runAgent(agentId, override = "") {
    clearError();
    try {
      await request("/api/agents/run", {
        method: "POST",
        body: JSON.stringify({ agentId, ...(override.trim() ? { prompt: override.trim() } : {}) })
      });
      notifyAgentsChanged();
      await refreshData();
      startPolling();
    } catch (error) {
      showError(error.message);
    }
  }

  async function deleteAgent(agent) {
    if (!window.confirm(`Delete "${agent.name || "this agent"}"?`)) return;
    clearError();
    try {
      await request("/api/agents/delete", { method: "POST", body: JSON.stringify({ id: agent.id }) });
      notifyAgentsChanged();
      if (state.selectedAgent?.id === agent.id) editAgent(null);
      await refreshData();
    } catch (error) {
      showError(error.message);
    }
  }

  async function cancelRun(id) {
    clearError();
    try {
      await request("/api/agents/cancel", { method: "POST", body: JSON.stringify({ id }) });
      notifyAgentsChanged();
      await refreshData();
    } catch (error) {
      showError(error.message);
    }
  }

  async function decideApproval(runId, approvalId, approve) {
    clearError();
    try {
      await request("/api/agents/approve", {
        method: "POST",
        body: JSON.stringify({ id: runId, approvalId, approve })
      });
      notifyAgentsChanged();
      await refreshData();
      startPolling();
    } catch (error) {
      showError(error.message);
    }
  }

  async function stopAll() {
    if (!window.confirm("Cancel all agent runs and disable agent execution?")) return;
    clearError();
    try {
      await request("/api/agents/stop", { method: "POST", body: "{}" });
      notifyAgentsChanged();
      await refreshData();
      renderSettingsForm();
    } catch (error) {
      showError(error.message);
    }
  }

  function runStatus(run) {
    const safeStatus = /^[a-z_]+$/.test(run.status || "") ? run.status : "unknown";
    const status = node("span", `agent-status status-${safeStatus}`);
    const progress = window.HorizonActivity.describe(run);
    const activity = window.HorizonActivity.create();
    activity.set(progress.phase, progress.label);
    status.append(activity.element);
    return status;
  }

  function renderRuns() {
    const list = $("agent-runs");
    if (!list) return;
    const signature = JSON.stringify(state.runs);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    if (!state.runs.length) {
      list.append(node("p", "agent-empty", "No runs recorded."));
      return;
    }
    for (const run of state.runs) {
      const card = node("article", "agent-run-card");
      const top = node("div", "agent-run-top");
      top.append(node("strong", "", run.agentName || "Agent run"), runStatus(run));
      const metadata = [run.source, formatTimestamp(run.createdAt)].filter(Boolean).join(" · ");
      card.append(top);
      if (metadata) card.append(node("div", "agent-muted", metadata));
      if (run.status === "skipped") {
        card.append(node("div", "agent-muted", "This scheduled occurrence was skipped (missed after wake or overlapped another run); it will not be replayed."));
      }
      if (run.nextRunAt) card.append(node("div", "agent-muted", `Next run: ${formatTimestamp(run.nextRunAt)}`));
      card.append(window.HorizonActivity.planView(run));
      if (run.result) card.append(node("pre", "agent-run-text", typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2)));
      if (run.error) card.append(node("pre", "agent-run-text is-error", typeof run.error === "string" ? run.error : JSON.stringify(run.error, null, 2)));
      if (Array.isArray(run.events) && run.events.length) {
        const details = node("details", "agent-events");
        details.append(node("summary", "", `Activity (${run.events.length})`));
        for (const item of run.events) {
          const entry = node("div", "agent-event");
          const label = [formatTimestamp(item.at), item.type, item.tool].filter(Boolean).join(" · ");
          if (label) entry.append(node("div", "agent-muted", label));
          entry.append(node("div", "", item.message || ""));
          if (item.args !== undefined) entry.append(node("pre", "agent-run-text", JSON.stringify(item.args, null, 2)));
          if (item.result !== undefined) entry.append(node("pre", "agent-run-text", typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)));
          details.append(entry);
        }
        card.append(details);
      }
      if (run.status === "awaiting_approval" && run.approval) {
        const approval = node("section", "agent-approval");
        approval.append(node("strong", "", `Approval required: ${run.approval.tool || "tool"}`));
        approval.append(node("pre", "agent-run-text", JSON.stringify(run.approval.args ?? null, null, 2)));
        const actions = node("div", "agent-form-actions");
        actions.append(
          button("Deny", "btn-subtle is-danger", () => decideApproval(run.id, run.approval.id, false)),
          button("Approve", "btn-primary", () => decideApproval(run.id, run.approval.id, true))
        );
        approval.append(actions);
        card.append(approval);
      } else if (ACTIVE.has(run.status)) {
        card.append(button("Cancel run", "btn-subtle is-danger", () => cancelRun(run.id)));
      }
      list.append(card);
    }
  }

  function renderSettingsForm() {
    const form = content.querySelector(".agent-settings-form");
    if (!form || !state.settings) return;
    form.replaceChildren();
    const settings = state.settings;
    form.append(node("div", "agent-section-head", "Execution and tool access"));
    const executionEnabled = checkbox("Enable agent execution", settings.enabled, value => { settings.enabled = value; },
      "Master switch. Stop all cancels current runs and turns this off.");
    executionEnabled.querySelector("input").name = "executionEnabled";
    form.append(executionEnabled);
    const planning = checkbox("Plan and verify native tasks", settings.planning === true, value => { settings.planning = value; },
      "Experimental and model-dependent. Off by default: keeps the existing lightweight loop. Adds local inference to plan model-driven native-engine agents and conversations before execution, then checks configured outcomes. Small models may misformat valid tasks or ask unnecessary clarification; the engine stops and reports errors rather than relaxing checks. Fixed workflows remain the predictable option. A plan does not grant permission or replace approval; passing checks is not proof of the whole task's intent.");
    planning.querySelector("input").name = "planning";
    form.append(planning);
    const flags = node("div", "agent-settings-flags");
    for (const [key, label] of [
      ["files", "File tools"], ["commands", "Command tools"], ["browser", "Browser tools"], ["mcp", "MCP tools"]
    ]) {
      const flag = checkbox(`Enable ${label.toLowerCase()}`, settings.flags?.[key], value => {
        settings.flags = { ...settings.flags, [key]: value };
      });
      flag.querySelector("input").name = `flag-${key}`;
      flags.append(flag);
    }
    form.append(flags);
    const chat = settings.chat;
    form.append(node("div", "agent-section-head", "Tools in the normal conversation"));
    const conversation = checkbox("Let ordinary chat prompts use tools", chat.enabled, value => { chat.enabled = value; },
      "No separate agent is needed. With the master switch and a tool feature enabled, the model can request permitted tools from any normal prompt, including dictated text. File reads use your folder grant; all other calls need an in-chat approval.");
    conversation.querySelector("input").name = "chatEnabled";
    form.append(conversation);
    const protocol = node("select", "agent-input");
    protocol.name = "chatProtocol";
    for (const [value, label] of [["structured", "Structured actions"], ["native", "Native tool calls"]]) {
      const option = node("option", "", label);
      option.value = value;
      protocol.append(option);
    }
    protocol.value = chat.protocol;
    form.append(field("Conversation tool protocol", protocol, "Choose a protocol the selected model can follow. Ordinary text chat stays unchanged when conversation tools are off."));
    const chatTools = node("fieldset", "agent-settings-flags");
    chatTools.append(node("legend", "", "Tools ordinary prompts may request"));
    for (const name of TOOL_NAMES) {
      const permitted = checkbox(name, chat.tools.includes(name), () => {});
      permitted.querySelector("input").name = "chatTool";
      permitted.querySelector("input").value = name;
      chatTools.append(permitted);
    }
    form.append(chatTools);
    form.append(field("Conversation maximum tool steps", input(chat.maxSteps, { name: "chatMaxSteps", type: "number", min: 1, max: 32 })));
    form.append(field("Conversation timeout (ms)", input(chat.timeoutMs, { name: "chatTimeout", type: "number", min: 1000, max: 1800000 }),
      "Includes time waiting for approvals. Conversation tools never inherit a saved agent's unattended permissions."));
    const roots = textarea((settings.roots || []).join("\n"), { name: "roots", rows: 4, "aria-label": "Approved absolute file roots, one per line" });
    form.append(field("Approved absolute file roots", roots, "One absolute directory per line. These roots are not a sandbox for commands, MCP, or browser access."));
    const commands = textarea(JSON.stringify(settings.commands || [], null, 2), { name: "commands", rows: 7, "aria-label": "Configured fixed commands JSON" });
    form.append(field("Configured fixed commands JSON", commands, 'Each item: {"id":"…","executable":"absolute path","args":["fixed argument"],"cwd":"absolute path"}. The working directory must exist under an approved root. This is not a sandbox: only configure trusted executables; commands can have unrestricted effects.'));
    const servers = textarea(JSON.stringify(settings.mcpServers || [], null, 2), { name: "servers", rows: 7, "aria-label": "Configured MCP servers JSON" });
    form.append(field("Configured MCP servers JSON", servers, 'Each item: {"id":"…","command":"absolute path","args":["fixed argument"],"cwd":"absolute path"}. The working directory must exist under an approved root. This is not a sandbox: only configure trusted servers; MCP effects may be unrestricted.'));
    const risk = node("aside", "agent-risk");
    risk.append(
      node("strong", "", "Review access before enabling tools"),
      node("p", "", "Enabling a feature does not grant every capability. Choose tools explicitly for each agent. Unattended tools are an explicit permission grant. File roots do not sandbox commands, MCP, or browser actions. Browser sessions use a fresh isolated context, public HTTPS only, and are online; they do not use personal browser sign-ins.")
    );
    risk.append(node("p", "", "Tool-enabled runs still use local model inference, but browser, command, or MCP tools can use the network: tool-enabled use is not an air-gap guarantee. The activity indicators distinguish inference from network-capable tools, but cannot record every network request a command or MCP subprocess makes. Schedules persist on the server and only run while it and the computer are awake. Missed occurrences (including one more than 30 seconds late after wake) and overlapping runs are skipped; interrupted runs are not resumed. Run history is bounded to 100 runs / 16 MB, with up to 150 events per run; tool results are capped at 12,000 characters. Agent context is limited to 64,000 serialized JSON characters, not tokens; the model's own token context limit also applies. No cloud API key, token billing, or guarantee of model reliability is provided."));
    risk.append(node("p", "", "The browser dependency is installed during one-time Horizon setup. MCP servers are separate programs; install and maintain each configured MCP executable yourself."));
    form.append(risk);
    const actions = node("div", "agent-form-actions");
    actions.append(button("Save settings", "btn-primary", null, { type: "submit" }));
    form.append(actions);
    const eraseSection = node("section", "agent-erase-section");
    eraseSection.append(
      node("strong", "", "Erase agent data"),
      node("p", "", "Permanently deletes saved agent definitions, settings, permissions, and run history, and cancels active work. Files agents created and external effects are not undone. This is separate from the browser-only data eraser.")
    );
    eraseSection.append(button("Erase agent data", "btn-subtle is-danger", eraseAgentData));
    form.append(eraseSection);
    form.onsubmit = saveSettings;
  }

  async function eraseAgentData() {
    const confirmed = window.confirm(
      "Permanently erase all agent definitions, settings, permissions, and run history, cancel active work, and disable agent execution? Files created by agents and external effects will not be undone."
    );
    if (!confirmed) return;
    clearError();
    try {
      const result = await request("/api/agents/erase", { method: "POST", body: "{}" });
      if (!result.erased) throw new Error("The server did not confirm that agent data was erased.");
      notifyAgentsChanged();
      state.selectedAgent = null;
      state.tab = "settings";
      await refreshData();
      renderEditor();
      renderSettingsForm();
    } catch (error) {
      showError(error.message);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    clearError();
    const form = content.querySelector(".agent-settings-form");
    const rootsField = form.querySelector('[name="roots"]');
    const commandsField = form.querySelector('[name="commands"]');
    const serversField = form.querySelector('[name="servers"]');
    try {
      const parseList = (control, label) => {
        let value;
        try { value = JSON.parse(control.value || "[]"); }
        catch { throw new Error(`${label} must be valid JSON.`); }
        if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
        return value;
      };
      const settings = {
        backend: state.settings.backend || "native",
        enabled: form.querySelector('[name="executionEnabled"]').checked,
        planning: form.querySelector('[name="planning"]').checked,
        flags: {
          files: form.querySelector('[name="flag-files"]').checked,
          commands: form.querySelector('[name="flag-commands"]').checked,
          browser: form.querySelector('[name="flag-browser"]').checked,
          mcp: form.querySelector('[name="flag-mcp"]').checked
        },
        roots: rootsField.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        commands: parseList(commandsField, "Configured commands"),
        mcpServers: parseList(serversField, "MCP servers"),
        chat: {
          enabled: form.querySelector('[name="chatEnabled"]').checked,
          protocol: form.querySelector('[name="chatProtocol"]').value,
          tools: [...form.querySelectorAll('[name="chatTool"]:checked')].map(control => control.value),
          maxSteps: Number(form.querySelector('[name="chatMaxSteps"]').value),
          timeoutMs: Number(form.querySelector('[name="chatTimeout"]').value)
        }
      };
      const result = await request("/api/agents/settings", { method: "POST", body: JSON.stringify(settings) });
      notifyAgentsChanged();
      if (result.settings) state.settings = result.settings;
      else state.settings = settings;
      await refreshData();
      renderSettingsForm();
    } catch (error) {
      showError(error.message);
    }
  }

  function startPolling() {
    if (!state.open || state.pollTimer || state.polling) return;
    const tick = async () => {
      if (!state.open) return;
      state.polling = true;
      try {
        await refreshData();
      } catch (error) {
        showError(error.message);
      } finally {
        state.polling = false;
        if (state.open) state.pollTimer = window.setTimeout(() => {
          state.pollTimer = null;
          tick();
        }, 3000);
      }
    };
    state.pollTimer = window.setTimeout(() => {
      state.pollTimer = null;
      tick();
    }, 3000);
  }

  function openModal() {
    if (state.open) return;
    state.open = true;
    state.previousFocus = document.activeElement;
    openButton.setAttribute("aria-expanded", "true");
    openButton.setAttribute("aria-pressed", "true");
    modal.hidden = false;
    document.body.classList.add("agents-open");
    ensurePanel();
    dialog.focus();
    clearError();
    refreshData().then(() => {
      renderSettingsForm();
    }).catch(error => showError(error.message)).finally(() => startPolling());
  }

  function closeModal() {
    if (!state.open) return;
    state.open = false;
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    openButton.setAttribute("aria-expanded", "false");
    openButton.setAttribute("aria-pressed", "false");
    modal.hidden = true;
    document.body.classList.remove("agents-open");
    if (state.previousFocus && state.previousFocus.isConnected) state.previousFocus.focus();
  }

  openButton.addEventListener("click", openModal);
  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", event => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", event => {
    if (!state.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.closest("[hidden]"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
})();
