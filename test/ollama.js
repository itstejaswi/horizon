"use strict";
/*
 * Ollama provider: runs against a stub Ollama, so it needs no model and no
 * network. Covers the native API mapping (tags, ps, pull, delete, load,
 * unload), name handling, and the server wired to the provider end to end.
 *
 *   node --test test/ollama.js
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const { createOllama, isSafeAlias } = require(path.join(ROOT, "src", "ollama.js"));
const { createProvider } = require(path.join(ROOT, "src", "providers.js"));
const { loadConfig } = require(path.join(ROOT, "src", "config.js"));

function startStubOllama({ completion } = {}) {
  const calls = [];
  const resident = new Set();
  const installed = new Map([
    ["stub:3b", { name: "stub:3b", size: 2 * 1024 * 1024 * 1024, details: { parameter_size: "3B", quantization_level: "Q4_K_M" } }],
    ["llama3.2:latest", { name: "llama3.2:latest", size: 1024 * 1024 * 1024, details: {} }],
    ["nomic-embed-text:latest", { name: "nomic-embed-text:latest", size: 300 * 1024 * 1024, details: { family: "nomic-bert" } }]
  ]);

  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      const json = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
        res.end(data);
      };
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ method: req.method, url, body });

        if (url === "/api/version") return json(200, { version: "0.6.1" });
        if (url === "/api/tags") return json(200, { models: [...installed.values()] });
        if (url === "/api/ps") return json(200, { models: [...resident].map(name => ({ name, size_vram: 0 })) });
        if (url === "/api/generate") {
          if (!installed.has(body.model)) return json(404, { error: `model '${body.model}' not found` });
          if (body.keep_alive === 0) resident.delete(body.model);
          else resident.add(body.model);
          return json(200, { done: true });
        }
        if (url === "/api/delete" && req.method === "DELETE") {
          if (!installed.delete(body.model)) return json(404, { error: "model not found" });
          return json(200, {});
        }
        if (url === "/api/pull") {
          if (body.model === "missing:model") {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            return res.end(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n");
          }
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          const mb = 1024 * 1024;
          for (const event of [
            { status: "pulling manifest" },
            { status: "pulling aaa", digest: "sha256:aaa", total: 100 * mb, completed: 25 * mb },
            { status: "pulling aaa", digest: "sha256:aaa", total: 100 * mb, completed: 100 * mb },
            { status: "pulling bbb", digest: "sha256:bbb", total: 100 * mb, completed: 50 * mb },
            { status: "success" }
          ]) res.write(JSON.stringify(event) + "\n");
          installed.set(body.model, { name: body.model, size: 200 * mb, details: {} });
          return res.end();
        }
        if (req.method === "GET" && url === "/v1/models") {
          return json(200, { data: [...installed.keys()].map(id => ({ id })) });
        }
        if (req.method === "POST" && url === "/v1/chat/completions") {
          if (completion) return json(200, completion(body));
          return json(200, {
            model: body.model,
            choices: [{ message: { role: "assistant", content: "ollama stub reply" } }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 }
          });
        }
        json(404, { error: "stub: not found" });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, resident, installed, port: server.address().port }));
  });
}

const baseOf = stub => `http://127.0.0.1:${stub.port}`;

test("ollama names: accepts library, tagged and Hugging Face names; rejects unsafe ones", () => {
  for (const good of ["llama3.2", "qwen2.5:3b", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", "phi4-mini"]) {
    assert.equal(isSafeAlias(good), true, `must accept: ${good}`);
  }
  for (const bad of ["", "-rf", "a b", "a;b", "a&&b", "../x", "a//b", "a`b`", "x".repeat(129), null, 5]) {
    assert.equal(isSafeAlias(bad), false, `must reject: ${bad}`);
  }
});

test("providers: config selects the runtime and rejects unknown ones", () => {
  assert.equal(createProvider({ provider: "foundry" }).name, "foundry");
  assert.equal(createProvider({ provider: "ollama", ollama: {} }).name, "ollama");
  assert.throws(() => createProvider({ provider: "nope" }), /Unknown model provider/);

  const fallback = loadConfig([], {});
  assert.equal(fallback.provider, "foundry");
  const ollama = loadConfig(["--provider=ollama"], {});
  assert.equal(ollama.provider, "ollama");
  assert.equal(ollama.model.alias, "llama3.2:3b", "Ollama must not inherit a Foundry-only default model");
  assert.equal(loadConfig(["--provider=ollama", "--model-alias=qwen2.5:3b"], {}).model.alias, "qwen2.5:3b");
  assert.throws(() => loadConfig(["--provider=nope"], {}), /Invalid model provider/);
});

test("ollama: both providers expose the same surface", () => {
  const foundry = createProvider({ provider: "foundry" });
  const ollama = createProvider({ provider: "ollama", ollama: {} });
  const missing = Object.keys(foundry).filter(key => key !== "ENDPOINT_PATTERN" && !(key in ollama));
  assert.deepEqual(missing, [], `ollama is missing: ${missing.join(", ")}`);
});

test("ollama: discovers the endpoint and reports status", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    assert.equal(await ollama.discoverEndpoint(), baseOf(stub));
    const status = await ollama.serverStatus();
    assert.equal(status.running, true);
    assert.deepEqual(await ollama.isInstalled(), { installed: true, version: "0.6.1" });
  } finally {
    stub.server.close();
  }

  const down = createOllama({ baseUrl: "http://127.0.0.1:1" });
  assert.equal(await down.discoverEndpoint(500), null);
  assert.equal((await down.serverStatus(500)).running, false);
});

test("ollama: models report size, type and what is resident", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    stub.resident.add("stub:3b");
    const models = await ollama.cachedModels();
    const byName = Object.fromEntries(models.map(model => [model.alias, model]));
    assert.equal(byName["stub:3b"].loaded, true);
    assert.equal(byName["stub:3b"].sizeMb, 2048);
    assert.equal(byName["stub:3b"].quantization, "Q4_K_M");
    assert.equal(byName["llama3.2:latest"].loaded, false);
    assert.equal(byName["nomic-embed-text:latest"].type, "Embedding");
    assert.equal(byName["stub:3b"].type, "Chat");
  } finally {
    stub.server.close();
  }
});

test("ollama: catalogue merges installed models with suggestions and filters", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    const all = await ollama.catalogue({});
    assert.ok(all.some(model => model.alias === "stub:3b" && model.cached));
    assert.ok(all.some(model => model.alias === "qwen2.5:3b" && !model.cached && model.suggested));
    assert.equal(all.filter(model => model.alias === "llama3.2:3b").length, 1);

    const cachedOnly = await ollama.catalogue({ cached: true });
    assert.ok(cachedOnly.every(model => model.cached));

    const search = await ollama.catalogue({ search: "qwen" });
    assert.ok(search.length > 0 && search.every(model => model.alias.includes("qwen")));
    assert.equal((await ollama.catalogue({ type: "embedding" })).length, 1);
  } finally {
    stub.server.close();
  }
});

test("ollama: load, readiness and unload use keep_alive on the native API", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub), keepAlive: "10m" });
    assert.equal(await ollama.isModelLoaded("stub:3b"), false);
    assert.equal(await ollama.isModelAvailable("stub:3b"), true, "installed means usable, since Ollama loads on demand");
    assert.equal(await ollama.isModelAvailable("nothing:1b"), false);

    assert.equal(await ollama.ensureLoaded("stub:3b"), true);
    assert.equal(await ollama.ensureLoaded("stub:3b"), false, "an already resident model is not loaded twice");
    assert.equal(stub.calls.find(call => call.url === "/api/generate").body.keep_alive, "10m");
    assert.equal(await ollama.isModelLoaded("stub:3b"), true);

    await ollama.unloadModel("stub:3b");
    assert.equal(stub.calls.filter(call => call.url === "/api/generate").pop().body.keep_alive, 0);
    assert.equal(await ollama.isModelLoaded("stub:3b"), false);

    await assert.rejects(ollama.loadModel("ghost:1b"), /Could not load "ghost:1b".*not found/);
    await assert.rejects(ollama.loadModel("bad name"), /Rejected model name/);
  } finally {
    stub.server.close();
  }
});

test("ollama: a bare name matches its latest tag", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    assert.equal(await ollama.resolveModelId(`${baseOf(stub)}/v1`, "llama3.2", 2000), "llama3.2:latest");
    assert.equal(await ollama.resolveModelId(`${baseOf(stub)}/v1`, "stub:3b", 2000), "stub:3b");
    await assert.rejects(ollama.resolveModelId(`${baseOf(stub)}/v1`, "absent", 2000), /No installed model matches "absent".*ollama pull absent/);

    stub.resident.add("llama3.2:latest");
    assert.equal(await ollama.isModelLoaded("llama3.2"), true);
  } finally {
    stub.server.close();
  }
});

test("ollama: download streams combined progress and surfaces pull errors", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    const seen = [];
    await ollama.downloadModel("tiny:1b", progress => seen.push(progress));

    const percents = seen.map(item => item.percent);
    assert.deepEqual([...percents].sort((a, b) => a - b), percents, "progress never goes backwards");
    assert.ok(percents.includes(25), `expected a 25% report, got ${percents}`);
    assert.ok(percents.slice(0, -1).every(value => value <= 99), "only completion reports 100%");
    assert.equal(percents.at(-1), 100);
    assert.equal(seen[0].sizeMb, 100);
    assert.ok(stub.installed.has("tiny:1b"));

    await assert.rejects(ollama.downloadModel("missing:model"), /Could not download "missing:model".*does not exist/);
    await assert.rejects(ollama.downloadModel("x;y"), /Rejected model name/);
  } finally {
    stub.server.close();
  }
});

test("ollama: remove deletes the model and reports failures", async () => {
  const stub = await startStubOllama();
  try {
    const ollama = createOllama({ baseUrl: baseOf(stub) });
    await ollama.removeModel("llama3.2:latest");
    assert.equal(stub.installed.has("llama3.2:latest"), false);
    assert.equal(stub.calls.find(call => call.url === "/api/delete").method, "DELETE");
    await assert.rejects(ollama.removeModel("llama3.2:latest"), /Could not remove/);
  } finally {
    stub.server.close();
  }
});

test("ollama: refuses a non-loopback endpoint, naming Ollama", () => {
  const ollama = createOllama({});
  assert.throws(() => ollama.assertLoopback("http://example.com/v1"), /non-loopback Ollama endpoint/);
  assert.doesNotThrow(() => ollama.assertLoopback("http://127.0.0.1:11434/v1"));
});

test("ollama: settings are not changeable and stop needs a process Horizon started", async () => {
  const ollama = createOllama({ baseUrl: "http://127.0.0.1:1" });
  assert.deepEqual(await ollama.settings(), []);
  await assert.rejects(ollama.setSetting("port", "1"), /no settings/);
  await assert.rejects(ollama.stopServer(), /not started by Horizon/);
});

/* --------------------------------------------------- server, end to end ---- */

function startApp(env) {
  return new Promise((resolve, reject) => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-ollama-"));
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
      env: { ...process.env, ...env, HORIZON_RUNTIME_DIR: runtimeDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start\n${out}`)), 60000);
    child.stdout.on("data", chunk => {
      out += chunk;
      const match = /Open:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match && /Press Ctrl\+C to stop/.test(out)) {
        clearTimeout(timer);
        resolve({ child, url: match[1], output: () => out, runtimeDir });
      }
    });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("exit", code => {
      clearTimeout(timer);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      reject(new Error(`server exited (${code})\n${out}`));
    });
  });
}

const ollamaEnv = (stub, alias) => ({
  HORIZON_PROVIDER: "ollama",
  HORIZON_OLLAMA_URL: baseOf(stub),
  HORIZON_MODEL_ALIAS: alias,
  HORIZON_PORT: "0",
  HORIZON_OPEN_BROWSER: "false",
  HORIZON_WARM_UP: "false",
  HORIZON_OLLAMA_AUTOSTART: "false",
  HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
});

test("ollama: the server serves chat and model management through the provider", async () => {
  const stub = await startStubOllama();
  const app = await startApp(ollamaEnv(stub, "stub:3b"));
  try {
    assert.match(app.output(), /Ollama: http:\/\/127\.0\.0\.1:\d+\/v1/);

    const status = await (await fetch(`${app.url}/api/status`)).json();
    assert.equal(status.provider.name, "ollama");
    assert.equal(status.ready, true, "an installed model is ready even before it is resident");
    assert.equal(status.model, "stub:3b");

    const reply = await fetch(`${app.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }], stream: false })
    });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).reply, "ollama stub reply");
    assert.ok(stub.resident.has("stub:3b"), "the chosen model is made resident before the first reply");

    const models = await (await fetch(`${app.url}/api/models`)).json();
    assert.ok(models.models.some(model => model.alias === "stub:3b"));
    assert.ok(!models.models.some(model => model.alias === "nomic-embed-text:latest"), "embedding models are not offered for chat");

    const downloaded = await fetch(`${app.url}/api/foundry/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "tiny:1b" })
    });
    assert.equal(downloaded.status, 200);
    assert.ok(stub.installed.has("tiny:1b"));

    const info = await (await fetch(`${app.url}/api/foundry`)).json();
    assert.equal(info.installed, true);
    assert.equal(info.running, true);
    assert.equal(info.provider.label, "Ollama");

    const dictation = await (await fetch(`${app.url}/api/dictation`)).json();
    assert.equal(dictation.available, false);
    assert.match(dictation.reason, /Foundry Local/);
  } finally {
    app.child.kill();
    stub.server.close();
  }
});

test("ollama: Horizon Native executes a real file tool through function calls and persists its outcome", async () => {
  const stub = await startStubOllama({
    completion: body => ({
      choices: [{ message: body.messages.some(message => message.role === "tool")
        ? { role: "assistant", content: "Read the observed native note." }
        : {
          role: "assistant", content: null,
          tool_calls: [{ id: "read_note", type: "function", function: { name: "file_read", arguments: '{"path":"note.txt"}' } }]
        } }]
    })
  });
  const app = await startApp(ollamaEnv(stub, "stub:3b"));
  try {
    fs.writeFileSync(path.join(app.runtimeDir, "note.txt"), "Evidence from the actual file.");
    const initial = await (await fetch(`${app.url}/api/agents`)).json();
    const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": initial.csrfToken };
    const configured = await fetch(`${app.url}/api/agents/settings`, {
      method: "POST", headers,
      body: JSON.stringify({
        ...initial.settings, enabled: true, roots: [app.runtimeDir],
        flags: { files: true, commands: false, browser: false, mcp: false },
        chat: { ...initial.settings.chat, protocol: "native", tools: ["file_read"], maxSteps: 1 }
      })
    });
    assert.equal(configured.status, 200);
    const started = await fetch(`${app.url}/api/chat`, {
      method: "POST", headers,
      body: JSON.stringify({ messages: [{ role: "user", content: "Read note.txt." }] })
    });
    assert.equal(started.status, 200);
    const { run } = await started.json();
    let finished;
    for (let attempt = 0; attempt < 200; attempt++) {
      finished = await (await fetch(`${app.url}/api/agents/run?id=${encodeURIComponent(run.id)}`)).json();
      if (["completed", "failed", "cancelled"].includes(finished.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert.equal(finished.result, "Read the observed native note.");
    assert.equal(finished.verification.status, "not_configured");
    const requests = stub.calls.filter(call => call.url === "/v1/chat/completions");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.tools[0].function.name, "file_read");
    assert.match(requests[1].body.messages.at(-1).content, /Evidence from the actual file/);
    assert.ok(finished.events.some(event => event.type === "backend" && /Horizon Native/.test(event.message)));
    const disk = JSON.parse(fs.readFileSync(path.join(app.runtimeDir, "agent-data.json")));
    assert.equal(disk.runs.find(item => item.id === run.id).status, "completed");
  } finally {
    app.child.kill();
    stub.server.close();
  }
});

test("ollama: a stopped Ollama is a state to show, not a reason to refuse to start", async () => {
  const stub = await startStubOllama();
  const port = stub.port;
  await new Promise(resolve => stub.server.close(resolve));
  const app = await startApp({ ...ollamaEnv({ port }, "stub:3b") });
  try {
    const status = await (await fetch(`${app.url}/api/status`)).json();
    assert.equal(status.ready, false);
    assert.match(status.error, /Ollama is not running/);
    assert.equal(status.provider.name, "ollama");
  } finally {
    app.child.kill();
  }
});
