"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentService, DEFAULT_SETTINGS } = require("../src/agents");
const tools = require("../src/agent-tools");
const { isLoopbackHost } = require("../src/net");

async function main() {
  const endpoint = process.env.HORIZON_AGENT_TEST_BASE_URL;
  const model = process.env.HORIZON_AGENT_TEST_MODEL;
  if (!endpoint || !model) throw new Error("Set HORIZON_AGENT_TEST_BASE_URL to the running local /v1 endpoint and HORIZON_AGENT_TEST_MODEL to an already-loaded model ID. No model is downloaded or loaded by this test.");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("The agent test endpoint must be plain HTTP on loopback, with no credentials, query or fragment.");
  }
  const baseUrl = url.href.replace(/\/$/, "");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-local-agent-test-"));
  const files = path.join(directory, "files");
  fs.mkdirSync(files);
  const original = "Synthetic Horizon orchestration fixture.";
  fs.writeFileSync(path.join(files, "source.txt"), original);
  let inferenceCalls = 0;
  const executed = [];
  const service = new AgentService({
    directory: path.join(directory, "state"),
    tools: {
      ...tools,
      execute: async (name, args, settings, signal) => {
        executed.push({ name, args });
        return tools.execute(name, args, settings, signal);
      }
    },
    complete: async (body, signal) => {
      inferenceCalls++;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model }), signal, redirect: "error"
      });
      if (!response.ok) throw new Error(`Local inference failed (HTTP ${response.status}): ${(await response.text()).slice(0, 1000)}`);
      return response.json();
    }
  });
  try {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), enabled: true, planning: true, roots: [files] };
    settings.flags.files = true;
    service.saveSettings(settings);
    const agent = service.saveAgent({
      name: "Synthetic orchestration acceptance", instructions: "Work only on the synthetic files in the approved folder. Follow the JSON planning contract exactly.",
      prompt: 'First read source.txt. Then create a NEW copy.txt with exactly the content returned by the first read, using a structured result reference. Finally overwrite the EXISTING source.txt with exactly "Updated synthetic fixture.", using the first read result\'s SHA-256 reference as expectedSha256. Do not invent file hashes. No optional predicates are needed; the engine independently verifies both writes.',
      tools: ["file_read", "file_write"], unattendedTools: [], steps: [], protocol: "structured",
      maxSteps: 8, timeoutMs: 300000, schedule: { enabled: false, intervalMinutes: 60 }
    });
    const queued = service.run(agent.id);
    let approvals = 0, run;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      run = service.getRun(queued.id);
      if (run.approval) {
        assert.equal(run.approval.tool, "file_write");
        const args = run.approval.args;
        const target = path.resolve(files, args.path);
        assert.ok([path.join(files, "copy.txt"), path.join(files, "source.txt")].includes(target), "Reject an unexpected target, even inside the synthetic test.");
        if (target === path.join(files, "copy.txt")) {
          assert.equal(args.content, original);
          assert.notEqual(args.overwrite, true);
        } else {
          assert.equal(args.content, "Updated synthetic fixture.");
          assert.equal(args.overwrite, true);
          assert.match(args.expectedSha256, /^[a-f0-9]{64}$/i);
        }
        approvals++;
        service.approve(run.id, run.approval.id, true);
      }
    } while (!["completed", "failed", "cancelled"].includes(run.status));
    assert.equal(run.status, "completed", run.error || "The local model did not execute the task.");
    assert.equal(approvals, 2, "Both distinct writes must pass exact-call approval.");
    assert.equal(fs.readFileSync(path.join(files, "copy.txt"), "utf8"), original);
    assert.equal(fs.readFileSync(path.join(files, "source.txt"), "utf8"), "Updated synthetic fixture.");
    const writes = run.plan?.steps.filter(step => step.tool === "file_write") || [];
    assert.equal(writes.length, 2);
    assert.ok(writes.every(step => step.status === "completed" && step.verification === "passed"));
    assert.equal(executed.filter(call => call.name === "file_write").length, 2, "Neither write may be replayed.");
    assert.ok(writes.some(step => JSON.stringify(step.args).includes("$result")), "Exercise dependent structured result references, not only literal arguments.");
    const persisted = JSON.parse(fs.readFileSync(service.file, "utf8")).runs[0];
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.plan.steps.filter(step => step.verification === "passed").length, 2);
    console.log(JSON.stringify({
      status: run.status, model, inferenceCalls, approvals, toolCalls: executed.length,
      checkedWrites: writes.length, verification: run.verification,
      note: "Synthetic local multi-step acceptance only; not a general model-reliability guarantee."
    }, null, 2));
  } finally {
    await service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Local agent acceptance failed: ${error.message}`);
  process.exitCode = 1;
});
