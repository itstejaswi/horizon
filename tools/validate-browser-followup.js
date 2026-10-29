"use strict";

// Opt-in local acceptance. Only the isolated child exposes its browser to IPC.
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");

if (process.argv.includes("--server")) {
  const Module = require("node:module");
  const filename = path.join(root, "src", "agent-tools.js");
  const instrumented = new Module(filename, module);
  instrumented.filename = filename;
  instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
  instrumented._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.sessions = conversationBrowsers;", filename);
  require.cache[filename] = instrumented;
  process.on("message", async ({ id, conversationId, marker, fixture }) => {
    try {
      const session = instrumented.exports.sessions.get(conversationId);
      assert.ok(session?.visible, "A retained visible browser must already exist.");
      const previous = session.page;
      const selected = await session.context.newPage();
      if (fixture) {
        await selected.goto("https://example.com/", { waitUntil: "domcontentloaded" });
        await selected.setContent(`<title>Synthetic stock observation ${marker}</title><h1>Synthetic stock observation ${marker}</h1><p>This is a local acceptance fixture, not live financial data.</p>`);
      } else {
        await selected.goto("https://www.google.com/search?q=MSFT", { waitUntil: "domcontentloaded" });
      }
      await selected.bringToFront();
      await new Promise(resolve => setTimeout(resolve, 400));
      process.send({ id, url: selected.url(), title: await selected.title(), previous: previous.url() });
    } catch (error) { process.send({ id, error: error.stack }); }
  });
  require("../src/server");
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const { chromium } = require("playwright");
  const directory = path.join(root, ".runtime", `browser-followup-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const report = {
    at: new Date().toISOString(), model: "qwen3:1.7b",
    mode: process.argv.includes("--ui-only") ? "ui-only (synthetic response, real Edge UI)"
      : process.argv.includes("--fixture-only") ? "actual Qwen and synthetic selected pages; no Google search" : "actual Qwen, Google and synthetic selected pages",
    checks: []
  };
  const save = () => fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, timeout = 180000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await check(); if (result) return result; await wait(100); }
    throw new Error("Acceptance timed out.");
  };
  const checked = (name, evidence) => {
    report.checks.push({ name, passed: true, evidence }); save();
    console.log(`PASS ${name}: ${JSON.stringify(evidence)}`);
  };
  let child, base, browser;
  try {
    child = fork(__filename, ["--server"], {
      cwd: root, silent: true,
      env: {
        ...process.env, TEMP: directory, TMP: directory,
        HORIZON_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        HORIZON_MODEL_ALIAS: report.model, HORIZON_RUNTIME_DIR: path.join(directory, "state"),
        HORIZON_PORT: "0", HORIZON_OPEN_BROWSER: "false", HORIZON_WARM_UP: "false",
        HORIZON_UNLOAD_ON_EXIT: "false", HORIZON_STOP_SERVICE_ON_EXIT: "false",
        HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
      }
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      output += chunk; fs.appendFileSync(path.join(directory, "server.log"), chunk);
    });
    base = await until(() => /Open:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], 30000);
    assert.equal((await fetch(base)).status, 200);
    const initial = await (await fetch(`${base}/api/agents`)).json();
    const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": initial.csrfToken };
    const post = async (route, body) => {
      const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    await post("/api/agents/settings", {
      ...initial.settings, enabled: true, flags: { files: false, browser: true, commands: false, mcp: false },
      chat: { ...initial.settings.chat, protocol: "native", tools: ["browser_open", "browser_snapshot", "browser_close"] }
    });
    if (!process.argv.includes("--ui-only")) {
    const conversationId = `followup-${randomUUID()}`;
    const history = [];
    async function turn(prompt) {
      history.push({ role: "user", content: prompt });
      const { run } = await post("/api/chat", { messages: history, conversationId, clientRunId: randomUUID() });
      const completed = await until(async () => {
        const data = await (await fetch(`${base}/api/agents/run?id=${run.id}`)).json();
        return ["completed", "failed", "cancelled"].includes(data.status) && data;
      });
      fs.writeFileSync(path.join(directory, `${run.id}.json`), JSON.stringify(completed, null, 2));
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      history.push({ role: "assistant", content: completed.result });
      return completed;
    }
    const opened = await turn("Can you open google.com for me, I want to show you something.. :)");
    const opening = opened.events.find(event => event.type === "result" && event.tool === "browser_open");
    assert.ok(opening, "Qwen must actually open the browser.");
    assert.equal(JSON.parse(opening.result).visible, true);
    checked("exact Google open with actual Qwen", { run: opened.id, answer: opened.result });
    const marker = `MSFT-OBSERVED-${randomUUID()}`;
    const id = randomUUID();
    const navigation = new Promise((resolve, reject) => {
      const listener = data => {
        if (data.id !== id) return;
        child.off("message", listener);
        if (data.error) reject(new Error(data.error)); else resolve(data);
      };
      child.on("message", listener);
    });
    child.send({ id, conversationId, marker, fixture: process.argv.includes("--fixture-only") });
    const navigated = await navigation;
    checked("human-style navigation and selected tab in isolated visible browser", navigated);
    history.push(
      { role: "user", content: "Can you read the page and tell me whats open?" },
      { role: "assistant", content: "I don't have access to list open windows or tabs directly. However I can take a screenshot to see what's currently visible." },
      { role: "user", content: "Its open in your viewport.." },
      { role: "assistant", content: "I don't have access to your viewport or open tabs directly." }
    );
    for (const prompt of ["Can you read the page and tell me whats open?", "Its open in your viewport.."]) {
      const read = await turn(prompt);
      assert.equal(read.events.filter(event => event.type === "tool" && event.tool === "browser_open").length, 0);
      const observation = read.events.find(event => event.type === "result" && event.tool === "browser_snapshot");
      assert.ok(observation, "Must execute snapshot, not repeat the prior refusal.");
      assert.equal(JSON.parse(observation.result).url, navigated.url, "Must observe the selected manually navigated tab.");
      assert.doesNotMatch(read.result, /screenshot|don't have access|no open tabs or windows/i, "Must not repeat unsupported capability claims.");
      if (new URL(navigated.url).pathname.startsWith("/sorry/")) {
        assert.match(read.result, /CAPTCHA|unusual traffic|verification|challenge/i, "Answer must report the actual Google challenge, not pretend stocks loaded.");
      } else {
        assert.match(read.result, /Google|MSFT|Microsoft|stock/i);
      }
      checked(`actual Qwen follow-up: ${prompt}`, { run: read.id, answer: read.result, observedUrl: JSON.parse(observation.result).url });
    }

    const fixtureId = randomUUID();
    const fixtureReady = new Promise((resolve, reject) => {
      const listener = data => {
        if (data.id !== fixtureId) return;
        child.off("message", listener);
        if (data.error) reject(new Error(data.error)); else resolve(data);
      };
      child.on("message", listener);
    });
    const fixtureMarker = `LOCAL-${randomUUID()}`;
    child.send({ id: fixtureId, conversationId, marker: fixtureMarker, fixture: true });
    await fixtureReady;
    for (const prompt of ["Can you read the page and tell me whats open?", "Its open in your viewport.."]) {
      const read = await turn(prompt);
      const observation = read.events.find(event => event.type === "result" && event.tool === "browser_snapshot");
      assert.ok(observation, "Must read the new manually selected synthetic tab.");
      assert.ok(JSON.parse(observation.result).text.includes(fixtureMarker));
      assert.ok(read.result.includes(fixtureMarker), "Must answer from unique current content, not the previous Google page.");
      assert.doesNotMatch(read.result, /screenshot|don't have access|no open tabs or windows/i);
      assert.equal(read.events.filter(event => event.type === "tool" && event.tool === "browser_open").length, 0);
      checked(`actual Qwen unique synthetic content: ${prompt}`, { run: read.id, answer: read.result });
    }
    }

    browser = await chromium.launch({ channel: "msedge", headless: false, env: { ...process.env, TEMP: directory, TMP: directory } });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#chat-tools-settings").textContent === "Tools available");
    const thread = page.locator("#thread");
    await thread.evaluate(element => {
      for (let i = 0; i < 30; i++) {
        const turn = document.createElement("div"); turn.textContent = `Synthetic old turn ${i}`;
        turn.style.minHeight = "100px"; element.append(turn);
      }
      element.scrollTop = 0;
    });
    let release;
    const released = new Promise(resolve => { release = resolve; });
    await page.route("**/api/chat", async route => {
      await released;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "Synthetic scrolling regression complete." }) });
    });
    await page.locator("#prompt").fill("Synthetic UI scrolling regression");
    await page.locator("#send").click();
    await page.waitForSelector("#send[data-mode='stop']");
    const distance = () => thread.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    await until(async () => await distance() < 60, 5000);
    checked("send reveals latest exchange without manual scrolling", { width, bottomDistance: await distance() });
    const reply = page.locator(".turn.assistant .turn-main").last();
    const grow = () => reply.evaluate(element => {
      const block = document.createElement("div"); block.style.height = "450px"; block.textContent = "Synthetic growing activity"; element.append(block);
    });
    await grow();
    await until(async () => await distance() < 60, 5000);
    checked("reply growth autoscrolls while pinned", { width, bottomDistance: await distance() });
    const bounds = await thread.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -500);
    await wait(700);
    assert.ok(await distance() > 100, "Actual wheel scroll must leave the pinned region.");
    const before = await thread.evaluate(element => element.scrollTop);
    await grow(); await wait(300);
    assert.ok(Math.abs(await thread.evaluate(element => element.scrollTop) - before) < 2, "Reply growth must not pull a reader back to the bottom.");
    checked("user scroll-up respected during reply growth", { width, scrollTop: before });
    release();
    await page.waitForSelector("#send[data-mode='send']");
    await page.unroute("**/api/chat");
    }
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.stack; throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (base && child?.exitCode === null) await fetch(`${base}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    if (child?.exitCode === null) await until(() => child.exitCode !== null, 15000).catch(() => child.kill());
    save();
    const latest = process.argv.includes("--ui-only") ? "browser-scroll-latest.json" : "browser-followup-latest.json";
    fs.writeFileSync(path.join(root, ".runtime", latest), JSON.stringify({ ...report, artifacts: path.relative(root, directory) }, null, 2));
    console.log(`Evidence: ${path.relative(root, directory)}`);
  }
}
