"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOpenClawOrchestrator, runtimeStatus, buildConfig, buildMessage, finalText } = require("../src/openclaw-runtime");
const { AgentService, DEFAULT_SETTINGS } = require("../src/agents");

const FAKE = path.join(__dirname, "fixtures", "fake-openclaw.mjs");
const definition = name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } } });
const settings = { flags: { files: true }, roots: [], commands: [], mcpServers: [] };

function harness(t, { complete, status } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-oc-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const requests = [];
  const orchestrate = createOpenClawOrchestrator({
    tools: { definitions: () => ["file_read", "file_write"].map(definition) },
    complete: complete || (async body => {
      requests.push(body);
      return { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "horizon_file_read", arguments: '{"path":"a.txt"}' } }] } }] };
    }),
    status: status || (() => ({ available: true, version: "test", entry: FAKE })),
    tempRoot
  });
  const run = (prompt, options = {}) => orchestrate({
    agent: { tools: ["file_read"], instructions: "", maxSteps: 3, timeoutMs: 20000 },
    prompt, settings, history: undefined, signal: options.signal || new AbortController().signal,
    invoke: options.invoke || (async () => "FILE-CONTENT"),
    onModel: () => {}
  });
  return { run, requests, tempRoot };
}

test("OpenClaw adapter routes tool calls through Horizon and returns the parsed reply", async t => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const invoked = [];
  const { run, requests, tempRoot } = harness(t);
  const reply = await run("Read a.txt", { invoke: async (tool, args) => { invoked.push({ tool, args }); return "FILE-CONTENT"; } });
  assert.match(reply, /tool=FILE-CONTENT/);
  assert.deepEqual(invoked, [{ tool: "file_read", args: { path: "a.txt" } }]);
  const report = JSON.parse(/report=(\{.*\})/.exec(reply)[1]);
  assert.deepEqual(report.envKeys, ["HORIZON_BROKER_TOKEN"], "only the broker credential reaches OpenClaw");
  assert.equal(report.configHasToken, false, "the credential is never written to config");
  assert.equal(report.apiKey, "${HORIZON_BROKER_TOKEN}");
  // Ungranted file_write never reaches the model; OpenClaw-only fields are dropped.
  assert.deepEqual(requests[0].tools.map(item => item.function.name), ["horizon_file_read"]);
  assert.equal(requests[0].model, undefined);
  assert.equal(requests[0].stream_options, undefined);
  assert.equal(requests[0].max_tokens, 77);
  assert.deepEqual(fs.readdirSync(tempRoot), [], "per-run state is removed");
});

test("an unavailable OpenClaw runtime fails explicitly without starting anything", async t => {
  const { run, requests } = harness(t, { status: () => ({ available: false, error: "OpenClaw 2026.6.34 is not installed." }) });
  await assert.rejects(run("Act"), /OpenClaw is unavailable: OpenClaw 2026\.6\.34 is not installed/);
  assert.equal(requests.length, 0);
});

test("a denied or failed Horizon tool fails the run even when OpenClaw claims success", async t => {
  const { run } = harness(t);
  await assert.rejects(
    run("Read a.txt", { invoke: async () => { throw new Error("Tool approval was denied."); } }),
    /OpenClaw run failed in Horizon: Tool approval was denied\..*may already have taken effect/
  );
});

test("a failed local model call is not hidden behind OpenClaw's reply", async t => {
  const { run } = harness(t, { complete: async () => { throw new Error("Load a local model first."); } });
  await assert.rejects(run("Read a.txt"), /OpenClaw run failed in Horizon/);
});

test("cancelling a run terminates the OpenClaw process tree and removes its state", async t => {
  const { run, tempRoot } = harness(t);
  const controller = new AbortController();
  const pending = run("MODE:hang", { signal: controller.signal });
  let pid;
  for (let i = 0; i < 200 && !pid; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const dir = fs.readdirSync(tempRoot)[0];
    const file = dir && path.join(tempRoot, dir, "state", "pid");
    if (file && fs.existsSync(file)) pid = Number(fs.readFileSync(file, "utf8"));
  }
  assert.ok(pid, "fake runtime started");
  controller.abort(new Error("Cancelled by user."));
  await assert.rejects(pending, /Cancelled by user/);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, "OpenClaw process was terminated");
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test("malformed output and non-zero exits are visible failures", async t => {
  const { run } = harness(t);
  await assert.rejects(run("MODE:garbage"), /not the expected JSON result/);
  await assert.rejects(run("MODE:exit"), /exited with code 3\. boom/);
  assert.throws(() => finalText('{"payloads":[]}'), /without a final answer/);
  assert.throws(() => finalText('{"error":{"message":"bad"}}'), /reported an error: bad/);
});

test("generated config allows only granted bridge tools and the local provider", () => {
  const config = buildConfig({ baseUrl: "http://127.0.0.1:1234", definitions: [definition("file_read")], workspace: "w", timeoutSeconds: 5, maxTokens: 10 });
  assert.deepEqual(config.tools.allow, ["horizon_file_read"]);
  assert.deepEqual(config.plugins.allow, ["horizon-bridge"]);
  assert.equal(config.models.mode, "replace");
  assert.deepEqual(Object.keys(config.models.providers), ["horizon"]);
  assert.equal(config.models.providers.horizon.baseUrl, "http://127.0.0.1:1234/v1");
  assert.deepEqual(config.agents.defaults.model, { primary: "horizon/horizon-local", fallbacks: [] });
  assert.deepEqual(config.agents.defaults.skills, []);
  assert.equal(config.agents.defaults.contextInjection, "never");
  assert.equal(config.agents.defaults.experimental, undefined, "lean mode replaces granted tools with a wrapper the broker refuses");
  assert.match(buildMessage({ agent: { instructions: "" }, prompt: "Go", settings }), /relative to an approved folder/);
});

test("runtime status reports missing, mismatched and unsupported installs", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-oc-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.match(runtimeStatus({ runtimeDir: dir }).error, /manifest is missing/);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.6.34" } }));
  assert.match(runtimeStatus({ runtimeDir: dir, nodeVersion: "v20.0.0" }).error, /needs Node 22\.19\.0/);
  assert.match(runtimeStatus({ runtimeDir: dir, nodeVersion: "v22.19.0" }).error, /not installed/);
  fs.mkdirSync(path.join(dir, "node_modules", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "openclaw", "package.json"), JSON.stringify({ version: "2026.9.1", bin: { openclaw: "openclaw.mjs" } }));
  assert.match(runtimeStatus({ runtimeDir: dir, nodeVersion: "v24.1.0" }).error, /does not match the tested pin/);
});

test("OpenClaw cannot be selected while its runtime is unavailable, and its status is public-safe", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-oc-agents-"));
  let status = { available: false, error: "OpenClaw 2026.6.34 is not installed." };
  const service = new AgentService({
    directory, tools: { definitions: () => [], execute: async () => "", close: async () => {} },
    complete: async () => ({}), orchestrate: async () => "", openclawStatus: () => status
  });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const settings = { ...structuredClone(DEFAULT_SETTINGS), backend: "openclaw" };
  assert.throws(() => service.saveSettings(settings), /cannot be selected: OpenClaw 2026\.6\.34 is not installed/);
  assert.deepEqual(service.snapshot().openclaw, { available: false, error: "OpenClaw 2026.6.34 is not installed." });
  status = { available: true, version: "2026.6.34", entry: "C:\\secret\\path\\openclaw.mjs" };
  service.saveSettings(settings);
  assert.deepEqual(service.snapshot().openclaw, { available: true, version: "2026.6.34" });
});
