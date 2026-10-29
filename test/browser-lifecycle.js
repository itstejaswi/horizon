"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

async function harness(launchError) {
  const filename = path.join(__dirname, "..", "src", "agent-tools.js");
  const source = await fs.readFile(filename, "utf8");
  const localRequire = createRequire(filename);
  const launches = [];
  const contexts = [];
  const browsers = [];
  let gate;
  const context = {
    module: { exports: {} }, Buffer, URL, TextDecoder, process, setTimeout, clearTimeout,
    require(name) {
      if (name === "node:dns") return { promises: { lookup: async () => [{ address: "93.184.215.14", family: 4 }] } };
      if (name === "playwright") return { chromium: { async launch(options) {
        launches.push(options);
        if (launchError) throw launchError;
        if (gate) await gate;
        const browser = new EventEmitter();
        const ctx = new EventEmitter();
        const pages = [];
        ctx.route = async () => {};
        ctx.exposeBinding = async () => {};
        ctx.addInitScript = async () => {};
        ctx.routeWebSocket = () => {};
        ctx.pages = () => pages;
        ctx.newPage = async () => {
          const page = {
            _connection: { toImpl: () => ({ delegate: { _mainFrameSession: { _client: { send: async () => {} } } } }) },
            closed: false, focused: false, address: "about:blank",
            isClosed() { return this.closed; },
            async close() { this.closed = true; },
            async evaluate() { return this.focused; },
            async goto(url) { this.address = url; },
            url() { return this.address; },
            async title() { return "Fixture"; },
            locator() { return {
              async evaluate() { return { text: page.address, truncated: false }; },
              first() { return {
                async click() { if (page.waitForClose) await page.waitForClose; },
                async fill() {}
              }; }
            }; }
          };
          const originalClose = page.close.bind(page);
          page.close = async () => { await originalClose(); page.resolveClose?.(); };
          pages.push(page);
          ctx.emit("page", page);
          return page;
        };
        ctx.close = async () => { for (const page of pages) await page.close(); };
        browser.newContext = async (options) => { contexts.push(options); return ctx; };
        browser.close = async () => { await ctx.close(); browser.emit("disconnected"); };
        browsers.push({ browser, context: ctx });
        return browser;
      } } };
      return localRequire(name);
    }
  };
  vm.runInNewContext(`${source}\nmodule.exports.testing = { conversationBrowsers, browserRuns, ensureBrowser, currentBrowserRun, browserOperation, prepareVisiblePage };`, context, { filename });
  return {
    tools: context.module.exports, launches, contexts, browsers,
    setGate(value) { gate = value; }
  };
}

const config = { flags: { browser: true } };
function turn(tools, id) {
  const controller = new AbortController();
  if (id) tools.bindConversation(controller.signal, id);
  return controller;
}

test("visible tab tracking fails closed when the pinned Playwright owning-session adapter is unavailable", async () => {
  const { tools } = await harness();
  await assert.rejects(tools.testing.prepareVisiblePage({ visible: true }, {}), /tab tracking is unavailable/);
});

test("public search constructs only a fixed encoded GET destination and rejects extra action parameters", async () => {
  const { tools } = await harness();
  const controller = turn(tools, "search-chat");
  try {
    const query = "IANA & url=http://127.0.0.1/submit";
    const result = await tools.execute("browser_search", { query }, config, controller.signal);
    assert.equal(result.url, `https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
    await assert.rejects(tools.execute("browser_search", { query, url: "https://example.com/delete" }, config, controller.signal), /Unexpected argument/);
    await assert.rejects(tools.execute("browser_search", { query: " " }, config, controller.signal), /must not be empty/);
    await assert.rejects(tools.execute("browser_search", { query: "a".repeat(513) }, config, controller.signal), /512-byte limit/);
  } finally { await tools.close(); }
});

test("conversation browsers remain visible across turns, select the focused tab and isolate chats", async () => {
  const { tools, launches, contexts, browsers } = await harness();
  try {
    const first = turn(tools, "chat-one");
    const emptyState = await tools.browserState(first.signal);
    assert.equal(emptyState.open, false);
    assert.equal(emptyState.conversationId, "chat-one");
    assert.equal(tools.testing.conversationBrowsers.size, 0, "Inspecting live capability must not allocate a browser.");
    const run = tools.testing.currentBrowserRun(first.signal);
    await tools.testing.ensureBrowser(run);
    assert.equal(launches[0].headless, false);
    assert.equal(launches[0].channel, "msedge");
    assert.equal(contexts[0].viewport, null, "Visible pages must resize with the native browser window.");
    assert.match(launches[0].proxy.server, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(launches[0].args.includes("--disable-quic"));
    const original = browsers[0].context.pages()[0];
    original.address = "https://example.com/manual";
    await tools.closeRun(first.signal);
    const second = turn(tools, "chat-one");
    assert.equal((await tools.execute("browser_snapshot", {}, config, second.signal)).text, original.address);
    const another = await browsers[0].context.newPage();
    another.address = "https://example.org/new-tab";
    original.focused = true;
    assert.equal((await tools.execute("browser_snapshot", {}, config, second.signal)).text, original.address);
    original.focused = false;
    another.focused = true;
    assert.equal((await tools.execute("browser_snapshot", {}, config, second.signal)).text, another.address);
    const state = await tools.browserState(second.signal);
    assert.equal(state.conversationId, "chat-one");
    assert.equal(state.tabs, 2);
    assert.equal(state.url, another.address);
    await another.close();
    assert.equal((await tools.execute("browser_snapshot", {}, config, second.signal)).text, original.address);
    const separate = turn(tools, "chat-two");
    await assert.rejects(tools.execute("browser_snapshot", {}, config, separate.signal), /No browser page/);
    await tools.testing.ensureBrowser(tools.testing.currentBrowserRun(separate.signal));
    assert.equal(launches.length, 2);
    await tools.execute("browser_close", {}, config, second.signal);
    assert.equal(original.closed, true);
    await tools.testing.ensureBrowser(tools.testing.currentBrowserRun(second.signal));
    assert.equal(launches.length, 3);
    await tools.closeRun(second.signal);
    assert.equal(tools.testing.conversationBrowsers.size, 2);
  } finally { await tools.close(); }
  assert.equal(tools.testing.conversationBrowsers.size, 0);
});

test("saved task browsers are headless and close on run completion", async () => {
  const { tools, launches, contexts, browsers } = await harness();
  try {
    const controller = turn(tools);
    await tools.testing.ensureBrowser(tools.testing.currentBrowserRun(controller.signal));
    assert.equal(launches[0].headless, true);
    assert.equal(launches[0].channel, undefined);
    assert.equal(Object.hasOwn(contexts[0], "viewport"), false, "Saved tasks retain Playwright's default viewport.");
    await tools.closeRun(controller.signal);
    assert.equal(browsers[0].context.pages()[0].closed, true);
    assert.equal(tools.testing.browserRuns.size, 0);
  } finally { await tools.close(); }
});

test("browser startup reports the missing engine without misdiagnosing other launch failures", async () => {
  for (const [conversation, message, expected] of [
    ["edge-missing", "browserType.launch: Chromium distribution 'msedge' is not found", /Microsoft Edge is required/],
    [undefined, "browserType.launch: Executable doesn't exist at chromium.exe", /playwright install chromium/],
    ["edge-other", "browserType.launch: Access denied", /^Error: browserType.launch: Access denied$/]
  ]) {
    const { tools } = await harness(new Error(message));
    try {
      const controller = turn(tools, conversation);
      await assert.rejects(tools.testing.ensureBrowser(tools.testing.currentBrowserRun(controller.signal)), expected);
    } finally { await tools.close(); }
  }
});

test("cancellation interrupts actions without discarding other conversation tabs", async () => {
  const { tools, browsers } = await harness();
  try {
    const controller = turn(tools, "cancel-chat");
    await tools.testing.ensureBrowser(tools.testing.currentBrowserRun(controller.signal));
    const page = browsers[0].context.pages()[0];
    page.waitForClose = new Promise(resolve => { page.resolveClose = resolve; });
    const pending = tools.execute("browser_click", { selector: "#wait" }, config, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    const switched = await browsers[0].context.newPage();
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(page.closed, true);
    assert.equal(switched.closed, false, "Stop must close the action's tab, not a tab selected while it was waiting.");
    assert.equal(tools.testing.conversationBrowsers.size, 1);
    const next = turn(tools, "cancel-chat");
    await tools.testing.ensureBrowser(tools.testing.currentBrowserRun(next.signal));
    await browsers[0].context.newPage();
    assert.ok(await tools.execute("browser_snapshot", {}, config, next.signal));
  } finally { await tools.close(); }
});

test("conversation identifiers are validated and cancellation during startup closes resources", async () => {
  const harnessed = await harness();
  const { tools, browsers } = harnessed;
  try {
    assert.throws(() => tools.bindConversation(new AbortController().signal, "../bad"), /valid signal and conversation ID/);
    const controller = turn(tools, "startup-cancel");
    let release;
    harnessed.setGate(new Promise(resolve => { release = resolve; }));
    const run = tools.testing.currentBrowserRun(controller.signal);
    const pending = tools.testing.browserOperation(controller.signal, async () => {
      await tools.testing.ensureBrowser(run);
      controller.signal.throwIfAborted();
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    release();
    await assert.rejects(pending, /abort/i);
    assert.equal(browsers[0].context.pages()[0].closed, true);
    assert.equal(tools.testing.conversationBrowsers.size, 0);
  } finally { await tools.close(); }
});
