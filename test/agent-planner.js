"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentService, DEFAULT_SETTINGS } = require("../src/agents");
const { planValue } = require("../src/agent-planner");
const tools = require("../src/agent-tools");

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const message = content => ({ choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] });
const step = (tool = "file_read", args = { path: "note.txt" }, extra = {}) => ({ title: "Handle the note", tool, args, ...extra });

async function until(check) {
  for (let i = 0; i < 500; i++) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach expected state.");
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-planner-"));
  const calls = [], requests = [];
  const responses = [...(options.responses || [{ steps: [step()] }, { final: "Read the note." }])];
  const settings = { ...structuredClone(DEFAULT_SETTINGS), enabled: true, planning: true, roots: [directory] };
  settings.flags.files = true;
  settings.flags.commands = true;
  settings.commands = [{ id: "fixed", executable: process.execPath, args: ["--version"], cwd: directory }];
  const service = new AgentService({
    directory: path.join(directory, "state"),
    tools: {
      definitions: tools.definitions,
      execute: async (name, args, config, signal) => {
        calls.push({ name, args });
        return options.execute ? options.execute(name, args, config, signal) : { content: "note", sha256: "a".repeat(64), path: path.join(directory, "note.txt") };
      },
      close: async () => {}
    },
    complete: async body => {
      requests.push(structuredClone(body));
      if (!responses.length) throw new Error("Unexpected inference call.");
      return message(responses.shift());
    }
  });
  service.saveSettings(settings);
  t.after(async () => {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = (patch = {}) => {
    const agent = service.saveAgent({
      name: "Planned task", prompt: "Read the note", instructions: "",
      tools: ["file_read", "file_write", "file_list", "file_search", "command_run"],
      steps: [], unattendedTools: [], protocol: "structured", maxSteps: 8, timeoutMs: 2000,
      schedule: { enabled: false, intervalMinutes: 1 }, ...patch
    });
    return service.run(agent.id);
  };
  const finished = (run, { approve = false } = {}) => until(() => {
    const current = service.getRun(run.id);
    if (approve && current.approval) service.approve(run.id, current.approval.id, true);
    return terminal.has(current.status) && current;
  });
  return { service, settings, start, finished, calls, requests, directory };
}

test("planned native tasks persist progress and distinguish execution from checked outcomes", async t => {
  const { service, start, finished, calls, requests } = fixture(t);
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(run.plan.status, "completed");
  assert.equal(run.plan.steps[0].status, "completed");
  assert.equal(run.plan.steps[0].verification, "not_configured");
  assert.equal(run.verification.status, "not_configured");
  assert.match(run.result, /0\/1 steps passed/);
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(service.file)).runs[0].plan.steps[0].status, "completed");
});

test("fresh read predicates use actual values, not the model summary's claims", async t => {
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step("file_read", { path: "note.txt" }, {
      check: { tool: "file_read", args: { path: "note.txt" }, pointer: "/content", contains: "note" }
    })] }, { final: "Finished" }]
  });
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(run.verification.status, "passed");
  assert.equal(calls.length, 2);
  assert.match(run.plan.steps[0].evidence, /predicate passed/);
});

test("failed predicates stop before later side effects and cannot be overruled by a final answer", async t => {
  const { start, finished, calls, requests } = fixture(t, {
    responses: [{ steps: [step("file_read", { path: "note.txt" }, {
      check: { tool: "file_read", args: { path: "note.txt" }, pointer: "/content", equals: "wrong" }
    }), step("command_run", { commandId: "fixed" })] }]
  });
  const run = await finished(start());
  assert.equal(run.status, "failed");
  assert.match(run.error, /predicate failed/);
  assert.equal(run.plan.status, "failed");
  assert.equal(run.plan.steps[0].verification, "failed");
  assert.equal(run.plan.steps[1].status, "pending");
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 2);
});

test("planned file writes keep exact approvals and independently hash real readback", async t => {
  const { service, start, finished, calls, directory } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "written.txt", content: "hello" })] }, { final: "Saved." }],
    execute: tools.execute
  });
  const queued = start();
  const approval = await until(() => service.getRun(queued.id).approval);
  assert.equal(approval.args.content, "hello");
  assert.equal(calls.length, 0);
  service.approve(queued.id, approval.id, true);
  const run = await finished(queued);
  assert.equal(run.status, "completed");
  assert.equal(fs.readFileSync(path.join(directory, "written.txt"), "utf8"), "hello");
  assert.deepEqual(calls.map(call => call.name), ["file_write", "file_read"]);
  assert.match(run.plan.steps[0].evidence, /SHA-256/);
});

test("write verification does not trust a tool's reported sha256 instead of readback content", async t => {
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "note.txt", content: "expected" })] }],
    execute: async () => ({ content: "wrong", sha256: "a".repeat(64) })
  });
  const run = await finished(start({ unattendedTools: ["file_write"] }), { approve: true });
  assert.equal(run.status, "failed");
  assert.match(run.error, /readback does not match/);
  assert.equal(calls.filter(call => call.name === "file_write").length, 1);
});

test("a denied planned write never executes or retries", async t => {
  const { service, start, finished, calls } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "note.txt", content: "expected" })] }]
  });
  const queued = start();
  const approval = await until(() => service.getRun(queued.id).approval);
  service.approve(queued.id, approval.id, false);
  const run = await finished(queued);
  assert.equal(run.status, "failed");
  assert.match(run.error, /denied/);
  assert.equal(calls.length, 0);
});

test("malformed plans receive one correction before any tool executes", async t => {
  const { start, finished, calls, requests } = fixture(t, {
    responses: ["not JSON", { steps: [step()] }, { final: "Done" }]
  });
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(requests.length, 3);
  assert.equal(calls.length, 1);
  assert.ok(run.events.some(item => item.type === "retry"));
  assert.match(requests[1].messages.at(-1).content, /before execution/);
});

test("twice-invalid plans fail without partial execution", async t => {
  const invalid = { steps: [step(), step("command_run", { executable: "bad" })] };
  const { start, finished, calls } = fixture(t, { responses: [invalid, invalid] });
  const run = await finished(start());
  assert.equal(run.status, "failed");
  assert.match(run.error, /invalid task plan/);
  assert.equal(calls.length, 0);
});

test("transient read failures retry once and remain visible", async t => {
  let attempt = 0;
  const { start, finished, calls } = fixture(t, {
    execute: async () => {
      if (++attempt === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return { content: "note" };
    }
  });
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(calls.length, 2);
  assert.match(run.events.find(item => item.type === "retry").message, /EBUSY/);
});

test("nontransient errors and uncertain side effects are never retried", async t => {
  for (const [tool, args, code] of [
    ["file_read", { path: "note.txt" }, "EACCES"],
    ["command_run", { commandId: "fixed" }, "ETIMEDOUT"]
  ]) {
    const { start, finished, calls } = fixture(t, {
      responses: [{ steps: [step(tool, args)] }],
      execute: async () => { throw Object.assign(new Error("operation failed"), { code }); }
    });
    const run = await finished(start({ unattendedTools: ["command_run"] }), { approve: true });
    assert.equal(run.status, "failed");
    assert.equal(calls.length, 1);
  }
});

test("retry budget preserves capacity for subsequent mandatory checks", async t => {
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step(), step("file_write", { path: "out.txt", content: "x" })] }],
    execute: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
  });
  const run = await finished(start({ maxSteps: 3, unattendedTools: ["file_write"] }));
  assert.equal(run.status, "failed");
  assert.equal(calls.length, 1);
  assert.match(run.error, /busy/);
});

test("prior result references resolve exact overwrite hashes without expression evaluation", async t => {
  const { start, finished, directory } = fixture(t, {
    responses: [{ steps: [
      step(),
      step("file_write", {
        path: "note.txt", content: "updated", overwrite: true,
        expectedSha256: { $result: { step: 0, pointer: "/sha256" } }
      })
    ] }, { final: "Updated" }],
    execute: tools.execute
  });
  fs.writeFileSync(path.join(directory, "note.txt"), "original");
  const run = await finished(start({ unattendedTools: ["file_write"], maxSteps: 3 }), { approve: true });
  assert.equal(run.status, "completed");
  assert.equal(fs.readFileSync(path.join(directory, "note.txt"), "utf8"), "updated");
  assert.equal(run.verification.status, "partial");
});

test("resolved argument validation rejects wrong result types before calling a side effect", async t => {
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step(), step("command_run", { commandId: { $result: { step: 0, pointer: "/content" } } })] }],
    execute: async () => ({ content: 42 })
  });
  const run = await finished(start({ unattendedTools: ["command_run"] }));
  assert.equal(run.status, "failed");
  assert.match(run.error, /must be string/);
  assert.equal(calls.length, 1);
});

test("cancellation during approval never starts a readback or later action", async t => {
  const { service, start, finished, calls } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "note.txt", content: "x" })] }]
  });
  const queued = start();
  await until(() => service.getRun(queued.id).approval);
  service.cancel(queued.id);
  const run = await finished(queued);
  assert.equal(run.status, "cancelled");
  assert.equal(run.plan.status, "cancelled");
  assert.equal(calls.length, 0);
});

test("saved-agent planning never forces ordinary conversations through a JSON plan", async t => {
  const { service, finished, calls, requests } = fixture(t, {
    responses: ["How can I help?"]
  });
  const queued = service.chat([{ role: "system", content: "Be concise." }, { role: "user", content: "Hello." }]);
  assert.equal(calls.length, 0);
  const run = await finished(queued);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "How can I help?");
  assert.equal(run.plan, undefined);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.length);
  assert.match(requests[0].messages[0].content, /Be concise/);
  assert.equal(service.data.agents.length, 0);
});

test("simple no-action planned answers require just one inference and are not labelled verified", async t => {
  const { start, finished, requests, calls } = fixture(t, { responses: [{ final: "Hello" }] });
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(run.result, "Hello");
  assert.equal(run.plan, undefined);
  assert.equal(run.verification.status, "not_configured");
  assert.equal(requests.length, 1);
  assert.equal(calls.length, 0);
});

test("native tool-call agents use the explicit JSON planning contract when opted in", async t => {
  const { start, finished, requests } = fixture(t);
  const run = await finished(start({ protocol: "native" }));
  assert.equal(run.status, "completed");
  assert.match(requests[0].messages[0].content, /Return ONLY JSON/);
  assert.equal(requests[0].tools, undefined);
});

test("planning validates tool/check permissions, budgets, reference order and pointer syntax up front", () => {
  const settings = { flags: { files: true }, roots: [process.cwd()] };
  const definitions = tools.definitions(settings);
  for (const invalid of [
    { steps: [step("made_up")] },
    { steps: [step("file_write", { path: "x", content: "y" })] },
    { steps: [step("file_write", { path: "x", content: "y", overwrite: true })] },
    { steps: [step("file_read", { path: { $result: { step: 0, pointer: "/path" } } })] },
    { steps: [step("file_read", { path: "x" }, { check: { tool: "file_write", args: {}, pointer: "", equals: true } })] },
    { steps: [step("file_read", { path: "x" }, { check: { tool: "file_read", args: { path: "x" }, pointer: "/bad~2", equals: true } })] },
    { steps: [step("file_read", { path: "x" }, { check: { tool: "file_read", args: { path: "x" }, pointer: "/content", contains: "" } })] }
  ]) assert.throws(() => planValue(invalid, definitions, 1));
  assert.throws(() => planValue({ steps: [step("file_write", { path: "x", content: "y" })] },
    definitions.filter(item => item.function.name !== "file_read"), 8), /require a permitted file_read/);
  assert.throws(() => planValue({ steps: [step("file_write", { path: "x", content: "y", overwrite: true })] },
    definitions, 8), /requires expectedSha256/);
});

test("a failed summary remains an explicit failure after durable tool effects", async t => {
  const { start, finished, calls } = fixture(t, { responses: [{ steps: [step()] }, "not JSON"] });
  const run = await finished(start());
  assert.equal(run.status, "failed");
  assert.equal(run.plan.steps[0].status, "completed");
  assert.equal(calls.length, 1);
  assert.ok(run.error);
});

test("transient read recovery stops after its one retry", async t => {
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step()] }],
    execute: async () => { throw Object.assign(new Error("still busy"), { code: "EBUSY" }); }
  });
  const run = await finished(start());
  assert.equal(run.status, "failed");
  assert.equal(calls.length, 2);
  assert.match(run.error, /still busy/);
});

test("missing and escaped JSON pointers are evaluated using own properties only", async t => {
  const { start, finished } = fixture(t, {
    responses: [{ steps: [step("file_read", { path: "note.txt" }, {
      check: { tool: "file_read", args: { path: "note.txt" }, pointer: "/a~1b/~0key", equals: false }
    })] }, { final: "Observed false." }],
    execute: async () => ({ "a/b": { "~key": false } })
  });
  assert.equal((await finished(start())).status, "completed");
  const second = fixture(t, {
    responses: [{ steps: [step("file_read", { path: "note.txt" }, {
      check: { tool: "file_read", args: { path: "note.txt" }, pointer: "/toString", contains: "anything" }
    })] }]
  });
  const run = await second.finished(second.start());
  assert.equal(run.status, "failed");
  assert.match(run.error, /does not contain/);
});

test("legacy planning settings default off and invalid opt-ins are rejected", t => {
  const { service, settings } = fixture(t);
  delete settings.planning;
  service.saveSettings(settings);
  assert.equal(service.snapshot().settings.planning, false);
  assert.throws(() => service.saveSettings({ ...settings, planning: "yes" }), /true or false/);
});

test("restarts mark an active plan interrupted without replaying it", async t => {
  const { service, start, calls } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "note.txt", content: "x" })] }]
  });
  const queued = start();
  await until(() => service.getRun(queued.id).approval);
  const restarted = new AgentService({
    directory: path.dirname(service.file), tools: { close: async () => {} }, complete: async () => { throw new Error("Must not resume"); }
  });
  const run = restarted.getRun(queued.id);
  assert.equal(run.status, "interrupted");
  assert.equal(run.plan.status, "interrupted");
  assert.equal(run.plan.steps[0].status, "interrupted");
  assert.equal(calls.length, 0);
  await restarted.close();
});

test("the planning run timeout aborts pending local inference without executing tools", async t => {
  const { service, start, finished, calls } = fixture(t);
  service.complete = async (_body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const run = await finished(start({ timeoutMs: 1000 }));
  assert.equal(run.status, "failed");
  assert.match(run.error, /time limit/);
  assert.equal(calls.length, 0);
});

test("full readback data is checked even when the displayed tool output is truncated", async t => {
  const content = "x".repeat(13000);
  const { start, finished, calls } = fixture(t, {
    responses: [{ steps: [step("file_write", { path: "large.txt", content })] }, { final: "Saved" }],
    execute: tools.execute
  });
  const run = await finished(start({ unattendedTools: ["file_write"] }), { approve: true });
  assert.equal(run.status, "completed");
  assert.equal(run.verification.status, "passed");
  assert.equal(calls.length, 2);
  assert.ok(run.events.some(item => item.result?.includes("Output truncated")));
});

test("one complete enclosing JSON fence is normalized without weakening plan validation", async t => {
  const { start, finished, calls, requests } = fixture(t, {
    responses: [
      "```json\n" + JSON.stringify({ steps: [step()] }) + "\n```",
      '```json\n{"final":"Read the note."}\n```'
    ]
  });
  const run = await finished(start());
  assert.equal(run.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(run.events.filter(item => item.type === "format").length, 2);
});

test("prose around fenced JSON and invalid actions inside fences still fail before execution", async t => {
  for (const invalid of [
    'Here is the plan:\n```json\n{"steps":[]}\n```',
    '```json\n{"steps":[]}\n```\nExtra instructions.',
    "```json\n" + JSON.stringify({ steps: [step("made_up_tool")] }) + "\n```"
  ]) {
    const { start, finished, calls } = fixture(t, { responses: [invalid, invalid] });
    const run = await finished(start());
    assert.equal(run.status, "failed");
    assert.equal(calls.length, 0);
  }
});

test("dependent copy and overwrite resolve real results, retain exact approvals and verify both outcomes", async t => {
  const { service, start, finished, calls, directory } = fixture(t, {
    responses: [{ steps: [
      step(),
      step("file_write", { path: "copy.txt", content: { $result: { step: 0, pointer: "/content" } } }),
      step("file_write", {
        path: "note.txt", content: "updated", overwrite: true,
        expectedSha256: { $result: { step: 0, pointer: "/sha256" } }
      })
    ] }, { final: "Copied the original and updated the source." }],
    execute: tools.execute
  });
  fs.writeFileSync(path.join(directory, "note.txt"), "original");
  const queued = start();
  const first = await until(() => service.getRun(queued.id).approval);
  assert.deepEqual(first.args, { path: "copy.txt", content: "original" });
  assert.deepEqual(calls.map(call => call.name), ["file_read"]);
  service.approve(queued.id, first.id, true);
  const second = await until(() => {
    const approval = service.getRun(queued.id).approval;
    return approval?.id !== first.id && approval;
  });
  assert.equal(second.args.path, "note.txt");
  assert.equal(second.args.overwrite, true);
  assert.match(second.args.expectedSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(call => call.name), ["file_read", "file_write", "file_read"]);
  service.approve(queued.id, second.id, true);
  const run = await finished(queued);
  assert.equal(run.status, "completed");
  assert.equal(fs.readFileSync(path.join(directory, "copy.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(directory, "note.txt"), "utf8"), "updated");
  assert.equal(run.plan.steps.filter(item => item.verification === "passed").length, 2);
  assert.equal(run.verification.status, "partial");
  assert.deepEqual(calls.map(call => call.name), ["file_read", "file_write", "file_read", "file_write", "file_read"]);
});

test("concurrent modification blocks a dependent overwrite without replaying earlier successful steps", async t => {
  const { service, start, finished, calls, directory } = fixture(t, {
    responses: [{ steps: [
      step(),
      step("file_write", {
        path: "note.txt", content: "updated", overwrite: true,
        expectedSha256: { $result: { step: 0, pointer: "/sha256" } }
      })
    ] }],
    execute: tools.execute
  });
  const file = path.join(directory, "note.txt");
  fs.writeFileSync(file, "original");
  const queued = start();
  const approval = await until(() => service.getRun(queued.id).approval);
  fs.writeFileSync(file, "another writer's change");
  service.approve(queued.id, approval.id, true);
  const run = await finished(queued);
  assert.equal(run.status, "failed");
  assert.match(run.error, /hash changed/);
  assert.equal(fs.readFileSync(file, "utf8"), "another writer's change");
  assert.equal(calls.length, 2);
  assert.equal(run.plan.steps[0].status, "completed");
  assert.equal(run.plan.steps[1].status, "failed");
});

test("scheduled model-driven work uses planning and skips overlapping occurrences", async t => {
  const { service, start, finished, calls } = fixture(t, {
    responses: [
      { steps: [step()] }, { final: "Read note." },
      { steps: [step("file_write", { path: "note.txt", content: "note" })] }, { final: "Saved." }
    ]
  });
  await finished(start({ schedule: { enabled: true, intervalMinutes: 1 } }));
  service.data.agents[0].schedule.nextRunAt = service.now() - 1;
  service.tick();
  const scheduled = service.data.runs.at(-1);
  assert.equal(scheduled.source, "schedule");
  const approval = await until(() => service.getRun(scheduled.id).approval);
  assert.equal(service.getRun(scheduled.id).plan.steps[0].status, "running");
  service.data.agents[0].schedule.nextRunAt = service.now() - 1;
  service.tick();
  assert.equal(service.data.runs.at(-1).status, "skipped");
  assert.match(service.data.runs.at(-1).result, /still active/);
  service.approve(scheduled.id, approval.id, true);
  assert.equal((await finished(scheduled)).status, "completed");
  assert.equal(calls.filter(item => item.name === "file_write").length, 1);
});

test("planning never changes fixed workflows into model-driven work", async t => {
  const { start, finished, calls, requests } = fixture(t, { responses: [] });
  const run = await finished(start({ steps: [{ tool: "file_read", args: { path: "note.txt" } }] }));
  assert.equal(run.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(run.plan, undefined);
});
