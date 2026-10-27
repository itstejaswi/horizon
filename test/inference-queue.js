"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InferenceQueue } = require("../src/inference-queue");
const { acquireAgentOwner } = require("../src/agent-owner");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("inference is serial and a failed request does not stall the queue", async () => {
  const queue = new InferenceQueue();
  const order = [];
  let release;
  const first = queue.run(async () => {
    order.push("first");
    await new Promise(resolve => { release = resolve; });
    throw new Error("model failed");
  });
  const failed = assert.rejects(first, /model failed/);
  const second = queue.run(async () => { order.push("second"); return "ok"; });
  assert.deepEqual(order, ["first"]);
  release();
  await failed;
  assert.equal(await second, "ok");
  assert.deepEqual(order, ["first", "second"]);
});

test("cancelled queued inference never executes and queue length is bounded", async () => {
  const queue = new InferenceQueue(1);
  let release;
  const first = queue.run(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  let executed = false;
  const second = queue.run(async () => { executed = true; }, controller.signal);
  const cancelled = assert.rejects(second, /cancelled/);
  await assert.rejects(queue.run(async () => {}), /full/);
  controller.abort(new Error("cancelled"));
  await cancelled;
  const third = queue.run(async () => "third");
  release();
  await first;
  assert.equal(await third, "third");
  assert.equal(executed, false);
});

test("only one process can own a persistent agent directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-agent-owner-"));
  let first;
  let next;
  try {
    first = await acquireAgentOwner(directory);
    await assert.rejects(acquireAgentOwner(directory), /already in use/);
    await new Promise(resolve => first.close(resolve));
    first = null;
    next = await acquireAgentOwner(directory);
  } finally {
    if (first) await new Promise(resolve => first.close(resolve));
    if (next) await new Promise(resolve => next.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
