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

test("native: browser correction preserves current request and identifies the empty schema despite prior refusals", async () => {
  const f = fixture([
    response({ tool_calls: [call("bad", "browser_snapshot", { selector: "body" })] }),
    response({ tool_calls: [call("fixed", "browser_snapshot", {})] }),
    response({ content: '{"evidence":[1]}' })
  ], "native");
  f.options.settings.flags.browser = true;
  f.options.agent.tools = ["browser_snapshot"];
  f.options.invoke = async (name, args) => {
    f.calls.push({ name, args });
    return JSON.stringify({ title: "Current page", url: "https://example.com/", text: "The current observed page." });
  };
  f.options.prompt = "Can you read the page and tell me whats open?";
  f.options.history = [
    { role: "assistant", content: "I don't have access to list open windows or tabs directly. However I can take a screenshot." },
    { role: "user", content: f.options.prompt }
  ];
  await nativeRun(f.options);
  assert.deepEqual(f.calls, Array.from({ length: 2 }, () => ({ name: "browser_snapshot", args: {} })));
  const correction = f.requests[1].messages.at(-1);
  assert.equal(correction.role, "system");
  assert.match(correction.content, /browser_snapshot/);
  assert.match(correction.content, /selector/);
  assert.ok(correction.content.includes(f.options.prompt));
  assert.equal(f.requests[1].messages.filter(message => message.role === "user").at(-1).content, f.options.prompt);
  assert.match(f.requests[0].messages[0].content, /Earlier assistant statements.*mistaken/);
  assert.equal(f.requests[0].messages.at(-2).role, "system");
  assert.match(f.requests[0].messages.at(-2).content, /fresh browser_snapshot/);
  assert.equal(f.requests[0].messages.at(-1).role, "user");
  assert.equal(f.requests[0].messages.at(-1).content, f.options.prompt);
  assert.match(f.requests[0].tools[0].function.description, /exactly \{\}/);
  assert.equal(f.requests[1].messages.some(message => message.tool_calls), false);
  assert.match(f.requests[2].messages.at(-1).content, /browser_snapshot just succeeded/);
  assert.match(f.requests[2].messages.at(-1).content, /not a screenshot/);
});

test("native: browser capability is not advertised without the granted snapshot tool", async () => {
  const f = fixture([response({ content: "Hello." })], "native");
  await nativeRun(f.options);
  assert.doesNotMatch(f.requests[0].messages[0].content, /Live browser capability/);
});

test("native: a blank viewport yields visibly to the user and preserves same-conversation continuity", async () => {
  const handoff = "The isolated browser viewport is open and ready. Navigate or interact there, then send your next message in this conversation; Horizon will freshly inspect the selected page before continuing.";
  const f = fixture([
    response({ tool_calls: [call("open-1", "browser_open", {})] })
  ], "native");
  f.options.agent.tools = ["browser_open", "browser_snapshot"];
  f.options.settings.flags.browser = true;
  f.options.history = [{ role: "user", content: "Open the viewport so I can show you something." }];
  f.options.run.conversationId = "chat-123";
  f.options.tools = {
    definitions,
    browserState: async () => ({ open: false, conversationId: "chat-123", isolated: true })
  };
  f.options.invoke = async (name, args) => {
    f.calls.push({ name, args });
    assert.equal(name, "browser_open");
    assert.deepEqual(args, {});
    return JSON.stringify({
      url: "about:blank", title: "", visible: true, isolated: true, retainedAcrossTurns: true, readyForUser: true
    });
  };

  const result = await nativeRun(f.options);
  assert.match(result, /isolated browser viewport is open and ready/);
  assert.deepEqual(f.calls.map(item => item.name), ["browser_open"]);
  assert.equal(f.run.handoff.message, handoff);
  assert.equal(f.run.handoff.conversationId, "chat-123");
  assert.equal(f.run.handoff.resume, "next-message-in-same-conversation");
  assert.deepEqual(f.run.handoff.checkpoint, {
    version: 1,
    intent: f.options.prompt,
    latestRequest: f.options.prompt,
    progress: [],
    truncated: false
  });
  assert.match(f.requests[0].messages[0].content, /next message in this conversation starts a fresh Horizon run/);
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === "horizon_handoff"));
  assert.equal(f.requests.length, 1, "blank viewport handoff returns control without waiting for another model call");
  assert.ok(f.events.some(event => event.type === "handoff"));
});

test("native: a blank viewport is rejected before execution without a stable conversation ID", async () => {
  const f = fixture([response({ tool_calls: [call("open-1", "browser_open", {})] })], "native");
  f.options.agent.tools = ["browser_open", "browser_snapshot"];
  f.options.settings.flags.browser = true;
  f.options.history = [{ role: "user", content: "Open the viewport." }];
  f.options.tools = { definitions };
  await assert.rejects(nativeRun(f.options), /stable conversation ID/);
  assert.equal(f.calls.length, 0);
});

test("native: a later human handoff checkpoints completed tool results and original intent", async () => {
  const f = fixture([
    response({ content: '{"tool":"file_read","args":{"path":"invoice.txt"}}' }),
    response({ content: '{"tool":"horizon_handoff","args":{"message":"Please open the invoice in your browser."}}' })
  ]);
  f.options.agent.tools = ["file_read"];
  f.options.history = [{ role: "user", content: "Find the invoice total after I open the invoice." }];
  f.options.run.conversationId = "invoice-chat";
  f.options.invoke = async (name, args) => {
    f.calls.push({ name, args });
    f.options.run.events = [{ type: "result", tool: name, result: "Invoice source text" }];
    return "Invoice source text";
  };
  await nativeRun(f.options);
  assert.equal(f.run.handoff.checkpoint.intent, "Find the invoice total after I open the invoice.");
  assert.deepEqual(f.run.handoff.checkpoint.progress, [
    { tool: "file_read", result: "Invoice source text" }
  ]);
  assert.equal(f.calls.length, 1, "handoff follows the completed read without replaying it");
});

test("native: an empty assistant decision can be corrected without crashing the diagnostic", async () => {
  for (const protocol of ["native", "structured"]) {
    const f = fixture([
      response({}),
      response(protocol === "native" ? { tool_calls: [call("fixed", "file_read", { path: "note.txt" })] }
        : { content: '{"tool":"file_read","args":{"path":"note.txt"}}' }),
      response(protocol === "native" ? { content: "Observed." } : { content: '{"final":"Observed."}' })
    ], protocol, 1);
    assert.equal(await nativeRun(f.options), "Observed.");
    assert.equal(f.calls.length, 1);
    assert.match(f.requests[1].messages.at(-1).content, /Rejected decision:/);
  }
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
  const truncated = fixture(Array.from({ length: 2 }, () => ({ choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"final":"' } }] })));
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

function browserFixture(replies, maxSteps = 6) {
  const f = fixture(replies, "native", maxSteps);
  f.options.settings.flags.browser = true;
  f.options.agent.tools = ["browser_open", "browser_snapshot", "browser_close"];
  f.page = { title: "Synthetic evidence", url: "https://example.com/evidence", text: "Synthetic unit price: 731.29. Fixture only." };
  f.options.invoke = async (name, args, options) => {
    f.calls.push({ name, args });
    if (name === "browser_snapshot") {
      assert.equal(options.raw, true, "preserve valid JSON instead of truncating the serialized snapshot");
      return structuredClone(f.page);
    }
    return JSON.stringify({ title: f.page.title, url: f.page.url });
  };
  return f;
}

test("graph: navigation metadata always leads to guarded observation before answering", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/evidence" })] }),
    response({ content: '{"evidence":[1]}' })
  ]);
  const answer = await nativeRun(f.options);
  assert.deepEqual(f.calls.map(call => call.name), ["browser_open", "browser_snapshot", "browser_snapshot"]);
  assert.match(f.requests[1].messages.at(-1).content, /731.29/);
  assert.match(answer, /Selected page evidence/);
  assert.equal(f.run.verification.status, "passed");
  assert.deepEqual(f.events.filter(e => e.type === "graph").map(e => e.message.split(": ")[1].slice(0, -1)),
    ["prepare", "decide", "validate", "act", "observe", "decide", "validate", "verify", "answer"]);
});

test("graph: invented facts are rejected and one correction cannot replay navigation", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/evidence" })] }),
    response({ content: "The price is 304.85." }),
    response({ content: '{"evidence":[1]}' })
  ]);
  const answer = await nativeRun(f.options);
  assert.doesNotMatch(answer, /304.85/);
  assert.equal(f.calls.filter(call => call.name === "browser_open").length, 1);
  assert.equal(f.events.filter(e => e.type === "retry").length, 1);
});

test("graph: repeated unsupported browser answer fails, never silently falls back to success", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/evidence" })] }),
    response({ content: "I do not have browser access." }),
    response({ content: "The price is 304.85." })
  ]);
  await assert.rejects(nativeRun(f.options), /not a prose answer/);
  assert.equal(f.run.failure.stage, "verification");
  assert.equal(f.run.verification, undefined);
});

test("graph: retained page refresh precedes model decision, ignoring cached history and title-only evidence", async () => {
  const f = browserFixture([response({ content: '{"evidence":[1]}' })]);
  f.page = { title: "Old misleading title 304.85", url: "https://example.com/selected", text: "Fresh selected tab: 918.42." };
  f.options.history = [{ role: "assistant", content: "No browser access; old price 304.85." }, { role: "user", content: "Read what is open." }];
  f.options.tools = { definitions, browserState: async () => ({ open: true, conversationId: "stable-thread", tabs: 2, url: f.page.url }) };
  const answer = await nativeRun(f.options);
  assert.equal(f.calls[0].name, "browser_snapshot");
  assert.match(f.requests[0].messages.at(-1).content, /918.42/);
  assert.match(answer, /918.42/);
  assert.equal(f.requests.length, 1);
});

test("graph: page changes during inference are reobserved at final verification", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/evidence" })] }),
    response({ content: '{"evidence":[1]}' }),
    response({ content: '{"evidence":[1]}' })
  ]);
  const complete = f.options.complete;
  f.options.complete = async (...args) => {
    const result = await complete(...args);
    if (f.requests.length === 2) f.page = { ...f.page, url: "https://example.com/new", text: "Newly selected tab: 129.73." };
    return result;
  };
  const answer = await nativeRun(f.options);
  assert.doesNotMatch(answer, /731.29/);
  assert.match(answer, /129.73/);
});

test("graph: missing data and not-found pages cannot establish requested facts", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/missing" })] }),
    response({ content: '{"evidence":[]}' })
  ]);
  f.page.text = "Page Not Found. Unrelated sidebar: 25,645.60.";
  await assert.rejects(nativeRun(f.options), /could not be established/);
  assert.equal(f.run.failure.stage, "verification");
  assert.equal(f.run.verification, undefined);
});

test("graph: snapshot grant and budget cannot be bypassed by automatic observation", async () => {
  const denied = browserFixture([response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" })] })]);
  denied.options.agent.tools = ["browser_open"];
  await assert.rejects(nativeRun(denied.options), /Grant browser_snapshot/);
  assert.equal(denied.calls.filter(call => call.name === "browser_snapshot").length, 0);
  const exhausted = browserFixture([response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" })] })], 1);
  await assert.rejects(nativeRun(exhausted.options), /budget remains/);
  assert.equal(exhausted.calls.length, 1);
});

test("graph: required snapshot approval denial is explicit, never retried", async () => {
  const f = browserFixture([response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" })] })]);
  const invoke = f.options.invoke;
  f.options.invoke = async (...args) => {
    if (args[0] === "browser_snapshot") throw new Error("Human denied snapshot.");
    return invoke(...args);
  };
  await assert.rejects(nativeRun(f.options), /Human denied/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.run.failure.tool, "browser_snapshot");
});

test("graph: search metadata also requires observation, and close cannot launder page claims", async () => {
  const search = browserFixture([
    response({ tool_calls: [call("search", "browser_search", { query: "synthetic evidence" })] }),
    response({ content: '{"evidence":[1]}' })
  ]);
  search.options.agent.tools.push("browser_search");
  await nativeRun(search.options);
  assert.deepEqual(search.calls.map(call => call.name), ["browser_search", "browser_snapshot", "browser_snapshot"]);
  const close = browserFixture([response({ tool_calls: [call("close", "browser_close", {})] })]);
  close.options.tools = { definitions, browserState: async () => ({ open: true }) };
  assert.match(await nativeRun(close.options), /^Closed the isolated browser/);
  assert.equal(close.requests.length, 1, "Closure is acknowledged from the tool result, not a model's invented page answer.");
});

test("graph: mixed close/action batch is rejected atomically before effects", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" }), call("close", "browser_close", {})] }),
    response({ content: "No action taken." })
  ]);
  assert.equal(await nativeRun(f.options), "No action taken.");
  assert.equal(f.calls.length, 0);
});

test("graph: cancellation in an executing observation cannot reach final answer or replay a tool", async () => {
  const f = browserFixture([response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" })] })]);
  const invoke = f.options.invoke;
  f.options.invoke = async (...args) => {
    if (args[0] === "browser_snapshot") {
      f.controller.abort(new Error("Cancelled during observation."));
      f.controller.signal.throwIfAborted();
    }
    return invoke(...args);
  };
  await assert.rejects(nativeRun(f.options), /Cancelled/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.filter(call => call.name === "browser_open").length, 1);
  assert.equal(f.events.some(event => event.type === "graph" && event.message === "LangGraph: answer."), false);
});

test("graph: raw large snapshots remain valid bounded JSON with explicit truncation", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com" })] }),
    response({ content: '{"evidence":[1]}' })
  ]);
  f.page.text = "Visible evidence.\n" + "x".repeat(20000);
  const answer = await nativeRun(f.options);
  assert.match(answer, /Page text was truncated/);
  assert.ok(JSON.stringify(f.requests[1]).length < 30000);
});

test("graph: bounded truncation correction executes no incomplete action", async () => {
  const f = fixture([
    { choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"tool":"file_write"' } }] },
    response({ content: '{"final":"No action executed."}' })
  ]);
  assert.equal(await nativeRun(f.options), "No action executed.");
  assert.equal(f.calls.length, 0);
  assert.ok(f.requests.every(request => request.max_tokens === 2048));
});

test("graph: paraphrase is replaced by source evidence, never verified by word or number matching", async () => {
  const f = browserFixture([
    response({ tool_calls: [call("open", "browser_open", { url: "https://example.com/evidence" })] }),
    response({ content: "The synthetic unit price shown there is 731.29." }),
    response({ content: '{"evidence":[1]}' })
  ]);
  const answer = await nativeRun(f.options);
  assert.match(answer, /Synthetic unit price: 731\.29\./);
  assert.doesNotMatch(answer, /shown there/);
  assert.equal(f.requests.length, 3, "one bounded selection correction, no independent model verifier");
  assert.equal(f.calls.filter(call => call.name === "browser_open").length, 1);
});

test("graph: evidence selectors are strict, bounded, and cannot supply invented text", async () => {
  for (const selection of [
    { evidence: [0] }, { evidence: [-1] }, { evidence: [1.5] }, { evidence: ["1"] },
    { evidence: [999] }, { evidence: [1, 1] }, { evidence: null },
    { evidence: [1], answer: "Invented" }, { evidence: Array.from({ length: 9 }, (_, i) => i + 1) }
  ]) {
    const f = browserFixture(Array.from({ length: 2 }, () => response({ content: JSON.stringify(selection) })));
    f.options.tools = { definitions, browserState: async () => ({ open: true }) };
    await assert.rejects(nativeRun(f.options), /after one correction/);
    assert.equal(f.run.failure.stage, "verification");
    assert.equal(f.run.verification, undefined);
  }
  const oversized = browserFixture(Array.from({ length: 2 }, () => response({ content: '{"evidence":[1,2,3]}' })));
  oversized.options.tools = { definitions, browserState: async () => ({ open: true }) };
  oversized.page.text = "x".repeat(3000);
  await assert.rejects(nativeRun(oversized.options), /exceeds 2000/);
});

test("graph: missing requested data never promotes an unrelated sidebar to a verified claim", async () => {
  for (const protocol of ["native", "structured"]) {
    const f = browserFixture([response({ content: '{"evidence":[]}' })]);
    f.options.agent.protocol = protocol;
    f.options.tools = { definitions, browserState: async () => ({ open: true }) };
    f.page.text = "Page Not Found. Requested measurement unavailable. Unrelated sidebar index: 25,645.60.";
    await assert.rejects(nativeRun(f.options), /could not be established/);
    assert.equal(f.run.failure.stage, "verification");
    assert.equal(f.run.verification, undefined);
  }
});

test("graph: structured evidence selection uses the same deterministic rendering", async () => {
  const f = browserFixture([response({ content: '{"evidence":[1,2]}' })]);
  f.options.agent.protocol = "structured";
  f.options.tools = { definitions, browserState: async () => ({ open: true }) };
  assert.match(await nativeRun(f.options), /Synthetic unit price: 731\.29\.\nFixture only\./);
  assert.equal(f.run.verification.status, "passed");
});

test("graph: bounded recent history preserves current request instead of stale false refusals", async () => {
  const f = fixture([response({ content: '{"final":"Current."}' })]);
  f.options.history = [...Array.from({ length: 80 }, () => ({ role: "assistant", content: "Old refusal ".repeat(100) })), { role: "user", content: "Current request" }];
  await nativeRun(f.options);
  assert.ok(f.requests[0].messages.length <= 13);
  assert.equal(f.requests[0].messages.at(-1).content, "Current request");
});

test("graph: environment tracing is rejected without changing global configuration or invoking inference", async () => {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, ["-e", `
    const { nativeRun } = require("./src/native-runtime");
    const run = {};
    nativeRun({run}).then(() => process.exit(2), error => {
      if (run.failure.stage !== "privacy" || process.env.LANGSMITH_TRACING !== "true") process.exit(3);
      console.log(error.message);
    });
  `], { cwd: process.cwd(), env: { ...process.env, LANGSMITH_TRACING: "true" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /will not send private prompts/);
});
