"use strict";

const { spawn } = require("node:child_process");

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TOTAL_MCP_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MCP_TIMEOUT_MS = 30_000;
const activeChildren = new Set();
const activeSessions = new Set();
const sessionsBySignal = new WeakMap();

function boundedJson(value, maxBytes = MAX_RESULT_BYTES) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return value;
  return {
    truncated: true,
    output: Buffer.from(json, "utf8").subarray(0, Math.max(0, maxBytes - 128)).toString("utf8")
  };
}

function killProcessTree(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    const path = require("node:path");
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(executable, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false
    });
    killer.on("error", () => child.kill());
  } else {
    child.kill("SIGKILL");
  }
}

function safeEnvironment() {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  return Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve();
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
  });
}

async function createSession(server, signal, onClosed) {
  if (signal && signal.aborted) throw new Error(`MCP server "${server.id}" cancelled`);
  const child = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: safeEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  activeChildren.add(child);
  let nextId = 0;
  const pending = new Map();
  let stderr = "";
  let stdoutBuffer = Buffer.alloc(0);
  let totalOutputBytes = 0;
  let closing;
  let session;

  function failPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      const error = new Error(`MCP server "${server.id}" sent a frame larger than ${MAX_FRAME_BYTES} bytes`);
      failPending(error);
      killProcessTree(child);
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      failPending(new Error(`MCP server "${server.id}" returned invalid JSON: ${error.message}`));
      killProcessTree(child);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      failPending(new Error(`MCP server "${server.id}" returned an invalid JSON-RPC message`));
      killProcessTree(child);
      return;
    }
    if (!Object.hasOwn(message, "id")) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`MCP server "${server.id}" error ${message.error.code}: ${message.error.message}`));
    } else if (!Object.hasOwn(message, "result")) {
      waiter.reject(new Error(`MCP server "${server.id}" returned a response without result`));
    } else {
      waiter.resolve(message.result);
    }
  }

  child.stdout.on("data", chunk => {
    totalOutputBytes += chunk.length;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline;
    while ((newline = stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = stdoutBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      handleLine(line);
    }
    if (stdoutBuffer.length > MAX_FRAME_BYTES || totalOutputBytes > MAX_TOTAL_MCP_BYTES) {
      const error = new Error(`MCP server "${server.id}" output exceeded its frame or total-output limit`);
      failPending(error);
      killProcessTree(child);
    }
  });
  child.stderr.on("data", chunk => {
    const remaining = 4096 - Buffer.byteLength(stderr, "utf8");
    if (remaining > 0) stderr += chunk.toString("utf8").slice(0, remaining);
  });
  child.on("error", error => failPending(new Error(`Unable to start MCP server "${server.id}": ${error.message}`)));
  child.on("close", (code, exitSignal) => {
    const detail = stderr ? `: ${stderr}` : "";
    failPending(new Error(`MCP server "${server.id}" exited with code ${code}${exitSignal ? ` (${exitSignal})` : ""}${detail}`));
    if (session && !closing) {
      session.close().catch(error => {
        process.emitWarning(`Unable to clean up exited MCP server "${server.id}": ${error.message}`);
      });
    }
  });

  function request(method, params = {}) {
    if (signal && signal.aborted) return Promise.reject(new Error(`MCP server "${server.id}" cancelled`));
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error(`MCP server "${server.id}" is no longer running`));
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP server "${server.id}" request "${method}" timed out after ${MCP_TIMEOUT_MS}ms`));
      }, MCP_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        reject(new Error(`Unable to send MCP "${method}" request: ${error.message}`));
      });
    });
  }

  const onAbort = () => {
    if (session) {
      session.close().catch(error => {
        process.emitWarning(`Unable to close MCP server "${server.id}" after run cancellation: ${error.message}`);
      });
    } else {
      killProcessTree(child);
      failPending(new Error(`MCP server "${server.id}" cancelled`));
    }
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  async function closeSession() {
    if (closing) return closing;
    closing = (async () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      failPending(new Error(`MCP server "${server.id}" connection closed`));
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await waitForClose(child, 1000);
      }
      if (child.exitCode === null && child.signalCode === null) {
        killProcessTree(child);
        await waitForClose(child, 1000);
      }
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`MCP server "${server.id}" process tree did not terminate`);
      }
      activeSessions.delete(session);
      activeChildren.delete(child);
      if (onClosed) onClosed(session);
    })();
    return closing;
  }

  try {
    await new Promise((resolve, reject) => {
      if (child.pid) resolve();
      else {
        child.once("spawn", resolve);
        child.once("error", reject);
      }
    });
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "horizon-agent-tools", version: "1.0.0" }
    });
    if (!initialized || typeof initialized.protocolVersion !== "string" || !initialized.capabilities || !initialized.serverInfo) {
      throw new Error(`MCP server "${server.id}" returned an invalid initialize result`);
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    if (signal && signal.aborted) throw new Error(`MCP server "${server.id}" cancelled`);
    session = { request, close: closeSession, serverId: server.id };
    activeSessions.add(session);
    return session;
  } catch (error) {
    await closeSession().catch(cleanupError => {
      throw new AggregateError([error, cleanupError], `MCP server "${server.id}" setup failed and cleanup was incomplete`);
    });
    throw error;
  }
}

function serverKey(server) {
  return JSON.stringify({ command: server.command, args: server.args, cwd: server.cwd });
}

async function withClient(server, signal, operation) {
  if (signal && signal.aborted) throw new Error(`MCP server "${server.id}" cancelled`);
  if (!signal) {
    const session = await createSession(server, null);
    try {
      return await operation(session.request);
    } finally {
      await session.close();
    }
  }

  let sessions = sessionsBySignal.get(signal);
  if (!sessions) {
    sessions = new Map();
    sessionsBySignal.set(signal, sessions);
  }
  const key = serverKey(server);
  let entry = sessions.get(server.id);
  if (entry && entry.key !== key) {
    if (entry.session) await entry.session.close();
    else await entry.promise.catch(() => {});
    entry = null;
  }
  if (!entry) {
    entry = { key, session: null, promise: null };
    const currentEntry = entry;
    entry.promise = createSession(server, signal, session => {
      if (currentEntry.session === session && sessions.get(server.id) === currentEntry) {
        sessions.delete(server.id);
      }
    }).then(session => {
      currentEntry.session = session;
      return session;
    }).catch(error => {
      if (sessions.get(server.id) === currentEntry) sessions.delete(server.id);
      throw error;
    });
    sessions.set(server.id, entry);
  }
  const session = entry.session || await entry.promise;
  if (signal.aborted) throw new Error(`MCP server "${server.id}" cancelled`);
  return operation(session.request);
}

async function listTools(server, signal) {
  return withClient(server, signal, async request => {
    const tools = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await request("tools/list", cursor ? { cursor } : {});
      if (!result || !Array.isArray(result.tools)) throw new Error(`MCP server "${server.id}" returned an invalid tools list`);
      tools.push(...result.tools);
      if (tools.length > 500) throw new Error(`MCP server "${server.id}" exposed more than 500 tools`);
      const bytes = Buffer.byteLength(JSON.stringify({ serverId: server.id, tools }), "utf8");
      if (bytes > MAX_RESULT_BYTES) throw new Error(`MCP server "${server.id}" tools list exceeds the ${MAX_RESULT_BYTES}-byte limit`);
      if (!result.nextCursor) break;
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) {
        throw new Error(`MCP server "${server.id}" returned an invalid or repeated tools cursor`);
      }
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
      if (page === 19) throw new Error(`MCP server "${server.id}" tools list exceeded 20 pages`);
    }
    return { serverId: server.id, tools };
  });
}

async function callTool(server, name, args, signal) {
  return withClient(server, signal, async request => {
    const result = await request("tools/call", { name, arguments: args });
    if (!result || !Array.isArray(result.content)) throw new Error(`MCP tool "${server.id}.${name}" returned an invalid result`);
    if (result.isError) throw new Error(`MCP tool "${server.id}.${name}" failed: ${JSON.stringify(boundedJson(result))}`);
    return boundedJson(result);
  });
}

async function close() {
  const sessions = Array.from(activeSessions);
  const results = await Promise.allSettled(sessions.map(session => session.close()));
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  for (const child of Array.from(activeChildren)) {
    killProcessTree(child);
    await waitForClose(child, 2000);
    if (child.exitCode === null && child.signalCode === null) {
      errors.push(new Error(`MCP child process ${child.pid} did not terminate during shutdown`));
    }
  }
  if (errors.length) throw new Error(`Unable to close MCP sessions: ${errors.map(error => error.message).join("; ")}`);
}

async function closeRun(signal) {
  if (!signal || (typeof signal !== "object" && typeof signal !== "function")) return;
  const sessions = sessionsBySignal.get(signal);
  if (!sessions) return;
  const entries = Array.from(sessions.values());
  const resolved = await Promise.all(entries.map(entry => entry.session ? entry.session : entry.promise.catch(() => null)));
  const results = await Promise.allSettled(resolved.filter(Boolean).map(session => session.close()));
  if (sessions.size === 0) sessionsBySignal.delete(signal);
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new Error(`Unable to close MCP run sessions: ${errors.map(error => error.message).join("; ")}`);
}

module.exports = { listTools, callTool, closeRun, close };
