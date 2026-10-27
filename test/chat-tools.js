"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "chat-tools.js"), "utf8");
const activitySource = fs.readFileSync(path.join(__dirname, "..", "public", "activity.js"), "utf8");

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}

function harness(respond) {
  const requests = [];
  const events = {};
  const window = {
    addEventListener(type, fn) { events[type] = fn; },
    dispatchEvent() {}
  };
  vm.runInNewContext(activitySource, { window, document: { createElement: tag => new Element(tag) } });
  vm.runInNewContext(source, {
    window, document: { createElement: tag => new Element(tag) },
    crypto: { randomUUID }, Event, DOMException,
    setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const data = await respond(url, options);
      return { ok: !data.error, status: data.error ? 400 : 200, json: async () => data };
    }
  });
  return { api: window.HorizonChatTools, activity: window.HorizonActivity, requests, events };
}

test("ordinary chat follows a tool run and renders its activity without HTML injection", async () => {
  const h = harness(url => url === "/api/chat-tools" ? { enabled: true, csrfToken: "token" }
    : { status: "completed", result: "Done", events: [{ message: "<script>unsafe</script>", result: "read output" }] });
  const control = await h.api.prepare(new AbortController().signal);
  const parent = new Element("div");
  const result = await control.follow({ status: "queued", events: [] }, parent, new AbortController().signal, () => {});
  assert.equal(result.reply, "Done");
  assert.equal(result.agentRunId, control.id);
  assert.equal(control.pending, false);
  assert.equal(parent.children[0].children[1].children[0].children[0].textContent, "<script>unsafe</script>");
  assert.equal(h.requests[1].url, `/api/agents/run?id=${control.id}`);
});

test("approval is explicit and sent once with the exact approval and run IDs", async () => {
  const h = harness(url => url === "/api/chat-tools" ? { enabled: true, csrfToken: "token" }
    : url === "/api/agents/approve" ? { approved: true }
    : { status: "completed", result: "Written", events: [] });
  const control = await h.api.prepare(new AbortController().signal);
  const parent = new Element("div");
  const following = control.follow({
    status: "awaiting_approval", events: [],
    approval: { id: "exact-preview", tool: "file_write", args: { path: "note", content: "exact text" } }
  }, parent, new AbortController().signal, () => {});
  assert.equal(h.requests.length, 1);
  const approve = parent.querySelectorAll("button").find(button => button.textContent === "Approve");
  await Promise.all([approve.listeners.click(), approve.listeners.click()]);
  assert.equal(h.requests.filter(request => request.url === "/api/agents/approve").length, 1);
  const approval = h.requests.find(request => request.url === "/api/agents/approve");
  assert.deepEqual(JSON.parse(approval.options.body), { id: control.id, approvalId: "exact-preview", approve: true });
  assert.equal(approval.options.headers["X-Horizon-Agent-Token"], "token");
  assert.equal((await following).reply, "Written");
});

test("Stop cancels active conversation work even before the initial chat response", async () => {
  const h = harness(url => url === "/api/chat-tools" ? { enabled: false, csrfToken: "token" } : { cancelled: true });
  const controller = new AbortController();
  const control = await h.api.prepare(controller.signal);
  control.pending = true;
  const parent = new Element("div");
  const following = control.follow({ status: "running", events: [] }, parent, controller.signal, () => {});
  controller.abort();
  await assert.rejects(following, { name: "AbortError" });
  assert.equal(h.requests.at(-1).url, "/api/agents/cancel-chat");
  assert.equal(JSON.parse(h.requests.at(-1).options.body).id, control.id);
  assert.equal(h.requests.at(-1).options.keepalive, true);
  assert.match(parent.children[0].children[0].textContent, /cancellation requested/);
});

test("page closure cancels a submitted run even if permissions changed after discovery", async () => {
  const h = harness(url => url === "/api/chat-tools" ? { enabled: false, csrfToken: "token" } : { cancelled: true });
  const control = await h.api.prepare(new AbortController().signal);
  control.pending = true;
  h.events.pagehide();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.at(-1).url, "/api/agents/cancel-chat");
});

test("failed runs surface their actual error instead of returning an empty success", async () => {
  const h = harness(() => ({ enabled: true, csrfToken: "token" }));
  const control = await h.api.prepare(new AbortController().signal);
  await assert.rejects(control.follow({
    status: "failed", error: "Model cannot follow this protocol.", events: []
  }, new Element("div"), new AbortController().signal, () => {}), /cannot follow/);
});

test("cancellation failures remain explicit to every caller without duplicate requests", async () => {
  const h = harness(url => url === "/api/chat-tools" ? { enabled: true, csrfToken: "token" }
    : { error: "Could not save cancellation." });
  const control = await h.api.prepare(new AbortController().signal);
  control.pending = true;
  await assert.rejects(control.cancel(), /Could not save cancellation/);
  await assert.rejects(control.cancel(), /Could not save cancellation/);
  assert.equal(h.requests.filter(request => request.url === "/api/agents/cancel-chat").length, 1);
});

test("activity reflects actual model, tool and approval events rather than guessing from the prompt", () => {
  const { activity } = harness(() => ({}));
  const cases = [
    ["file_list", "reading"], ["file_read", "reading"], ["file_search", "reading"],
    ["file_write", "writing"], ["command_run", "command"],
    ["browser_open", "browsing"], ["browser_snapshot", "browsing"],
    ["browser_click", "browsing"], ["browser_fill", "browsing"], ["browser_close", "browsing"],
    ["mcp_list_tools", "connecting"], ["mcp_call_tool", "connecting"], ["unknown", "acting"]
  ];
  for (const [tool, phase] of cases) {
    assert.equal(activity.describe({ status: "running", events: [{ type: "tool", tool }] }).phase, phase);
  }
  assert.equal(activity.describe({ status: "running", events: [{ type: "model" }] }).phase, "thinking");
  assert.equal(activity.describe({ status: "awaiting_approval", events: [{ type: "tool", tool: "file_write" }] }).phase, "approval");
  for (const status of ["queued", "completed", "failed", "cancelled", "interrupted", "skipped"]) {
    assert.equal(activity.describe({ status, events: [{ type: "tool", tool: "file_write" }] }).phase, status);
  }
});

test("activity provides a labelled live region, decorative local shapes and static terminal states", () => {
  const { activity } = harness(() => ({}));
  const indicator = activity.create("thinking");
  assert.equal(indicator.element.attributes.role, "status");
  assert.equal(indicator.element.attributes["aria-live"], "polite");
  assert.equal(indicator.element.children[0].attributes["aria-hidden"], "true");
  assert.equal(indicator.element.children[0].children.length, 3);
  assert.equal(indicator.element.attributes["data-phase"], "thinking");
  indicator.set("writing", "Writing a file");
  assert.equal(indicator.element.attributes["data-phase"], "writing");
  assert.equal(indicator.element.children[1].textContent, "Writing a file");
  indicator.set("completed");
  assert.equal(indicator.element.attributes["data-phase"], "completed");
  assert.equal(indicator.element.children[1].textContent, "Done");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "app.css"), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.horizon-activity .activity-mark,\s*\.horizon-activity .activity-mark i \{ animation: none; \}/);
  assert.doesNotMatch(css, /\[data-phase="(?:completed|failed|cancelled|approval)"\][^{]*\{[^}]*animation:/);
});

function renderedText(element) {
  return [element.textContent || "", ...element.children.map(renderedText)].join("\n");
}

test("saved plans render honest per-step verification and untrusted text without HTML", () => {
  const { activity } = harness(() => ({}));
  assert.equal(activity.planView({}).hidden, true);
  const steps = [
    { title: "<img onerror=unsafe()>", tool: "file_read", args: { path: "<script>path</script>" }, status: "completed", verification: "passed", evidence: "<script>evidence</script>" },
    { title: "Unchecked", tool: "file_list", args: {}, status: "completed", verification: "not_configured" },
    { title: "Not run", tool: "file_read", args: {}, status: "pending", verification: "not_configured" },
    { title: "Checking", tool: "file_read", args: {}, status: "running", verification: "pending" },
    { title: "Mismatch", tool: "file_read", args: {}, status: "failed", verification: "failed" }
  ];
  const view = activity.planView({
    plan: { status: "failed", steps },
    verification: { status: "partial", message: "Only specified predicates are checked." }
  });
  const text = renderedText(view);
  assert.equal(view.hidden, false);
  assert.match(text, /Native plan · failed/);
  assert.match(text, /Configured outcome check passed/);
  assert.match(text, /Tool succeeded; no outcome check configured/);
  assert.match(text, /Outcome check pending/);
  assert.match(text, /Outcome check failed/);
  assert.match(text, /Verification: partial/);
  assert.match(text, /Only specified predicates/);
  assert.match(text, /<img onerror=unsafe\(\)>/);
  assert.match(text, /<script>evidence<\/script>/);
  assert.match(text, /<script>path<\/script>/);
  assert.equal(view.querySelectorAll("img").length, 0);
  assert.equal(view.querySelectorAll("script").length, 0);
  const items = view.querySelectorAll("li");
  assert.doesNotMatch(renderedText(items[2]), /Tool succeeded/);
  const interrupted = activity.planView({ plan: { status: "interrupted", steps: [
    { ...steps[3], status: "interrupted" }
  ] } });
  assert.match(renderedText(interrupted), /Not verified — execution interrupted; no automatic resume/);
  assert.doesNotMatch(renderedText(interrupted), /Outcome check pending/);
  for (const [status, label] of [
    ["passed", "Verification: configured checks passed"],
    ["not_configured", "Verification: no outcome checks configured"]
  ]) {
    assert.ok(renderedText(activity.planView({ verification: { status, message: label } })).includes(label));
  }
});

test("inline plans refresh even without new events and retain terminal evidence", async () => {
  const step = { title: "Read note", tool: "file_read", args: { path: "note" }, status: "pending", verification: "pending" };
  const initial = { status: "running", events: [{ type: "plan", message: "Plan saved" }], plan: { status: "running", steps: [step] } };
  let observedInitial = false;
  const parent = new Element("div");
  const h = harness(url => {
    if (url === "/api/chat-tools") return { enabled: true, csrfToken: "token" };
    const text = renderedText(parent);
    assert.match(text, /Read note/);
    assert.match(text, /Outcome check pending/);
    observedInitial = true;
    return {
      status: "completed", result: "Done", events: initial.events,
      plan: { status: "completed", steps: [{ ...step, status: "completed", verification: "passed", evidence: "Fresh read matched" }] },
      verification: { status: "passed", message: "Specified predicate matched." }
    };
  });
  const control = await h.api.prepare(new AbortController().signal);
  const result = await control.follow(initial, parent, new AbortController().signal, () => {});
  assert.equal(result.reply, "Done");
  assert.equal(observedInitial, true);
  assert.equal(parent.children[0].open, false);
  const text = renderedText(parent);
  assert.match(text, /Native plan · completed/);
  assert.match(text, /Fresh read matched/);
  assert.match(text, /Verification: configured checks passed/);
  assert.doesNotMatch(text, /Outcome check pending/);
  assert.equal(parent.children[0].children[3].children.length, 1);
});

test("planning and verification phases follow actual events without overriding terminal or approval states", () => {
  const { activity } = harness(() => ({}));
  for (const [type, phase] of [
    ["planning", "planning"], ["plan", "planning"], ["step", "acting"],
    ["verifying", "verifying"], ["retry", "reading"], ["verified", "verifying"]
  ]) {
    const event = { type };
    assert.equal(activity.describe({ status: "running", events: [event] }).phase, phase);
    assert.equal(activity.describe({ status: "failed", events: [event] }).phase, "failed");
    assert.equal(activity.describe({ status: "awaiting_approval", events: [event] }).phase, "approval");
  }
});
