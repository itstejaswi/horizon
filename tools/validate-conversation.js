"use strict";

// Opt-in acceptance against an already-installed local model and Chromium.
// No inference stubs, package installation, personal profile or user data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const Module = require("node:module");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const directory = path.join(root, ".runtime", `acceptance-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
process.env.TEMP = process.env.TMP = directory;
const report = { at: new Date().toISOString(), model: "qwen3:1.7b", inference: "actual loopback Ollama", checks: [] };
const save = () => fs.writeFileSync(path.join(root, ".runtime", "end-to-end.json"), JSON.stringify(report, null, 2));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await wait(100);
  }
  throw new Error("Acceptance timed out.");
}
function checked(name, evidence) {
  report.checks.push({ name, passed: true, evidence });
  save();
  console.log(`PASS ${name}: ${JSON.stringify(evidence)}`);
}

async function main() {
  let base, browser, child, actualTools;
  try {
    const status = await (await fetch("http://127.0.0.1:11434/api/tags")).json();
    assert.ok(status.models.some(model => model.name === report.model), "Qwen must already be installed.");
    child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
      cwd: root,
      env: {
        ...process.env, HORIZON_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        HORIZON_MODEL_ALIAS: report.model, HORIZON_RUNTIME_DIR: path.join(directory, "state"),
        HORIZON_PORT: "0", HORIZON_OPEN_BROWSER: "false", HORIZON_WARM_UP: "false",
        HORIZON_UNLOAD_ON_EXIT: "false", HORIZON_STOP_SERVICE_ON_EXIT: "false",
        HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
      }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = chunk => {
      output += chunk;
      fs.appendFileSync(path.join(directory, "server.log"), chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    base = await until(() => /Open:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1], 30000);
    assert.equal((await fetch(base)).status, 200);
    const initial = await (await fetch(`${base}/api/agents`)).json();
    const headers = { "Content-Type": "application/json", "X-Horizon-Agent-Token": initial.csrfToken };
    async function post(route, body) {
      const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    }
    const token = `CEDAR-${randomUUID()}`;
    fs.writeFileSync(path.join(directory, "evidence.txt"), `Synthetic observation: ${token}\n`);
    const settings = {
      ...initial.settings, enabled: true, planning: true, roots: [directory],
      flags: { files: true, browser: true, commands: false, mcp: false },
      chat: { ...initial.settings.chat, protocol: "native",
        tools: ["file_read", "file_list", "file_search", "file_write", "browser_open", "browser_search", "browser_snapshot", "browser_click", "browser_fill", "browser_close"] }
    };
    await post("/api/agents/settings", settings);
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#chat-tools-settings").textContent === "Tools available");
    async function runState(id) {
      return (await fetch(`${base}/api/agents/run?id=${id}`)).json();
    }
    async function uiTurn(prompt, action) {
      await page.locator("#prompt").fill(prompt);
      const response = page.waitForResponse(response => response.url() === `${base}/api/chat` && response.request().method() === "POST");
      await page.locator("#send").click();
      const actualResponse = await response;
      const payload = actualResponse.request().postDataJSON();
      assert.equal(payload.messages.at(-1).role, "user");
      assert.equal(payload.messages.at(-1).content, prompt, "The UI must send the newly entered prompt.");
      fs.appendFileSync(path.join(directory, "requests.jsonl"), JSON.stringify(payload) + "\n");
      const { run } = await actualResponse.json();
      assert.ok(run?.id, "UI must use the actual conversation endpoint.");
      const finished = await until(async () => {
        const current = await runState(run.id);
        if (current.approval && action) await action(current);
        return ["completed", "failed", "cancelled"].includes(current.status) && current;
      });
      if (!action) assert.equal(finished.status, "completed", JSON.stringify(finished));
      await page.waitForFunction(() => document.querySelector("#send").dataset.mode === "send");
      await until(async () => !(await page.locator(".waiting").count()), 10000);
      return finished;
    }
    const greeting = await uiTurn("Good evening, I am doing good.. I need your help");
    assert.ok(greeting.result?.length);
    assert.equal(greeting.plan, undefined);
    assert.equal(greeting.events.filter(event => event.type === "model").length, 1);
    assert.equal(greeting.events.filter(event => event.type === "tool").length, 0);
    assert.ok(!/^\s*\{/.test(greeting.result));
    checked("exact greeting through visible UI", greeting.result);
    const explanation = await uiTurn("My project's name is Cedar. Explain in two short sentences why keeping its files outside OneDrive avoids sync conflicts. Remember my project name.");
    assert.match(explanation.result, /sync|synchron|OneDrive/i);
    const followup = await uiTurn("What is my project's name? Answer only with its name.");
    assert.match(followup.result, /Cedar/i);
    checked("explanation and retained conversation context", { explanation: explanation.result, followup: followup.result });
    const read = await uiTurn(`Read the actual file ${path.join(directory, "evidence.txt")} using file_read and tell me its exact synthetic observation. Do not guess its contents.`);
    assert.ok(read.events.some(event => event.type === "tool" && event.tool === "file_read"));
    assert.ok(read.events.some(event => event.type === "result" && event.result.includes(token)));
    assert.ok(read.result.includes(token), "The model must report the actual unique file content.");
    checked("real synthetic file read and grounded answer", { token, answer: read.result });
    assert.equal(await page.locator(".turn.assistant .turn-meta").last().innerText(), "Horizon");
    await page.locator("#settings-btn").click();
    await page.locator("nav[aria-label='Settings sections']").getByRole("button", { name: "Ollama", exact: true }).click();
    assert.equal(await page.locator(".settings-heading").innerText(), "Ollama");
    assert.ok(!(await page.locator(".settings-panel").innerText()).includes("Foundry"));
    await page.locator("#settings-btn").click();
    checked("Horizon assistant labels and provider-aware Settings", "Ollama heading/panel, model identity retained in picker.");
    const details = page.locator(".chat-tool-activity").last();
    assert.equal(await details.evaluate(element => element.open), false);
    await details.locator("summary").click();
    assert.equal(await details.evaluate(element => element.open), true);
    await page.screenshot({ path: path.join(directory, "desktop.png") });
    await page.locator("#chat-tools-settings").click();
    await page.getByLabel("Read files within granted folders", { exact: true }).selectOption("ask");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await page.locator("#chat-tools-settings").click();
    assert.equal(await page.getByLabel("Read files within granted folders", { exact: true }).inputValue(), "ask");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    checked("reviewable conversation preference survives reload", "File reads changed to ask; no tool/folder grant changed.");
    await page.locator("#new-chat").click();
    await page.locator("#chat-tools-settings").click();
    assert.equal(await page.getByLabel("Read files within granted folders", { exact: true }).inputValue(), "allow");
    await page.getByLabel("Read files within granted folders", { exact: true }).selectOption("ask");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    checked("new conversation does not inherit ask preference", "Independent conversation controls; fresh approval scenario switched to ask explicitly.");
    fs.writeFileSync(path.join(directory, "denial.txt"), `Unseen synthetic content: ${randomUUID()}`);
    const denied = await uiTurn(`Read the new file ${path.join(directory, "denial.txt")} using file_read. Its contents have not been read or supplied before.`, async current => {
      await page.getByRole("button", { name: "Deny", exact: true }).waitFor();
      assert.equal(await page.locator(".chat-tool-activity").last().evaluate(element => element.open), false);
      assert.equal(await page.locator(".agent-approval").last().isVisible(), true);
      await page.getByRole("button", { name: "Deny", exact: true }).click();
    });
    assert.equal(denied.status, "failed");
    assert.equal(denied.events.filter(event => event.type === "tool").length, 0);
    checked("visible approval outside collapsed details and denial", denied.error);
    await page.locator("#new-chat").click();
    await page.locator("#chat-tools-settings").click();
    assert.equal(await page.getByLabel("Read files within granted folders", { exact: true }).inputValue(), "allow");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const opened = await uiTurn("Open https://example.com in your browser, then read its page text with browser_snapshot. Tell me what the actual page is for.");
    assert.ok(opened.events.some(event => event.type === "tool" && event.tool === "browser_open"));
    assert.ok(opened.events.some(event => event.type === "result" && event.tool === "browser_open" && JSON.parse(event.result).visible));
    assert.ok(opened.events.some(event => event.type === "result" && event.tool === "browser_snapshot" && /documentation|Example Domain/i.test(JSON.parse(event.result).text)));
    assert.match(opened.result, /example|documentation|domain/i);
    checked("real Qwen public browser open and read", opened.result);
    const search = await uiTurn("Use browser_search to search the public web for IANA example domains. Report what the actual search results say, or honestly report a challenge or missing results.");
    assert.ok(search.events.some(event => event.type === "tool" && event.tool === "browser_search"));
    const retrieved = JSON.parse(search.events.find(event => event.type === "result" && event.tool === "browser_search").result);
    assert.equal(new URL(retrieved.url).hostname, "duckduckgo.com");
    assert.ok(retrieved.text?.trim().length, "The search must return actual page text.");
    checked("real Qwen bounded public search", { answer: search.result, url: retrieved.url, retrievedText: retrieved.text.slice(0, 1800) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(directory, "narrow-thread.png") });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(layout.document <= layout.viewport, JSON.stringify(layout));
    await page.locator("#chat-tools-settings").click();
    assert.equal(await page.evaluate(() => document.querySelector("dialog").getBoundingClientRect().right <= innerWidth), true);
    await page.screenshot({ path: path.join(directory, "narrow.png") });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    assert.deepEqual(errors, []);
    checked("desktop/narrow layout and script errors", { widths: [1280, 390], errors });
    await page.locator("#prompt").fill("Explain three different approaches to local project organization with examples.");
    const cancellationResponse = page.waitForResponse(response => response.url() === `${base}/api/chat` && response.request().method() === "POST");
    await page.locator("#send").click();
    const cancellationRun = (await (await cancellationResponse).json()).run;
    await page.locator("#send[data-mode='stop']").click();
    const cancelled = await until(async () => {
      const current = await runState(cancellationRun.id);
      return current.status === "cancelled" && current;
    });
    checked("Stop cancels real local inference from the UI", cancelled.status);

    // Load the unchanged tool implementation with a test-only state accessor.
    // Every browser, proxy, navigation and result below is real.
    const filename = path.join(root, "src", "agent-tools.js");
    const instrumented = new Module(filename, module);
    instrumented.filename = filename;
    instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
    instrumented._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.sessions = conversationBrowsers;", filename);
    actualTools = instrumented.exports;
    const turn = id => {
      const controller = new AbortController();
      actualTools.bindConversation(controller.signal, id);
      return controller;
    };
    let controller = turn("lifecycle-one");
    const first = await actualTools.execute("browser_open", { url: "https://example.com" }, settings, controller.signal);
    assert.equal(first.visible, true);
    const session = actualTools.sessions.get("lifecycle-one");
    const firstPage = session.page;
    await actualTools.closeRun(controller.signal);
    controller = turn("lifecycle-one");
    assert.match((await actualTools.execute("browser_snapshot", {}, settings, controller.signal)).text, /documentation|Example Domain/i);
    const secondPage = await session.context.newPage();
    await secondPage.goto("https://example.org", { waitUntil: "domcontentloaded" });
    await firstPage.bringToFront();
    await wait(300);
    await page.bringToFront();
    await wait(300);
    assert.match((await actualTools.execute("browser_snapshot", {}, settings, controller.signal)).url, /example\.com/);
    await firstPage.goto("https://example.net", { waitUntil: "domcontentloaded" });
    assert.match((await actualTools.execute("browser_snapshot", {}, settings, controller.signal)).url, /example\.net/);
    checked("visible window retained across turns and manual selected tab/navigation followed", "Same browser/context; selected example.com tab retained after UI refocus, manual example.net navigation observed.");
    const other = turn("lifecycle-two");
    await assert.rejects(actualTools.execute("browser_snapshot", {}, settings, other.signal), /No browser page/);
    await actualTools.execute("browser_open", { url: "https://example.org" }, settings, other.signal);
    assert.notEqual(actualTools.sessions.get("lifecycle-two").context, session.context);
    assert.match((await actualTools.execute("browser_snapshot", {}, settings, controller.signal)).url, /example\.net/);
    await assert.rejects(actualTools.execute("browser_open", { url: "https://127.0.0.1" }, settings, controller.signal), /public HTTPS/);
    checked("conversation isolation and private-address blocking", "Two separate visible Chromium contexts; private navigation rejected.");
    const pending = actualTools.execute("browser_click", { selector: "#never-exists" }, settings, controller.signal);
    await wait(250);
    controller.abort();
    await assert.rejects(pending);
    await actualTools.closeRun(controller.signal);
    controller = turn("lifecycle-one");
    assert.match((await actualTools.execute("browser_snapshot", {}, settings, controller.signal)).url, /example\.org/);
    await actualTools.execute("browser_close", {}, settings, controller.signal);
    await actualTools.execute("browser_open", { url: "https://example.com" }, settings, controller.signal);
    await actualTools.sessions.get("lifecycle-one").browser.close();
    await until(() => !actualTools.sessions.has("lifecycle-one"));
    await actualTools.execute("browser_open", { url: "https://example.org" }, settings, controller.signal);
    checked("cancellation preserves other tabs, explicit close and manual-close reopen", "Pending click interrupted; remaining tab readable; both close paths reopen.");
    await actualTools.close();
    assert.equal(actualTools.sessions.size, 0);
    checked("browser shutdown cleanup", "All direct acceptance browsers/proxies closed.");
    await post("/api/shutdown", {});
    await until(() => child.exitCode !== null, 15000);
    checked("controlled server graceful shutdown", { exitCode: child.exitCode });
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    throw error;
  } finally {
    await actualTools?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (child && child.exitCode === null) {
      if (base) await fetch(`${base}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      await until(() => child.exitCode !== null, 15000).catch(async () => {
        child.kill();
        await until(() => child.exitCode !== null || child.signalCode !== null, 5000);
      });
    }
    report.artifacts = path.relative(root, directory);
    const dataFile = path.join(directory, "state", "agent-data.json");
    if (fs.existsSync(dataFile)) {
      const { settings, runs } = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      fs.writeFileSync(path.join(directory, "server-evidence.json"), JSON.stringify({ settings, runs }, null, 2));
    }
    for (const name of ["evidence.txt", "denial.txt", "state"]) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    save();
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
