"use strict";

// Explicit acceptance test for the optional OpenClaw backend. It drives the
// real pinned OpenClaw runtime through Horizon's engine, broker, bridge plugin
// and file tools on synthetic files. By default decisions come from a scripted
// model, which proves the runtime contract but not model reliability. Set
// HORIZON_AGENT_TEST_BASE_URL and HORIZON_AGENT_TEST_MODEL to an already-loaded
// local model to run the same file task with real inference: any loopback
// OpenAI-compatible endpoint, such as Foundry Local's or Ollama's
// (http://127.0.0.1:11434/v1 with a model like qwen2.5:3b).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentService, DEFAULT_SETTINGS } = require("../src/agents");
const tools = require("../src/agent-tools");
const { createOpenClawOrchestrator, runtimeStatus } = require("../src/openclaw-runtime");
const { isLoopbackHost } = require("../src/net");
const { createClient } = require("../src/openai-client");

// Provider-neutral: the same loopback client Foundry and Ollama both use.
const { agentCompletion } = createClient({ label: "Local model" });

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function localModel() {
  const endpoint = process.env.HORIZON_AGENT_TEST_BASE_URL;
  const model = process.env.HORIZON_AGENT_TEST_MODEL;
  if (!endpoint && !model) return null;
  if (!endpoint || !model) throw new Error("Set both HORIZON_AGENT_TEST_BASE_URL and HORIZON_AGENT_TEST_MODEL, or neither for the scripted contract run.");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("The agent test endpoint must be plain HTTP on loopback, with no credentials, query or fragment.");
  }
  const baseUrl = url.href.replace(/\/$/, "");
  return {
    model,
    complete: (body, signal) => agentCompletion(baseUrl, { ...body, model, stream: false }, signal)
  };
}

// Reads source.txt, writes copy.txt with what it read, then answers.
function scriptedModel(state) {
  return async (body, signal) => {
    state.requests.push(body);
    if (state.hang) {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    const results = body.messages.filter(message => message.role === "tool");
    const call = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_${results.length + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (results.length === 0) return call("horizon_file_read", { path: "source.txt" });
    if (results.length === 1) {
      const read = JSON.parse(typeof results[0].content === "string" ? results[0].content : results[0].content.map(part => part.text).join(""));
      return call("horizon_file_write", { path: "copy.txt", content: read.content });
    }
    return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Copied source.txt to copy.txt." } }] };
  };
}

async function waitFor(service, id, onApproval) {
  let run;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    run = service.getRun(id);
    if (run.approval && onApproval) onApproval(run);
  } while (!TERMINAL.has(run.status));
  return run;
}

function leftoverRuntimeDirs(since) {
  return fs.readdirSync(os.tmpdir())
    .filter(name => name.startsWith("horizon-openclaw-") && !name.startsWith("horizon-openclaw-test-"))
    .filter(name => fs.statSync(path.join(os.tmpdir(), name)).mtimeMs >= since);
}

async function main() {
  const status = runtimeStatus();
  if (!status.available) throw new Error(`OpenClaw runtime unavailable: ${status.error} Run "npm run setup:openclaw" where your device policy permits it.`);
  const real = localModel();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-openclaw-test-"));
  const files = path.join(directory, "files");
  fs.mkdirSync(files);
  const original = "Synthetic Horizon OpenClaw fixture.";
  const started = Date.now();
  const state = { requests: [], hang: false };
  const executed = [];
  const complete = real ? real.complete : scriptedModel(state);
  const agentTools = {
    ...tools,
    execute: async (name, args, settings, signal) => {
      executed.push({ name, args });
      return tools.execute(name, args, settings, signal);
    }
  };
  const service = new AgentService({
    directory: path.join(directory, "state"), tools: agentTools, complete,
    orchestrate: createOpenClawOrchestrator({ tools: agentTools, complete }),
    openclawStatus: runtimeStatus
  });
  const summary = { openclaw: status.version, node: process.version, platform: `${process.platform}-${process.arch}`, model: real ? real.model : "scripted" };
  try {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), enabled: true, backend: "openclaw", roots: [files] };
    settings.flags.files = true;
    // CPU inference with OpenClaw's long system prompt can take minutes per call.
    settings.chat = { ...settings.chat, tools: ["file_read", "file_write"], maxSteps: 4, timeoutMs: real ? 1800000 : 300000 };
    service.saveSettings(settings);
    const ask = "Read source.txt in the approved folder, then create copy.txt with exactly the same content.";
    const expectWrite = run => {
      assert.equal(run.approval.tool, "file_write");
      assert.equal(path.resolve(files, run.approval.args.path), path.join(files, "copy.txt"), "Reject an unexpected target.");
      assert.equal(run.approval.args.content, original);
    };

    // 1. Approved dependent read -> write.
    fs.writeFileSync(path.join(files, "source.txt"), original);
    let approvals = 0;
    let run = await waitFor(service, service.chat([{ role: "user", content: ask }]).id, pending => {
      expectWrite(pending);
      approvals++;
      service.approve(pending.id, pending.approval.id, true);
    });
    if (run.status !== "completed") {
      console.error(run.events.map(event => `${new Date(event.at).toISOString().slice(11, 19)} ${event.type}: ${event.message}`).join("\n"));
    }
    assert.equal(run.status, "completed", run.error || "OpenClaw did not complete the task.");
    assert.equal(approvals, 1, "The write needs exactly one exact-call approval.");
    assert.equal(fs.readFileSync(path.join(files, "copy.txt"), "utf8"), original);
    assert.equal(executed.filter(call => call.name === "file_write").length, 1, "The write must not be replayed.");
    assert.ok(run.events.some(event => event.type === "backend"));
    if (!real) {
      for (const request of state.requests) {
        assert.deepEqual(request.tools.map(item => item.function.name).sort(), ["horizon_file_read", "horizon_file_write"], "OpenClaw exposed a tool Horizon did not grant.");
        assert.equal(request.model, undefined);
      }
    }
    summary.approved = { status: run.status, modelCalls: state.requests.length || undefined, toolCalls: executed.length };

    // 2. Denied write: nothing written, run fails, no completion claim.
    fs.rmSync(path.join(files, "copy.txt"));
    executed.length = 0;
    run = await waitFor(service, service.chat([{ role: "user", content: ask }]).id, pending => {
      service.approve(pending.id, pending.approval.id, false);
    });
    assert.equal(run.status, "failed");
    assert.match(run.error, /denied/i);
    assert.equal(fs.existsSync(path.join(files, "copy.txt")), false);
    assert.equal(executed.filter(call => call.name === "file_write").length, 0);
    summary.denied = { status: run.status, error: run.error };

    // 3. Cancel during inference: the process and its state are released.
    if (!real) {
      state.hang = true;
      const queued = service.chat([{ role: "user", content: ask }]);
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (state.requests.length && service.getRun(queued.id).status === "running") {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      const before = state.requests.length;
      await new Promise(resolve => setTimeout(resolve, 200));
      service.cancel(queued.id, "Cancelled by acceptance test.");
      run = await waitFor(service, queued.id);
      assert.equal(run.status, "cancelled");
      assert.equal(state.requests.length, before, "No further model calls after cancel.");
      summary.cancelled = { status: run.status };
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(leftoverRuntimeDirs(started), [], "Per-run OpenClaw state must be removed.");
    summary.note = real
      ? "Real local model through real OpenClaw on synthetic files; not a general reliability guarantee."
      : "Real OpenClaw with scripted model decisions: proves the runtime contract, not model reliability.";
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`OpenClaw acceptance failed: ${error.message}`);
  process.exitCode = 1;
});
