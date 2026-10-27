"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "tools", "setup-agent-runtime.js"), "utf8");

function setup({ installed = false, status = 0, args = [] } = {}) {
  const calls = [], errors = [], logs = [];
  const process = { argv: ["node", "setup-agent-runtime.js", ...args], execPath: "test-node", exitCode: 0 };
  const fakeRequire = name => {
    if (name === "node:fs") return { existsSync: () => installed };
    if (name === "node:path") return path;
    if (name === "playwright") return { chromium: { executablePath: () => "chromium" } };
    if (name === require.resolve("playwright/package.json")) return require(name);
    if (name === "node:child_process") return { spawnSync: (...parameters) => {
      calls.push(parameters);
      if (status === 0) installed = true;
      return { status };
    } };
    throw new Error(`Unexpected dependency ${name}`);
  };
  fakeRequire.resolve = name => name === "node-pty" ? "node-pty" : require.resolve(name);
  vm.runInNewContext(script, {
    require: fakeRequire, process,
    console: { log: message => logs.push(message), error: message => errors.push(message) }
  });
  return { calls, errors, logs, process };
}

test("first-run setup resolves the installed Playwright bin without unexported package paths", () => {
  const result = setup();
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.calls.length, 1);
  const [executable, args] = result.calls[0];
  assert.equal(executable, "test-node");
  assert.equal(args[0], path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"));
  assert.ok(fs.existsSync(args[0]));
  assert.deepEqual(Array.from(args.slice(1)), ["install", "chromium"]);
  assert.equal(result.errors.length, 0);
});

test("setup check mode never downloads and reports missing or existing Chromium accurately", () => {
  for (const installed of [false, true]) {
    const result = setup({ installed, args: ["--check"] });
    assert.equal(result.process.exitCode, installed ? 0 : 1);
    assert.equal(result.calls.length, 0);
  }
});

test("failed browser installation surfaces failure without claiming runtime readiness", () => {
  const result = setup({ status: 1 });
  assert.equal(result.process.exitCode, 1);
  assert.match(result.errors.join("\n"), /setup did not finish/);
  assert.ok(!result.logs.some(message => message.includes("runtime is ready")));
});
