"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { createBroker } = require("../src/openclaw-broker");

const definitions = [{
  type: "function",
  function: {
    name: "file_read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  }
}];

async function withBroker(options, run) {
  const broker = await createBroker({ definitions, invoke: async () => ({ ok: true }), complete: async body => body, ...options });
  try {
    await run(broker);
  } finally {
    await broker.close();
  }
}

function headers(broker, extra = {}) {
  return { Authorization: `Bearer ${broker.token}`, ...extra };
}

function post(broker, path, body, extraHeaders = {}) {
  return fetch(`${broker.baseUrl}${path}`, {
    method: "POST",
    headers: headers(broker, { "Content-Type": "application/json", ...extraHeaders }),
    body: JSON.stringify(body)
  });
}

function requestWithHeaders(broker, path, customHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${broker.baseUrl}${path}`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: customHeaders
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("authenticated loopback routes expose only local tools and proxy unchanged completion requests", async () => {
  let observed;
  let modelEvents = 0;
  await withBroker({
    complete: async body => {
      observed = body;
      return { model: "actual-foundry-model", choices: [{ message: { role: "assistant", content: "local" } }] };
    },
    onModel: () => { modelEvents += 1; }
  }, async broker => {
    assert.match(broker.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(broker.token.length, 64);
    const toolResponse = await fetch(`${broker.baseUrl}/tools`, { headers: headers(broker) });
    assert.equal(toolResponse.status, 200);
    assert.deepEqual(await toolResponse.json(), { tools: definitions });
    assert.equal((await fetch(`${broker.baseUrl}/v1/models`, { headers: headers(broker) })).status, 200);
    assert.deepEqual(await (await fetch(`${broker.baseUrl}/v1/models`, { headers: headers(broker) })).json(), {
      data: [{ id: "horizon-local", object: "model", owned_by: "local" }]
    });

    const body = {
      model: "private-foundry-deployment",
      messages: [{ role: "user", content: "hello" }, { role: "tool", tool_call_id: "call_1", content: "done" }],
      tools: [{
        type: "function",
        function: { name: "horizon_file_read", parameters: definitions[0].function.parameters }
      }]
    };
    const completion = await post(broker, "/v1/chat/completions", body);
    assert.equal(completion.status, 200);
    assert.deepEqual(await completion.json(), {
      model: "horizon-local",
      choices: [{ message: { role: "assistant", content: "local" } }]
    });
    assert.deepEqual(observed, { ...body, stream: false });
    assert.equal(modelEvents, 1);
    assert.equal(JSON.stringify(await (await fetch(`${broker.baseUrl}/v1/models`, { headers: headers(broker) })).json()).includes("private-foundry"), false);
  });
});

test("authorization, Host, Origin, Fetch-Site, methods, and routes fail closed", async () => {
  await withBroker({}, async broker => {
    assert.equal((await fetch(`${broker.baseUrl}/tools`)).status, 403);
    assert.equal((await fetch(`${broker.baseUrl}/tools`, { headers: headers(broker, { Origin: "null" }) })).status, 403);
    assert.equal((await fetch(`${broker.baseUrl}/tools`, {
      headers: headers(broker, { Origin: "https://foreign.example" })
    })).status, 403);
    assert.equal((await fetch(`${broker.baseUrl}/tools`, {
      headers: headers(broker, { "Sec-Fetch-Site": "cross-site" })
    })).status, 403);
    const hostileHost = await requestWithHeaders(broker, "/tools", {
      Host: "foreign.example",
      Authorization: `Bearer ${broker.token}`
    });
    assert.equal(hostileHost.status, 403);
    assert.equal((await fetch(`${broker.baseUrl}/tools`, { method: "POST", headers: headers(broker) })).status, 405);
    assert.equal((await fetch(`${broker.baseUrl}/private`, { headers: headers(broker) })).status, 404);
  });
});

test("tool calls require an exact allowlisted name and object arguments and report policy failures", async () => {
  let invocations = 0;
  const failures = [];
  await withBroker({
    invoke: async () => { invocations += 1; return "ok"; },
    onFailure: error => failures.push(error.message)
  }, async broker => {
    assert.equal((await post(broker, "/tools/call", { name: "horizon_file_read", arguments: { path: "x" } })).status, 403);
    assert.match(failures[0], /not allowed/);
    assert.equal((await post(broker, "/tools/call", { name: "file_read", arguments: [] })).status, 400);
    assert.equal((await post(broker, "/tools/call", { name: "file_read", arguments: { path: "x", extra: true } })).status, 200);
    assert.equal(invocations, 1);
  });
});

test("tool approval calls reject overlap until the first approval settles", async () => {
  let release;
  let count = 0;
  await withBroker({
    invoke: () => {
      count += 1;
      return new Promise(resolve => { release = resolve; });
    }
  }, async broker => {
    const first = post(broker, "/tools/call", { name: "file_read", arguments: { path: "x" } });
    for (let attempt = 0; attempt < 30 && !release; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof release, "function");
    const overlap = await post(broker, "/tools/call", { name: "file_read", arguments: { path: "y" } });
    assert.equal(overlap.status, 409);
    assert.equal(count, 1);
    release({ approved: true });
    const response = await first;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { approved: true } });
  });
});

test("rejected tool invocations return a bounded error and abort the run", async () => {
  let failure;
  await withBroker({
    invoke: async () => { throw new Error("approval denied"); },
    onFailure: error => { failure = error; }
  }, async broker => {
    const response = await post(broker, "/tools/call", { name: "file_read", arguments: { path: "x" } });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error.message, /approval denied/);
    assert.equal(failure.message, "approval denied");
  });
});

test("invalid JSON, content type, request size, and tool schemas are rejected", async () => {
  await withBroker({}, async broker => {
    const noContentType = await fetch(`${broker.baseUrl}/tools/call`, {
      method: "POST",
      headers: headers(broker),
      body: "{}"
    });
    assert.equal(noContentType.status, 415);
    const invalidJson = await fetch(`${broker.baseUrl}/tools/call`, {
      method: "POST",
      headers: headers(broker, { "Content-Type": "application/json" }),
      body: "{"
    });
    assert.equal(invalidJson.status, 400);
    const oversized = await fetch(`${broker.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(broker, { "Content-Type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(270 * 1024) }] })
    });
    assert.equal(oversized.status, 413);
    const changedSchema = await post(broker, "/v1/chat/completions", {
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: {
          name: "file_read",
          parameters: { type: "object", properties: {}, additionalProperties: true }
        }
      }]
    });
    assert.equal(changedSchema.status, 400);
    const badRole = await post(broker, "/v1/chat/completions", { messages: [{ role: "attacker", content: "x" }] });
    assert.equal(badRole.status, 400);
  });
});

test("model calls are bounded and each accepted call emits exactly one event", async () => {
  let completeCalls = 0;
  let modelEvents = 0;
  await withBroker({
    maxModelCalls: 1,
    complete: async () => {
      completeCalls += 1;
      return { choices: [{ message: { role: "assistant", content: "ok" } }] };
    },
    onModel: () => { modelEvents += 1; }
  }, async broker => {
    const body = { messages: [{ role: "user", content: "one" }] };
    assert.equal((await post(broker, "/v1/chat/completions", body)).status, 200);
    const limited = await post(broker, "/v1/chat/completions", body);
    assert.equal(limited.status, 429);
    assert.equal(completeCalls, 1);
    assert.equal(modelEvents, 1);
  });
});

test("model completion timeout aborts its signal and oversized responses are rejected", async () => {
  let timedOut = false;
  await withBroker({
    timeoutMs: 40,
    complete: (_body, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        timedOut = signal.reason.code === "ETIMEDOUT";
        reject(signal.reason);
      }, { once: true });
    })
  }, async broker => {
    const response = await post(broker, "/v1/chat/completions", { messages: [{ role: "user", content: "wait" }] });
    assert.equal(response.status, 504);
    assert.equal(timedOut, true);
  });

  await withBroker({
    complete: async () => ({ choices: [{ message: { role: "assistant", content: "x".repeat(260 * 1024) } }] })
  }, async broker => {
    const response = await post(broker, "/v1/chat/completions", { messages: [{ role: "user", content: "large" }] });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /byte limit/i);
  });
});

async function consumeEvents(response) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  const frames = text.trim().split(/\r?\n\r?\n/);
  assert.equal(frames.pop(), "data: [DONE]");
  return frames.map(frame => {
    assert.ok(frame.startsWith("data: "));
    return JSON.parse(frame.slice(6));
  });
}

test("streaming content produces OpenAI SSE role, content, finish, usage, and DONE chunks", async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  let observed;
  await withBroker({
    complete: async body => {
      observed = body;
      return {
        id: "chatcmpl-test",
        created: 123,
        model: "actual-private-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello\nworld \u2603" }, finish_reason: "stop" }],
        usage
      };
    }
  }, async broker => {
    const body = {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }]
    };
    const response = await post(broker, "/v1/chat/completions", body);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const chunks = await consumeEvents(response);
    assert.deepEqual(observed, { ...body, stream: false });
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.id, "chatcmpl-test");
      assert.equal(chunk.created, 123);
      assert.equal(chunk.model, "horizon-local");
    }
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks.flatMap(chunk => chunk.choices).map(choice => choice.delta.content || "").join(""), "Hello\nworld \u2603");
    assert.equal(chunks.at(-2).choices[0].finish_reason, "stop");
    assert.deepEqual(chunks.at(-1).usage, usage);
    assert.deepEqual(chunks.at(-1).choices, []);
  });
});

test("streaming tool calls preserve function names, IDs, JSON arguments, and indices", async () => {
  const toolCalls = ["first", "second"].map((id, index) => ({
    id: `call_${id}`,
    type: "function",
    function: { name: "horizon_file_read", arguments: JSON.stringify({ path: `${index}.txt` }) }
  }));
  await withBroker({
    complete: async () => ({
      choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }]
    })
  }, async broker => {
    const response = await post(broker, "/v1/chat/completions", {
      stream: true, messages: [{ role: "user", content: "read" }]
    });
    const chunks = await consumeEvents(response);
    const streamedTools = chunks.flatMap(chunk => chunk.choices).flatMap(choice => choice.delta.tool_calls || []);
    assert.deepEqual(streamedTools, toolCalls.map((call, index) => ({ index, ...call })));
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.match(chunks[0].id, /^chatcmpl-/);
  });
});

test("streaming failures notify the parent and return JSON non-2xx before SSE headers", async t => {
  const cases = [
    { name: "complete throws", complete: async () => { throw new Error("private-foundry-url"); } },
    { name: "malformed response", complete: async () => ({ choices: [] }) },
    { name: "malformed tool call", complete: async () => ({
      choices: [{ message: { role: "assistant", tool_calls: [{ type: "function" }] } }]
    }) },
    { name: "oversized completion", complete: async () => ({
      choices: [{ message: { role: "assistant", content: "x".repeat(256 * 1024) } }]
    }) },
    { name: "SSE envelope exceeds limit", complete: async () => ({
      choices: [{ message: { role: "assistant", content: "x".repeat(256 * 1024 - 150) } }]
    }) }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const failures = [];
      await withBroker({
        complete: scenario.complete,
        onFailure: error => { failures.push(error); }
      }, async broker => {
        const response = await post(broker, "/v1/chat/completions", {
          stream: true, messages: [{ role: "user", content: "fail" }]
        });
        assert.equal(response.status, 502);
        assert.match(response.headers.get("content-type"), /^application\/json/);
        const text = await response.text();
        assert.ok(JSON.parse(text).error);
        assert.equal(text.includes("private-foundry-url"), false);
        assert.equal(text.includes("[DONE]"), false);
        assert.equal(failures.length, 1);
      });
    });
  }
});

test("streaming model limits notify parent and do not duplicate concurrent completions", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  let events = 0;
  const failures = [];
  await withBroker({
    maxModelCalls: 1,
    complete: () => {
      calls += 1;
      entered();
      return new Promise(resolve => { release = resolve; });
    },
    onModel: () => { events += 1; },
    onFailure: error => { failures.push(error); }
  }, async broker => {
    const body = { stream: true, messages: [{ role: "user", content: "one" }] };
    const first = post(broker, "/v1/chat/completions", body);
    await started;
    const limited = await post(broker, "/v1/chat/completions", body);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("content-type"), /^application\/json/);
    assert.equal((await limited.json()).error.code, "model_call_limit");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "model_call_limit");
    assert.equal(calls, 1);
    assert.equal(events, 1);
    release({ choices: [{ message: { role: "assistant", content: "done" } }] });
    assert.equal((await consumeEvents(await first)).at(-1).choices[0].finish_reason, "stop");
  });
});

test("explicit nonstream requests retain the completion JSON shape", async () => {
  const completion = {
    id: "completion-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "plain" }, finish_reason: "stop" }],
    usage: { total_tokens: 1 }
  };
  await withBroker({ complete: async body => {
    assert.equal(body.stream, false);
    return completion;
  } }, async broker => {
    const response = await post(broker, "/v1/chat/completions", {
      stream: false, messages: [{ role: "user", content: "plain" }]
    });
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await response.json(), completion);
  });
});

test("external cancellation aborts pending model work and close promptly destroys active sockets", async () => {
  const controller = new AbortController();
  let aborted = false;
  const broker = await createBroker({
    definitions,
    invoke: async () => null,
    signal: controller.signal,
    complete: (_body, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    })
  });
  const pending = post(broker, "/v1/chat/completions", { messages: [{ role: "user", content: "cancel" }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await broker.close();
  await assert.rejects(pending);
  assert.equal(aborted, true);
});

test("tool invocation timeout aborts approval and signals failure", async () => {
  let failure;
  let aborted = false;
  await withBroker({
    timeoutMs: 40,
    invoke: (_name, _args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    onFailure: error => { failure = error; }
  }, async broker => {
    const response = await post(broker, "/tools/call", { name: "file_read", arguments: { path: "x" } });
    assert.equal(response.status, 504);
    assert.equal(aborted, true);
    assert.match(failure.message, /timed out/);
  });
});
