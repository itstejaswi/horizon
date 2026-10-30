"use strict";

// Opt-in, fresh contexts only. Records no cookies, credentials or profile data.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const filename = path.join(root, "src", "agent-tools.js");
const instrumented = new Module(filename, module);
instrumented.filename = filename;
instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
instrumented._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.diagnostic = { ensureBrowser, currentBrowserRun };", filename);
const tools = instrumented.exports;
const directory = path.join(root, ".runtime", `browser-network-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
process.env.TEMP = directory;
process.env.TMP = directory;
const report = { at: new Date().toISOString(), sessions: [], limitations: [
  "Two fresh isolated Edge sessions, one direct and one using Horizon's complete guarded boundary. Not the user's or Scout's existing profile.",
  "At most one Google search per session; a human challenge is recorded, never interacted with.",
  "This comparison cannot identify Google's private risk heuristics or isolate every launch/context difference."
] };
const safeUrl = value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return "invalid URL"; } };
async function observe(label, browser, context, page) {
  const result = { label, version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), navigations: [], failures: [], responseErrors: [] };
  report.sessions.push(result);
  context.on("requestfailed", request => result.failures.push({ url: safeUrl(request.url()), error: request.failure()?.errorText }));
  context.on("response", response => { if (response.status() >= 400) result.responseErrors.push({ url: safeUrl(response.url()), status: response.status() }); });
  for (const url of ["https://example.com/", "https://www.google.com/", "https://www.google.com/search?q=MSFT"]) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(1500);
      result.navigations.push({ requested: safeUrl(url), final: safeUrl(page.url()), title: await page.title(), status: response?.status(), challenge: new URL(page.url()).pathname.startsWith("/sorry/") });
    } catch (error) { result.navigations.push({ requested: safeUrl(url), error: error.message.split("\n")[0] }); }
  }
  return result;
}
async function main() {
  let direct;
  try {
    direct = await chromium.launch({ channel: "msedge", headless: false });
    const context = await direct.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await observe("fresh Edge direct (no Horizon network flags/proxy)", direct, context, await context.newPage());
    await direct.close(); direct = null;
    const controller = new AbortController();
    tools.bindConversation(controller.signal, "network-diagnostic");
    const run = await tools.diagnostic.ensureBrowser(tools.diagnostic.currentBrowserRun(controller.signal));
    const observed = await observe("fresh Edge with Horizon IP-validating proxy and restrictions", run.browser, run.context, run.page);
    observed.proxyBoundary = {};
    for (const url of ["http://example.com/", "https://127.0.0.1/"]) {
      observed.proxyBoundary[url] = await run.page.evaluate(async url => {
        try { await fetch(url); return "unexpected success"; } catch { return "blocked"; }
      }, url);
      assert.equal(observed.proxyBoundary[url], "blocked");
    }
    // Test the actual CONNECT boundary independently of page routing.
    const net = require("node:net");
    observed.privateConnect = await new Promise((resolve, reject) => {
      const socket = net.connect(new URL(run.proxy.address).port, "127.0.0.1", () => socket.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("CONNECT probe timed out")); });
      socket.once("data", data => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); });
      socket.once("error", reject);
    });
    assert.match(observed.privateConnect, /403 Forbidden/);
    report.completed = true;
  } catch (error) { report.completed = false; report.error = error.stack; process.exitCode = 1; }
  finally {
    await direct?.close();
    await tools.close();
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, ".runtime", "browser-network-latest.json"), JSON.stringify({ ...report, artifacts: path.relative(root, directory) }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main();
