"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

test("local agent API rejects cross-origin changes and executes a durable offline workflow", { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-agent-api-"));
  const runtime = path.join(directory, "runtime");
  const notes = path.join(directory, "notes");
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "note.txt"), "A personal offline note.");
  let inferenceCalls = 0;
  const resident = new Set();
  const stub = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = (req.url || "").split("?")[0];
    if (req.method === "GET" && url === "/api/version") return res.end(JSON.stringify({ version: "0.6.1" }));
    if (req.method === "GET" && url === "/api/tags") {
      return res.end(JSON.stringify({ models: [{ name: "stub-model", size: 1024, details: {} }] }));
    }
    if (req.method === "GET" && url === "/api/ps") {
      return res.end(JSON.stringify({ models: [...resident].map(name => ({ name, size_vram: 0 })) }));
    }
    if (req.method === "GET" && url === "/v1/models") {
      return res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    }
    if (req.method === "POST" && url === "/api/generate") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      return req.on("end", () => {
        const request = JSON.parse(body || "{}");
        if (request.model !== "stub-model") {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "model not found" }));
        }
        if (request.keep_alive === 0) resident.delete(request.model);
        else resident.add(request.model);
        res.end(JSON.stringify({ model: request.model, response: "", done: true }));
      });
    }
    if (req.method !== "POST" || url !== "/v1/chat/completions") {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: `Unexpected stub request: ${req.method} ${url}` }));
    }
    inferenceCalls++;
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      const last = request.messages.at(-1)?.content;
      const planning = request.messages[0]?.content.includes("local task planner");
      const content = planning
        ? JSON.stringify({ steps: [{
          title: "Write and verify a planned note", tool: "file_write",
          args: { path: path.join(notes, "planned.txt"), content: "Verified planned write." }
        }] })
        : last === "Read a note in this ordinary conversation."
        ? JSON.stringify({ tool: "file_read", args: { path: path.join(notes, "note.txt") } })
        : last === "Write a note in this ordinary conversation."
          ? JSON.stringify({ tool: "file_write", args: { path: path.join(notes, "chat.txt"), content: "Approved chat write." } })
          : last === "Plan and verify a note in this ordinary conversation."
            ? JSON.stringify({ tool: "file_write", args: { path: path.join(notes, "planned.txt"), content: "Verified planned write." } })
            : '{"final":"complete"}';
      const action = JSON.parse(content);
      const message = request.tools ? action.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "fixture-call", type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }
        : { role: "assistant", content: action.final }
        : { role: "assistant", content };
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve));
  const appEnv = {
    ...process.env, HORIZON_OPEN_BROWSER: "false", HORIZON_PORT: "0",
    HORIZON_ALLOW_MULTIPLE_INSTANCES: "true", HORIZON_RUNTIME_DIR: runtime,
    HORIZON_WARM_UP: "false", HORIZON_PROVIDER: "ollama",
    HORIZON_MODEL_ID: "stub-model", HORIZON_MODEL_ALIAS: "stub-model",
    HORIZON_OLLAMA_AUTOSTART: "false",
    HORIZON_OLLAMA_URL: `http://127.0.0.1:${stub.address().port}`
  };
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const append = chunk => { output += chunk.toString(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => {
        child.once("exit", resolve);
        const timer = setTimeout(resolve, 5000);
        timer.unref();
      });
    }
    await new Promise(resolve => stub.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let address;
  for (let i = 0; i < 500; i++) {
    const match = /Open:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
    if (match) { address = match[1]; break; }
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(address, `Server did not start: ${output}`);
  const get = await fetch(address + "/api/agents");
  assert.equal(get.status, 200);
  const initial = await get.json();
  assert.equal(initial.settings.enabled, false);
  const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": initial.csrfToken };
  const post = (route, body, extraHeaders = {}) => fetch(address + "/api/agents/" + route, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body)
  });
  assert.equal((await fetch(address + "/api/agents/stop", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  })).status, 403);
  assert.equal((await post("stop", {}, { Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await post("stop", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(address + "/api/agents", { headers: { Host: "untrusted.example" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(address + "/api/agents", { headers: { Origin: "null" } })).status, 403);
  assert.equal((await post("stop", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("settings", {
    ...initial.settings, enabled: true, roots: [notes],
    flags: { files: true, commands: false, browser: false, mcp: false }
  })).status, 200);
  const saved = await post("save", {
    name: "Read a note", instructions: "", prompt: "", tools: ["file_read"], unattendedTools: [],
    steps: [{ tool: "file_read", args: { path: path.join(notes, "note.txt") } }],
    maxSteps: 2, timeoutMs: 2000, schedule: { enabled: false, intervalMinutes: 60 }
  });
  assert.equal(saved.status, 200);
  const agent = await saved.json();
  const started = await post("run", { agentId: agent.id });
  assert.equal(started.status, 200);
  let finished;
  for (let i = 0; i < 200; i++) {
    const status = await (await fetch(address + "/api/agents")).json();
    finished = status.runs[0];
    if (["completed", "failed"].includes(finished?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.match(JSON.stringify(finished.result), /personal offline note/);
  assert.equal(inferenceCalls, 0, "Deterministic workflow must not call a model");
  const disk = JSON.parse(fs.readFileSync(path.join(runtime, "agent-data.json")));
  assert.equal(disk.runs[0].status, "completed");
  const pendingAgent = await (await post("save", {
    name: "Needs approval", instructions: "", prompt: "", tools: ["file_write"], unattendedTools: [],
    steps: [{ tool: "file_write", args: { path: path.join(notes, "new.txt"), content: "pending" } }],
    maxSteps: 2, timeoutMs: 20000, schedule: { enabled: false, intervalMinutes: 60 }
  })).json();
  await post("run", { agentId: pendingAgent.id });
  for (let i = 0; i < 200; i++) {
    const snapshot = await (await fetch(address + "/api/agents")).json();
    if (snapshot.runs[1]?.status === "awaiting_approval") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const second = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: { ...appEnv, HORIZON_ALLOW_MULTIPLE_INSTANCES: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let duplicateOutput = "";
  second.stdout.on("data", chunk => { duplicateOutput += chunk.toString(); });
  second.stderr.on("data", chunk => { duplicateOutput += chunk.toString(); });
  const duplicateCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error("Second launch timed out.")); }, 15000);
    second.on("exit", code => { clearTimeout(timer); resolve(code); });
    second.on("error", error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(duplicateCode, 0, duplicateOutput);
  assert.match(duplicateOutput, /already running/);
  const stillPending = JSON.parse(fs.readFileSync(path.join(runtime, "agent-data.json")));
  assert.equal(stillPending.runs[1].status, "awaiting_approval", "A duplicate launch must not recover or overwrite the active instance's data");
  assert.equal(fs.existsSync(path.join(notes, "new.txt")), false);
  assert.equal((await post("stop", {})).status, 200);
  assert.equal((await post("run", { agentId: agent.id })).status, 400);
  assert.equal((await post("settings", {
    ...initial.settings, enabled: true, roots: [notes],
    flags: { files: true, commands: false, browser: false, mcp: false }
  })).status, 200);
  const availability = await (await fetch(address + "/api/chat-tools")).json();
  assert.equal(availability.enabled, true);
  assert.equal(availability.csrfToken, initial.csrfToken);
  const chatBody = content => JSON.stringify({ messages: [{ role: "user", content }] });
  assert.equal((await fetch(address + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: chatBody("read")
  })).status, 403);
  assert.equal((await fetch(address + "/api/chat", {
    method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: chatBody("read")
  })).status, 403);
  const readChat = await fetch(address + "/api/chat", {
    method: "POST", headers, body: chatBody("Read a note in this ordinary conversation.")
  });
  assert.equal(readChat.status, 200);
  const chatRun = (await readChat.json()).run;
  const waitRun = async (id, status) => {
    for (let i = 0; i < 250; i++) {
      const run = await (await fetch(address + `/api/agents/run?id=${id}`)).json();
      if (run.status === status) return run;
      if (run.status === "failed") throw new Error(run.error);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Conversation never reached ${status}`);
  };
  const readDone = await waitRun(chatRun.id, "completed");
  assert.equal(readDone.source, "chat");
  assert.ok(readDone.events.some(event => event.result?.includes("personal offline note")));
  const writeChat = await fetch(address + "/api/chat", {
    method: "POST", headers, body: chatBody("Write a note in this ordinary conversation.")
  });
  const writeRun = (await writeChat.json()).run;
  const approvalRun = await waitRun(writeRun.id, "awaiting_approval");
  assert.equal(fs.existsSync(path.join(notes, "chat.txt")), false);
  assert.equal((await post("approve", { id: writeRun.id, approvalId: approvalRun.approval.id, approve: true })).status, 200);
  await waitRun(writeRun.id, "completed");
  assert.equal(fs.readFileSync(path.join(notes, "chat.txt"), "utf8"), "Approved chat write.");
  assert.equal((await post("settings", {
    ...initial.settings, enabled: true, planning: true, roots: [notes],
    flags: { files: true, commands: false, browser: false, mcp: false }
  })).status, 200);
  const plannedResponse = await fetch(address + "/api/chat", {
    method: "POST", headers, body: chatBody("Plan and verify a note in this ordinary conversation.")
  });
  assert.equal(plannedResponse.status, 200);
  const plannedRun = (await plannedResponse.json()).run;
  const plannedApproval = await waitRun(plannedRun.id, "awaiting_approval");
  assert.equal(plannedApproval.plan, undefined, "Ordinary chat must never use the saved-agent planner.");
  assert.equal(fs.existsSync(path.join(notes, "planned.txt")), false);
  assert.equal((await post("approve", { id: plannedRun.id, approvalId: plannedApproval.approval.id, approve: true })).status, 200);
  const plannedDone = await waitRun(plannedRun.id, "completed");
  assert.equal(plannedDone.verification.status, "not_configured");
  assert.equal(plannedDone.plan, undefined);
  assert.equal(fs.readFileSync(path.join(notes, "planned.txt"), "utf8"), "Verified planned write.");
  assert.equal((await post("erase", {})).status, 200);
  const erased = await (await fetch(address + "/api/agents")).json();
  assert.deepEqual(erased.agents, []);
  assert.deepEqual(erased.runs, []);
});
