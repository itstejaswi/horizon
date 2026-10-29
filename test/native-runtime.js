"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { nativeRun } = require("../src/native-runtime");
const { definitions } = require("../src/agent-tools");
const { DEFAULT_SETTINGS } = require("../src/agents");

const response = message => ({ choices: [{ message: { role: "assistant", ...message } }] });
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function fixture(replies, protocol = "structured", maxSteps = 2) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.flags.files = true;
  settings.roots = [process.cwd()];
  const run = {};
  const calls = [];
  const requests = [];
  const events = [];
  const controller = new AbortController();
  const options = {
    agent: { tools: ["file_read", "file_write"], instructions: "", protocol, maxSteps },
    prompt: "Read note.txt", settings, run, signal: controller.signal,
    tools: { definitions },
    complete: async body => {
      requests.push(structuredClone(body));
      const next = replies.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "unexpected model request");
      return next;
    },
    invoke: async (name, args) => { calls.push({ name, args }); return '{"content":"observed"}'; },
    event: (type, message) => events.push({ type, message })
  };
  return { options, run, calls, requests, events, controller };
}

test("native: one correction does not consume the last tool or final decision", async () => {
  const f = fixture([
    response({ content: "Let me read that." }),
    response({ content: '{"tool":"file_read","args":{"path":"note.txt"}}' }),
    response({ content: '{"final":"Observed text."}' })
  ], "structured", 1);
  assert.equal(await nativeRun(f.options), "Observed text.");
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.filter(event => event.type === "retry").length, 1);
  assert.equal(f.run.verification.status, "not_configured");
});

test("native: enclosing fences work but prose and repeated malformed actions fail", async () => {
  const fenced = fixture([response({ content: '```json\n{"final":"No action needed."}\n```' })]);
  assert.equal(await nativeRun(fenced.options), "No action needed.");
  assert.equal(fenced.events.filter(event => event.type === "format").length, 1);
  const broken = fixture([
    response({ content: 'Answer: {"final":"done"}' }),
    response({ content: 'Answer: {"final":"done"}' })
  ]);
  await assert.rejects(nativeRun(broken.options), /after one correction/);
  assert.equal(broken.run.failure.stage, "validation");
  assert.equal(broken.calls.length, 0);
});

test("native: schema mistakes are corrected before execution", async () => {
  const f = fixture([
    response({ content: '{"tool":"file_read","args":{"path":5}}' }),
    response({ content: '{"tool":"file_read","args":{"path":"note.txt"}}' }),
    response({ content: '{"final":"Read."}' })
  ]);
  await nativeRun(f.options);
  assert.deepEqual(f.calls, [{ name: "file_read", args: { path: "note.txt" } }]);
  assert.match(f.requests[1].messages.at(-1).content, /must be string/);
});

test("native: a rejected batch executes no calls and can be corrected atomically", async () => {
  const f = fixture([
    response({ tool_calls: [call("a", "file_read", { path: "one.txt" }), call("b", "file_read", { unexpected: true })] }),
    response({ tool_calls: [call("c", "file_read", { path: "two.txt" })] }),
    response({ content: "Read two." })
  ], "native");
  await nativeRun(f.options);
  assert.deepEqual(f.calls, [{ name: "file_read", args: { path: "two.txt" } }]);
  assert.equal(f.requests[1].messages.some(message => message.tool_calls), false);
  assert.equal(f.requests[2].messages.at(-1).tool_call_id, "c");
});

test("native: unavailable tools fail without a permission-expanding retry", async () => {
  const f = fixture([response({ content: '{"tool":"command_run","args":{"commandId":"x"}}' })]);
  await assert.rejects(nativeRun(f.options), /not permitted/);
  assert.equal(f.run.failure.stage, "permissions");
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.length, 0);
});

test("native: duplicate native call IDs cannot cause duplicate effects", async () => {
  const f = fixture([
    response({ tool_calls: [call("a", "file_read", { path: "one.txt" }), call("a", "file_read", { path: "two.txt" })] }),
    response({ tool_calls: [call("a", "file_read", { path: "one.txt" }), call("a", "file_read", { path: "two.txt" })] })
  ], "native");
  await assert.rejects(nativeRun(f.options), /unique/);
  assert.equal(f.calls.length, 0);
});

test("native: execution and inference failures are explicit and never replayed", async () => {
  const f = fixture([response({ content: '{"tool":"file_write","args":{"path":"x.txt","content":"x"}}' })]);
  let attempts = 0;
  f.options.invoke = async () => { attempts++; throw new Error("Approval denied or uncertain write."); };
  await assert.rejects(nativeRun(f.options), /Approval denied/);
  assert.equal(attempts, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.run.failure, { stage: "execution", tool: "file_write", message: "Approval denied or uncertain write." });
  const down = fixture([new Error("Ollama is unavailable.")]);
  await assert.rejects(nativeRun(down.options), /Ollama/);
  assert.equal(down.run.failure.stage, "inference");
});

test("native: correction after a completed action never replays it", async () => {
  const f = fixture([
    response({ content: '{"tool":"file_read","args":{"path":"note.txt"}}' }),
    response({ content: "Bad format." }),
    response({ content: '{"final":"Finished."}' })
  ], "structured", 1);
  await nativeRun(f.options);
  assert.equal(f.calls.length, 1);
  assert.match(f.requests[2].messages.at(-2).content, /observed/);
});

test("native: tool budget and truncated responses fail without executing excess calls", async () => {
  const f = fixture([response({ tool_calls: [call("a", "file_read", { path: "one" }), call("b", "file_read", { path: "two" })] })], "native", 1);
  await assert.rejects(nativeRun(f.options), /maximum tool steps/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.run.failure.stage, "budget");
  const truncated = fixture([{ choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"final":"' } }] }]);
  await assert.rejects(nativeRun(truncated.options), /cut off/);
  assert.equal(truncated.run.failure.stage, "model_response");
});

test("native: cancellation prevents inference and tool execution", async () => {
  const f = fixture([]);
  f.controller.abort(new Error("Cancelled."));
  await assert.rejects(nativeRun(f.options), /Cancelled/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.length, 0);
});
