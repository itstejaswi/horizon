"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentService, DEFAULT_SETTINGS, settingsValue } = require("../src/agents");
const { randomUUID } = require("node:crypto");

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
const definition = name => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } });

async function until(check) {
  for (let i = 0; i < 400; i++) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach expected state.");
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-agents-"));
  const calls = [];
  const tools = {
    definitions: () => ["file_read", "file_write", "command_run"].map(definition),
    execute: async (name, args) => { calls.push({ name, args }); return "tool output"; },
    close: async () => {},
    ...options.tools
  };
  const service = new AgentService({
    directory, tools,
    complete: async () => ({ choices: [{ message: { role: "assistant", content: '{"final":"done"}' } }] }),
    ...options, tools
  });
  t.after(async () => {
    await service.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), enabled: true };
  settings.flags.files = true;
  settings.flags.commands = true;
  service.saveSettings(settings);
  const save = patch => service.saveAgent({
    name: "Test", instructions: "", prompt: "Do the task", tools: ["file_read"],
    unattendedTools: [], steps: [], maxSteps: 3, timeoutMs: 2000,
    schedule: { enabled: false, intervalMinutes: 1 }, ...patch
  });
  return { service, calls, directory, save, settings };
}

test("agent controls reject invalid settings and unknown permissions", t => {
  const { service, save } = fixture(t);
  assert.throws(() => settingsValue({ ...DEFAULT_SETTINGS, enabled: "yes" }), /true or false/);
  assert.throws(() => settingsValue({ ...DEFAULT_SETTINGS, roots: ["relative"] }), /absolute/);
  assert.throws(() => save({ tools: ["made_up_tool"] }), /unknown/);
  assert.throws(() => save({ unattendedTools: ["file_write"] }), /also be allowed/);
  assert.throws(() => save({ maxSteps: 999 }), /integer/);
  assert.throws(() => save({ steps: [{ tool: "file_write", args: {} }] }), /not allowed/);
  assert.throws(() => save({ prompt: "", schedule: { enabled: true, intervalMinutes: 1 } }), /default request/);
  service.stop();
  const agent = save();
  assert.throws(() => service.run(agent.id), /disabled/);
});

test("fixed workflows run without model inference and persist their result", async t => {
  const { service, calls, save, directory } = fixture(t, { complete: async () => { throw new Error("Must not infer"); } });
  const agent = save({ steps: [{ tool: "file_read", args: { path: "note.txt" } }] });
  const run = service.run(agent.id);
  await until(() => terminal.has(service.data.runs[0].status));
  assert.equal(service.data.runs[0].status, "completed");
  assert.equal(calls.length, 1);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, "agent-data.json")));
  assert.equal(disk.runs[0].id, run.id);
  assert.equal(disk.runs[0].result, "tool output");
});

test("writes pause for exact one-use approval; denied calls never execute", async t => {
  const { service, calls, save } = fixture(t);
  const agent = save({ tools: ["file_write"], steps: [{ tool: "file_write", args: { path: "note.txt", content: "exact preview" } }] });
  const run = service.run(agent.id);
  const approval = await until(() => service.data.runs[0].approval);
  assert.equal(calls.length, 0);
  assert.equal(approval.args.content, "exact preview");
  assert.throws(() => service.approve(run.id, "wrong", true), /no longer pending/);
  service.approve(run.id, approval.id, false);
  await until(() => terminal.has(service.data.runs[0].status));
  assert.equal(service.data.runs[0].status, "failed");
  assert.equal(calls.length, 0);
  assert.throws(() => service.approve(run.id, approval.id, true), /no longer pending/);
});

test("approved and explicitly pre-approved tools execute", async t => {
  const { service, calls, save } = fixture(t);
  const agent = save({ tools: ["command_run"], steps: [{ tool: "command_run", args: { id: "fixed" } }] });
  const run = service.run(agent.id);
  const approval = await until(() => service.data.runs[0].approval);
  service.approve(run.id, approval.id, true);
  await until(() => service.data.runs[0].status === "completed");
  assert.equal(calls.length, 1);
  const unattended = save({ name: "Automatic", tools: ["command_run"], unattendedTools: ["command_run"], steps: agent.steps });
  service.run(unattended.id);
  await until(() => service.data.runs[1].status === "completed");
  assert.equal(calls.length, 2);
});

test("permission changes cancel pending approval and prevent late execution", async t => {
  const { service, calls, save, settings } = fixture(t);
  const agent = save({ tools: ["file_write"], steps: [{ tool: "file_write", args: {} }] });
  const run = service.run(agent.id);
  const approval = await until(() => service.data.runs[0].approval);
  service.saveSettings({ ...settings, enabled: false });
  assert.throws(() => service.approve(run.id, approval.id, true), /no longer pending/);
  await until(() => service.data.runs[0].status === "cancelled");
  assert.equal(calls.length, 0);
});

test("structured agents execute validated actions and feed results back to model", async t => {
  const requests = [];
  const { service, calls, save } = fixture(t, {
    complete: async body => {
      requests.push(structuredClone(body));
      return { choices: [{ message: { content: requests.length === 1
        ? '{"tool":"file_read","args":{"path":"note.txt"}}' : '{"final":"Read the note."}' } }] };
    }
  });
  const agent = save();
  service.run(agent.id);
  await until(() => service.data.runs[0].status === "completed");
  assert.equal(calls.length, 1);
  assert.match(requests[1].messages.at(-1).content, /Untrusted result.*file_read/);
  assert.equal(service.data.runs[0].result, "Read the note.");
});

test("malformed structured output fails explicitly without executing a tool", async t => {
  const { service, calls, save } = fixture(t, {
    complete: async () => ({ choices: [{ message: { content: "I already saved it!" } }] })
  });
  service.run(save().id);
  await until(() => service.data.runs[0].status === "failed");
  assert.match(service.data.runs[0].error, /structured action protocol/);
  assert.equal(calls.length, 0);
});

test("model cannot exceed tool budget or gain a tool through prompt content", async t => {
  let choice = "file_read";
  const { service, calls, save } = fixture(t, {
    complete: async () => ({ choices: [{ message: { content: JSON.stringify({ tool: choice, args: {} }) } }] })
  });
  service.run(save({ maxSteps: 1 }).id);
  await until(() => service.data.runs[0].status === "failed");
  assert.equal(calls.length, 1);
  assert.match(service.data.runs[0].error, /maximum tool steps/);
  choice = "command_run";
  service.run(save({ name: "No escalation" }).id);
  await until(() => service.data.runs[1].status === "failed");
  assert.match(service.data.runs[1].error, /not permitted/);
  assert.equal(calls.length, 1);
});

test("native protocol supports tool results and final answer", async t => {
  let turn = 0;
  const { service, save, calls } = fixture(t, {
    complete: async body => {
      turn++;
      assert.equal(body.tools[0].function.name, "file_read");
      if (turn === 1) return { choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"test"}' } }]
      } }] };
      assert.equal(body.messages.at(-1).tool_call_id, "call_1");
      return { choices: [{ message: { role: "assistant", content: "Finished" } }] };
    }
  });
  service.run(save({ protocol: "native" }).id);
  await until(() => service.data.runs[0].status === "completed");
  assert.equal(calls.length, 1);
  assert.equal(service.data.runs[0].result, "Finished");
});

test("time limits interrupt pending model calls", async t => {
  const { service, save } = fixture(t, {
    complete: async (_body, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  service.run(save({ timeoutMs: 1000 }).id);
  await until(() => service.data.runs[0].status === "failed");
  assert.match(service.data.runs[0].error, /time limit/);
});

test("scheduler persists intervals, skips overlaps and missed occurrences", async t => {
  let now = Date.now();
  const { service, save } = fixture(t, { now: () => now });
  const agent = save({ tools: ["file_write"], steps: [{ tool: "file_write", args: {} }], schedule: { enabled: true, intervalMinutes: 1 } });
  now = agent.schedule.nextRunAt;
  service.tick();
  await until(() => service.data.runs[0].approval);
  assert.equal(service.data.runs[0].source, "schedule");
  now += 60000;
  service.tick();
  assert.equal(service.data.runs[1].status, "skipped");
  assert.match(service.data.runs[1].result, /overlapping/);
  service.cancel(service.data.runs[0].id);
  await until(() => service.data.runs[0].status === "cancelled");
  now += 120000;
  service.tick();
  assert.equal(service.data.runs[2].status, "skipped");
  assert.match(service.data.runs[2].result, /Missed/);
});

test("restart retains definitions but marks incomplete work interrupted without replay", async t => {
  const { service, save, directory } = fixture(t);
  const agent = save({ tools: ["file_write"], steps: [{ tool: "file_write", args: {} }] });
  service.run(agent.id);
  await until(() => service.data.runs[0].approval);
  const restarted = new AgentService({ directory, tools: service.tools, complete: service.complete });
  assert.equal(restarted.data.runs[0].status, "interrupted");
  assert.equal(restarted.data.runs[0].approval, undefined);
  assert.equal(restarted.data.agents[0].id, agent.id);
  assert.notEqual(restarted.csrfToken, service.csrfToken);
  await restarted.close();
});

test("corrupt durable state is not silently discarded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-agents-corrupt-"));
  try {
    fs.writeFileSync(path.join(directory, "agent-data.json"), "{bad");
    assert.throws(() => new AgentService({ directory }), /JSON/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("disabled tool flags block a run and scheduled failures remain visible without stopping other schedules", async t => {
  let now = Date.now();
  const { service, save, settings } = fixture(t, { now: () => now });
  const broken = save({ schedule: { enabled: true, intervalMinutes: 1 } });
  const valid = save({ name: "No tools", tools: [], schedule: { enabled: true, intervalMinutes: 1 } });
  settings.flags.files = false;
  service.saveSettings(settings);
  assert.throws(() => service.run(broken.id), /Enable files/);
  now = Math.max(...service.data.agents.map(agent => agent.schedule.nextRunAt));
  service.tick();
  assert.equal(service.data.runs[0].status, "failed");
  assert.match(service.data.runs[0].error, /Enable files/);
  await until(() => service.data.runs[1]?.status === "completed");
  assert.equal(service.data.runs[1].agentId, valid.id);
  assert.equal(service.schedulerError, null);
});

test("reenabling execution does not replay schedules from the disabled interval", t => {
  let now = Date.now();
  const { service, save, settings } = fixture(t, { now: () => now });
  save({ schedule: { enabled: true, intervalMinutes: 1 } });
  service.stop();
  now += 3600000;
  service.saveSettings(settings);
  service.tick();
  assert.equal(service.data.runs.length, 0);
  assert.equal(service.data.agents[0].schedule.nextRunAt, now + 60000);
});

test("erasing agent data cancels pending work, clears durable permissions/history and leaves user files alone", async t => {
  const { service, save, calls, directory } = fixture(t);
  const userFile = path.join(directory, "personal-note.txt");
  fs.writeFileSync(userFile, "keep");
  const agent = save({ tools: ["file_write"], steps: [{ tool: "file_write", args: {} }] });
  service.run(agent.id);
  await until(() => service.data.runs[0].approval);
  await service.erase();
  assert.equal(calls.length, 0);
  assert.deepEqual(service.data.settings, DEFAULT_SETTINGS);
  assert.deepEqual(service.data.agents, []);
  assert.deepEqual(service.data.runs, []);
  const disk = JSON.parse(fs.readFileSync(service.file));
  assert.deepEqual(disk.runs, []);
  assert.equal(fs.readFileSync(userFile, "utf8"), "keep");
});

test("a persistence failure disables execution and cannot enqueue an undurable tool call", async t => {
  const { service, save, calls } = fixture(t);
  const agent = save({ steps: [{ tool: "file_read", args: {} }] });
  fs.mkdirSync(service.file + ".tmp");
  assert.throws(() => service.run(agent.id), /storage failed/);
  assert.equal(service.data.settings.enabled, false);
  assert.equal(service.queue.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(service.data.runs.length, 0);
});

test("privacy reporting does not call network-capable tools air-gapped after they are disabled", async t => {
  const { service, save } = fixture(t);
  assert.equal(service.privacy().externalToolsEnabled, true);
  assert.equal(service.privacy().externalToolsUsed, false);
  const agent = save({
    tools: ["command_run"], unattendedTools: ["command_run"],
    steps: [{ tool: "command_run", args: { id: "fixed" } }]
  });
  service.run(agent.id);
  await until(() => service.data.runs[0].status === "completed");
  service.stop();
  assert.deepEqual(service.privacy(), { externalToolsEnabled: false, externalToolsUsed: true });
  await service.erase();
  assert.deepEqual(service.privacy(), { externalToolsEnabled: false, externalToolsUsed: false });
});

test("ordinary conversations can use tools without creating a reusable agent and retain conversation context", async t => {
  const requests = [];
  const { service, settings, calls } = fixture(t, {
    complete: async body => {
      requests.push(structuredClone(body));
      return { choices: [{ message: { content: requests.length === 1
        ? '{"tool":"file_read","args":{"path":"notes.txt"}}' : '{"final":"Here is the note."}' } }] };
    }
  });
  settings.roots = [path.resolve("notes")];
  settings.commands = [{ id: "summary", executable: process.execPath, args: ["--version"], cwd: path.resolve("notes") }];
  settings.chat.tools = ["file_read"];
  service.saveSettings(settings);
  const id = randomUUID();
  const run = service.chat([
    { role: "system", content: "Be concise and remember my preferred format." },
    { role: "user", content: "The file is notes.txt" },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Read that file now." }
  ], id);
  assert.equal(run.id, id);
  assert.equal(run.source, "chat");
  assert.equal(service.data.agents.length, 0);
  await until(() => service.getRun(id).status === "completed");
  assert.equal(calls.length, 1);
  assert.match(requests[0].messages[0].content, /preferred format/);
  assert.match(requests[0].messages[0].content, /approvedFolders/);
  assert.match(requests[0].messages[0].content, /summary/);
  assert.equal(requests[0].messages[1].content, "The file is notes.txt");
  assert.equal(requests[0].messages.at(-1).content, "Read that file now.");
  assert.equal(service.getRun(id).result, "Here is the note.");
  assert.throws(() => service.chat([{ role: "user", content: "again" }], id), /already submitted/);
});

test("conversation permission scopes and master switch are enforced independently from reusable agents", async t => {
  const { service, settings, calls } = fixture(t, {
    complete: async () => ({ choices: [{ message: { content: '{"tool":"command_run","args":{"id":"fixed"}}' } }] })
  });
  settings.chat.tools = ["file_read"];
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Run a command" }]);
  await until(() => service.getRun(run.id).status === "failed");
  assert.match(service.getRun(run.id).error, /not permitted/);
  assert.equal(calls.length, 0);
  service.saveSettings({ ...settings, chat: { ...settings.chat, enabled: false } });
  assert.equal(service.conversationEnabled(), false);
  assert.throws(() => service.chat([{ role: "user", content: "read" }]), /disabled/);
  assert.throws(() => settingsValue({ ...settings, chat: { ...settings.chat, tools: ["invented"] } }), /unknown/);
});

test("conversation writes require approval even if a reusable agent preapproved the same tool", async t => {
  const { service, save, settings, calls } = fixture(t, {
    complete: async () => ({ choices: [{ message: { content: '{"tool":"file_write","args":{"path":"note","content":"new"}}' } }] })
  });
  save({ tools: ["file_write"], unattendedTools: ["file_write"] });
  settings.chat.tools = ["file_write"];
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Write note" }], randomUUID());
  const approval = await until(() => service.getRun(run.id).approval);
  assert.equal(calls.length, 0);
  service.approve(run.id, approval.id, false);
  await until(() => service.getRun(run.id).status === "failed");
  assert.equal(calls.length, 0);
});

test("a conversation cancelled before submission cannot later execute, and cancellation stops pending approvals", async t => {
  const { service, settings, calls } = fixture(t, {
    complete: async () => ({ choices: [{ message: { content: '{"tool":"file_write","args":{"path":"note","content":"new"}}' } }] })
  });
  settings.chat.tools = ["file_write"];
  service.saveSettings(settings);
  const cancelledId = randomUUID();
  service.cancelConversation(cancelledId);
  assert.throws(() => service.chat([{ role: "user", content: "write" }], cancelledId), /cancelled/);
  assert.throws(() => service.chat([{ role: "user", content: "write" }], "bad"), /run ID/);
  const run = service.chat([{ role: "user", content: "Write note" }], randomUUID());
  await until(() => service.getRun(run.id).approval);
  service.cancelConversation(run.id);
  await until(() => service.getRun(run.id).status === "cancelled");
  assert.equal(calls.length, 0);
});

test("conversation inputs reject oversized histories, tool-role injection and missing user requests", t => {
  const { service } = fixture(t);
  assert.throws(() => service.chat([{ role: "tool", content: "approved" }]), /Invalid conversation role/);
  assert.throws(() => service.chat([{ role: "assistant", content: "done" }]), /user message/);
  assert.throws(() => service.chat(Array.from({ length: 3 }, () => ({ role: "user", content: "a".repeat(20000) }))), /48000/);
});

test("legacy settings receive independent conversation defaults without enabling execution", () => {
  const legacy = structuredClone(DEFAULT_SETTINGS);
  delete legacy.chat;
  const migrated = settingsValue(legacy);
  assert.equal(migrated.enabled, false);
  assert.deepEqual(migrated.chat, DEFAULT_SETTINGS.chat);
  migrated.chat.tools.pop();
  assert.notDeepEqual(migrated.chat.tools, DEFAULT_SETTINGS.chat.tools);
  assert.throws(() => settingsValue({ ...legacy, chat: { ...DEFAULT_SETTINGS.chat, timeoutMs: 999 } }), /timeout/);
});

test("OpenClaw orchestration uses Horizon permissions and approvals without invoking the native model loop", async t => {
  const { service, settings, calls } = fixture(t, {
    complete: async () => { throw new Error("Native loop must not run."); },
    orchestrate: async ({ invoke, onModel }) => {
      onModel();
      await invoke("file_read", { path: "note" });
      await invoke("file_write", { path: "note", content: "exact preview" });
      return "OpenClaw completed the request.";
    }
  });
  settings.backend = "openclaw";
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Read then write" }]);
  const approval = await until(() => service.getRun(run.id).approval);
  assert.equal(approval.tool, "file_write");
  assert.equal(calls.length, 1);
  service.approve(run.id, approval.id, true);
  await until(() => terminal.has(service.getRun(run.id).status));
  assert.equal(service.getRun(run.id).status, "completed");
  assert.equal(service.getRun(run.id).result, "OpenClaw completed the request.");
  assert.equal(calls.length, 2);
});

test("OpenClaw cannot exceed the Horizon tool budget or obtain ungranted tools", async t => {
  const { service, settings, calls } = fixture(t, {
    orchestrate: async ({ invoke }) => {
      await invoke("file_read", { path: "note" });
      await invoke("file_read", { path: "note" });
      return "Must not complete.";
    }
  });
  settings.backend = "openclaw";
  settings.chat.maxSteps = 1;
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Read twice" }]);
  await until(() => service.getRun(run.id).status === "failed");
  assert.match(service.getRun(run.id).error, /maximum tool steps/);
  assert.equal(calls.length, 1);
});

test("missing OpenClaw runtime fails explicitly rather than falling back to native inference", async t => {
  const { service, settings } = fixture(t);
  settings.backend = "openclaw";
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Act" }]);
  await until(() => service.getRun(run.id).status === "failed");
  assert.match(service.getRun(run.id).error, /not provisioned/);
  assert.throws(() => settingsValue({ ...settings, backend: "invented" }), /backend/);
});

test("OpenClaw cannot acquire a tool omitted from the run's explicit grant", async t => {
  const { service, settings, calls } = fixture(t, {
    orchestrate: async ({ invoke }) => {
      await invoke("command_run", { commandId: "fixed" });
      return "Must not complete.";
    }
  });
  settings.backend = "openclaw";
  settings.chat.tools = ["file_read"];
  service.saveSettings(settings);
  const run = service.chat([{ role: "user", content: "Run an ungranted command" }]);
  await until(() => service.getRun(run.id).status === "failed");
  assert.match(service.getRun(run.id).error, /not permitted/);
  assert.equal(calls.length, 0);
});

test("fixed workflows remain deterministic when OpenClaw is selected", async t => {
  const { service, settings, calls, save } = fixture(t, {
    orchestrate: async () => { throw new Error("Must not orchestrate a fixed workflow."); },
    complete: async () => { throw new Error("Must not infer a fixed workflow."); }
  });
  settings.backend = "openclaw";
  service.saveSettings(settings);
  const agent = save({ steps: [{ tool: "file_read", args: { path: "note" } }] });
  const run = service.run(agent.id);
  await until(() => terminal.has(service.getRun(run.id).status));
  assert.equal(service.getRun(run.id).status, "completed");
  assert.equal(calls.length, 1);
});

test("replies are attributed to OpenClaw only when it orchestrates conversation tools", t => {
  const { service, settings } = fixture(t, { orchestrate: async () => "" });
  assert.equal(service.orchestrator(), "Horizon");
  settings.backend = "openclaw";
  service.saveSettings(settings);
  assert.equal(service.orchestrator(), "OpenClaw");
  service.saveSettings({ ...settings, chat: { ...settings.chat, enabled: false } });
  assert.equal(service.orchestrator(), "Horizon", "with conversation tools off, chat goes straight to the model");
});
