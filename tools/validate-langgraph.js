"use strict";

// Opt-in actual Ollama/Edge acceptance, isolated from the normal backend and
// personal windows. HTTPS fixtures are fulfilled only inside this child.
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const fixtures = {
  a: { title: "Synthetic Cedar laboratory", text: "Synthetic Cedar measurement: 731.29 units. This is a local test fixture, not live financial data." },
  b: { title: "Synthetic Birch laboratory", text: "Synthetic Birch measurement: 918.42 units. This is a local test fixture, not live financial data." },
  c: { title: "Synthetic Maple laboratory", text: "Synthetic Maple measurement: 129.73 units. This is a local test fixture, not live financial data." },
  missing: { title: "Synthetic missing page", text: "Page Not Found. The requested measurement is unavailable. Unrelated sidebar index: 25,645.60." }
};

if (process.argv.includes("--server")) {
  const Module = require("node:module");
  const filename = path.join(root, "src", "agent-tools.js");
  const instrumented = new Module(filename, module);
  instrumented.filename = filename;
  instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
  instrumented._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.fixtureAccess = { conversationBrowsers, currentBrowserRun, ensureBrowser };", filename);
  const actual = instrumented.exports;
  const execute = actual.execute;
  const prepared = new WeakSet();
  actual.execute = async (name, args, settings, signal) => {
    if (name === "browser_open") {
      const session = actual.fixtureAccess.currentBrowserRun(signal);
      await actual.fixtureAccess.ensureBrowser(session);
      if (!prepared.has(session.context)) {
        await session.context.route("https://example.com/horizon-fixture/**", route => {
          const fixture = fixtures[new URL(route.request().url()).pathname.split("/").at(-1)];
          return fixture ? route.fulfill({ contentType: "text/html", body: `<title>${fixture.title}</title><h1>${fixture.title}</h1><p>${fixture.text}</p>` }) : route.abort();
        });
        prepared.add(session.context);
      }
    }
    return execute(name, args, settings, signal);
  };
  require.cache[filename] = instrumented;
  const providers = require("../src/providers");
  const createProvider = providers.createProvider;
  providers.createProvider = config => {
    const provider = createProvider(config);
    const complete = provider.agentCompletion;
    provider.agentCompletion = async (...args) => {
      const response = await complete(...args);
      fs.appendFileSync(path.join(process.env.HORIZON_VALIDATION_DIR, "decisions.jsonl"), JSON.stringify({ request: args[1], response }) + "\n");
      return response;
    };
    return provider;
  };
  process.on("message", async ({ id, conversationId, fixture }) => {
    try {
      const session = actual.fixtureAccess.conversationBrowsers.get(conversationId);
      assert.ok(session?.context);
      const page = await session.context.newPage();
      await page.goto(`https://example.com/horizon-fixture/${fixture}`);
      await page.bringToFront();
      await new Promise(resolve => setTimeout(resolve, 300));
      process.send({ id, url: page.url(), title: await page.title(), tabs: session.context.pages().length });
    } catch (error) { process.send({ id, error: error.stack }); }
  });
  require("../src/server");
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const directory = path.join(root, ".runtime", `langgraph-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const report = { at: new Date().toISOString(), inference: "actual loopback Ollama qwen3:1.7b", browser: "real isolated visible Edge; controlled synthetic HTTPS route fixtures", checks: [] };
  const save = () => fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  const until = async (fn, timeout = 180000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error("Acceptance timed out.");
  };
  let child;
  try {
    const tags = await (await fetch("http://127.0.0.1:11434/api/tags")).json();
    assert.ok(tags.models.some(model => model.name === "qwen3:1.7b"), "Install Qwen separately before acceptance.");
    child = fork(__filename, ["--server"], {
      cwd: root, silent: true, env: {
        ...process.env, TEMP: directory, TMP: directory,
        HORIZON_VALIDATION_DIR: directory,
        HORIZON_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        HORIZON_MODEL_ALIAS: "qwen3:1.7b", HORIZON_RUNTIME_DIR: path.join(directory, "state"),
        HORIZON_PORT: "0", HORIZON_OPEN_BROWSER: "false", HORIZON_WARM_UP: "false",
        HORIZON_UNLOAD_ON_EXIT: "false", HORIZON_STOP_SERVICE_ON_EXIT: "false", HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
      }
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      output += chunk; fs.appendFileSync(path.join(directory, "server.log"), chunk);
    });
    const base = await until(() => /Open:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], 30000);
    assert.equal((await fetch(base)).status, 200);
    const initial = await (await fetch(`${base}/api/agents`)).json();
    const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": initial.csrfToken };
    const post = async (route, body) => {
      const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    await post("/api/agents/settings", {
      ...initial.settings, enabled: true, flags: { files: false, browser: true, commands: false, mcp: false },
      chat: { ...initial.settings.chat, protocol: "native", maxSteps: 8, tools: ["browser_open", "browser_snapshot", "browser_close"] }
    });
    const conversationId = `graph-${randomUUID()}`;
    const history = [];
    async function turn(name, prompt, check) {
      history.push({ role: "user", content: prompt });
      const { run } = await post("/api/chat", { messages: history, conversationId, clientRunId: randomUUID() });
      const completed = await until(async () => {
        const data = await (await fetch(`${base}/api/agents/run?id=${run.id}`)).json();
        return ["completed", "failed", "cancelled"].includes(data.status) && data;
      });
      fs.writeFileSync(path.join(directory, `${run.id}.json`), JSON.stringify(completed, null, 2));
      const entry = { name, status: completed.status, answer: completed.result, error: completed.error, run: run.id };
      report.checks.push(entry);
      try { check(completed); entry.passed = true; }
      catch (error) { entry.passed = false; entry.assertion = error.message; }
      history.push({ role: "assistant", content: completed.result || `The last run failed: ${completed.error}` });
      save(); console.log(`${entry.passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(entry)}`);
      return completed;
    }
    const grounded = (run, value) => {
      assert.equal(run.status, "completed", run.error);
      assert.match(run.result, new RegExp(value.replace(".", "\\.")));
      assert.equal(run.verification.status, "passed");
      assert.ok(run.events.some(event => event.type === "graph"));
      assert.ok(run.events.some(event => event.type === "result" && event.tool === "browser_snapshot"));
    };
    await turn("navigation metadata followed by actual observation", "Open https://example.com/horizon-fixture/a and read the synthetic Cedar measurement shown there.", run => {
      grounded(run, "731.29");
      const results = run.events.filter(event => event.type === "result");
      assert.equal(results[0].tool, "browser_open");
      assert.equal(results[1].tool, "browser_snapshot");
    });
    if (process.argv.includes("--first-only")) {
      report.passed = report.checks.every(check => check.passed);
      if (!report.passed) process.exitCode = 1;
      return;
    }
    const select = fixture => new Promise((resolve, reject) => {
      const id = randomUUID();
      const listener = data => {
        if (data.id !== id) return;
        child.off("message", listener);
        data.error ? reject(new Error(data.error)) : resolve(data);
      };
      child.on("message", listener);
      child.send({ id, conversationId, fixture });
    });
    report.manualSelection = await select("b");
    history.push({ role: "assistant", content: "I do not have browser access. The old measurement was 304.85." });
    await turn("manual tab selection with prior false refusal", "You already have browser tools, cant you use them? Read the synthetic measurement on the current selected page.", run => {
      grounded(run, "918.42"); assert.doesNotMatch(run.result, /731.29|304.85/);
    });
    report.secondSelection = await select("c");
    await turn("repeated page read across three tabs in same conversation", "Its open in your viewport.. Read the current synthetic measurement.", run => {
      grounded(run, "129.73"); assert.doesNotMatch(run.result, /918.42|731.29|304.85/);
    });
    await turn("not-found data must not become unrelated sidebar measurement", "Open https://example.com/horizon-fixture/missing and read the requested laboratory measurement, not an unrelated sidebar index. If the requested measurement is absent, do not report a value.", run => {
      if (run.status === "failed") assert.equal(run.failure?.stage, "verification");
      else { assert.equal(run.status, "completed"); assert.match(run.result, /Not Found|unavailable/); }
      assert.doesNotMatch(run.result || "", /25,645.60|731.29|918.42|304.85/);
    });
    report.passed = report.checks.every(check => check.passed);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.error = error.stack; report.passed = false; process.exitCode = 1;
    console.error(error.stack);
  } finally {
    save();
    console.log(`Evidence: ${directory}`);
    // Only the child created here owns these windows. Never stop the regular
    // Horizon backend or another user's browser/model service.
    if (child) child.kill();
  }
}
