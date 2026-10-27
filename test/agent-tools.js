"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const tools = require("../src/agent-tools");
const net = require("node:net");
const vm = require("node:vm");
const { Duplex } = require("node:stream");
const { createRequire } = require("node:module");

async function withTempDir(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "horizon-agent-tools-"));
  try {
    await run(root);
  } finally {
    await tools.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function settings(root, flags = {}) {
  return {
    flags: { files: true, commands: true, browser: true, mcp: true, ...flags },
    roots: [root],
    commands: [],
    mcpServers: []
  };
}

test("definitions are feature-flag gated and MCP tools require a configured server", () => {
  const config = settings("C:\\approved", { files: false, commands: false, browser: false, mcp: true });
  assert.deepEqual(tools.definitions(config), []);
  config.mcpServers.push({ id: "local" });
  assert.deepEqual(tools.definitions(config).map(item => item.function.name), ["mcp_list_tools", "mcp_call_tool"]);
});

test("file operations stay under roots, reject traversal and symlinks, and require a hash to overwrite", async () => {
  await withTempDir(async root => {
    const config = settings(root);
    await fs.writeFile(path.join(root, "note.txt"), "alpha\nbeta");
    const listed = await tools.execute("file_list", { path: "." }, config);
    assert.ok(listed.entries.some(item => item.name === "note.txt"));
    const read = await tools.execute("file_read", { path: "note.txt" }, config);
    assert.equal(read.content, "alpha\nbeta");
    assert.equal((await tools.execute("file_search", { path: ".", query: "beta" }, config)).matches[0].line, 2);

    await assert.rejects(tools.execute("file_read", { path: "..\\outside.txt" }, config), /outside the approved roots/);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    await fs.writeFile(outside, "outside");
    try {
      const link = path.join(root, "escape.txt");
      let linked = true;
      try {
        await fs.symlink(outside, link);
      } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") linked = false;
        else throw error;
      }
      if (linked) {
        await assert.rejects(tools.execute("file_read", { path: "escape.txt" }, config), /Symbolic links and junctions/);
        await assert.rejects(
          tools.execute("file_write", { path: "escape.txt", content: "blocked" }, config),
          /Symbolic links and junctions/
        );
      }
    } finally {
      await fs.rm(outside, { force: true });
    }

    await tools.execute("file_write", { path: "new.txt", content: "first" }, config);
    await assert.rejects(tools.execute("file_write", { path: "new.txt", content: "second" }, config), /Target exists/);
    await assert.rejects(tools.execute("file_write", { path: "new.txt", content: "second", overwrite: true }, config), /requires the existing file/);
    const old = await tools.execute("file_read", { path: "new.txt" }, config);
    await tools.execute("file_write", { path: "new.txt", content: "second", overwrite: true, expectedSha256: old.sha256 }, config);
    assert.equal((await tools.execute("file_read", { path: "new.txt" }, config)).content, "second");
  });
});

test("disabled tools and malformed arguments are rejected by execute", async () => {
  await withTempDir(async root => {
    const config = settings(root, { files: false });
    await assert.rejects(tools.execute("file_read", { path: "anything" }, config), /disabled/);
    config.flags.files = true;
    await assert.rejects(tools.execute("file_read", { path: "..", extra: true }, config), /Unexpected argument/);
  });
});

test("commands use only fixed configured argv, cap output and honour cancellation", async () => {
  await withTempDir(async root => {
    const script = path.join(root, "command.js");
    await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const config = settings(root);
    config.commands.push({ id: "safe", executable: process.execPath, args: [script, "fixed"], cwd: root });
    const result = await tools.execute("command_run", { commandId: "safe" }, config);
    assert.equal(result.stdout, '["fixed"]');
    await assert.rejects(tools.execute("command_run", { commandId: "safe", args: ["injected"] }, config), /Unexpected argument/);

    const noisy = path.join(root, "noisy.js");
    await fs.writeFile(noisy, "process.stdout.write('x'.repeat(40000)); setTimeout(() => {}, 10000)");
    config.commands.push({ id: "noisy", executable: process.execPath, args: [noisy], cwd: root });
    await assert.rejects(tools.execute("command_run", { commandId: "noisy" }, config), /output exceeded/);

    const failure = path.join(root, "failure.js");
    await fs.writeFile(failure, "process.stderr.write('expected failure'); process.exitCode = 7");
    config.commands.push({ id: "failure", executable: process.execPath, args: [failure], cwd: root });
    await assert.rejects(tools.execute("command_run", { commandId: "failure" }, config), /exited with code 7: expected failure/);

    const slow = path.join(root, "slow.js");
    await fs.writeFile(slow, "setTimeout(() => {}, 10000)");
    config.commands.push({ id: "slow", executable: process.execPath, args: [slow], cwd: root });
    const controller = new AbortController();
    const pending = tools.execute("command_run", { commandId: "slow" }, config, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /cancelled/);
  });
});

test("browser URLs and subrequests reject non-public targets", async () => {
  await withTempDir(async root => {
    const config = settings(root);
    await assert.rejects(tools.execute("browser_open", { url: "http://example.com" }, config), /public HTTPS/);
    await assert.rejects(tools.execute("browser_open", { url: "https://127.0.0.1/" }, config), /public HTTPS/);
    await assert.rejects(tools.execute("browser_open", { url: "https://[::1]/" }, config), /public HTTPS/);
    await assert.rejects(tools.execute("browser_open", { url: "file:///etc/passwd" }, config), /public HTTPS/);
  });
});

test("CONNECT proxy pins the vetted IP and rejects DNS rebinding and non-HTTPS tunnels", async () => {
  const filename = path.join(__dirname, "..", "src", "agent-tools.js");
  const localRequire = createRequire(filename);
  const source = await fs.readFile(filename, "utf8");
  const connections = [];
  let lookups = 0;
  const context = {
    module: { exports: {} },
    Buffer, URL, TextDecoder, process, setTimeout, clearTimeout,
    require(name) {
      if (name === "node:dns") {
        return { promises: { async lookup() {
          lookups += 1;
          return [{ address: lookups === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 }];
        } } };
      }
      if (name === "node:net") {
        return {
          ...net,
          connect(options) {
            connections.push(options);
            const upstream = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
            upstream.setTimeout = () => upstream;
            process.nextTick(() => upstream.emit("connect"));
            return upstream;
          }
        };
      }
      return localRequire(name);
    }
  };
  vm.runInNewContext(`${source}\nmodule.exports = { startPublicProxy, isPublicIp };`, context, { filename });
  const internals = context.module.exports;
  for (const address of ["::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) {
    assert.equal(internals.isPublicIp(address), false, address);
  }
  const proxy = await internals.startPublicProxy();
  async function connect(authority) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxy.server.address().port, "127.0.0.1");
      socket.setTimeout(3000, () => socket.destroy(new Error("Proxy test timed out")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      socket.once("data", chunk => {
        resolve(chunk.toString("utf8"));
        socket.destroy();
      });
    });
  }
  try {
    assert.match(await connect("rebind.example.com:443"), /200 Connection Established/);
    assert.equal(connections[0].host, "93.184.215.14");
    assert.equal(connections[0].port, 443);
    assert.match(await connect("rebind.example.com:443"), /403 Forbidden/);
    assert.equal(connections.length, 1, "rebinding must not open another upstream connection");
    assert.match(await connect("example.com:80"), /403 Forbidden/);
    assert.equal(connections.length, 1);
  } finally {
    await proxy.close();
  }
});

test("configured MCP tools are discovered and invoked over stdio", async () => {
  await withTempDir(async root => {
    const server = path.join(root, "mcp-stub.js");
    await fs.writeFile(server, [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  let index;",
      "  while ((index = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);",
      "    const message = JSON.parse(line);",
      "    let result;",
      "    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'stub', version: '1' } };",
      "    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: String(process.pid), inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };",
      "    else if (message.method === 'tools/call') result = message.params.arguments.error ? { isError: true, content: [{ type: 'text', text: 'expected MCP error' }] } : { content: [{ type: 'text', text: message.params.arguments.value + ':' + process.pid }] };",
      "    else if (message.method === 'ping') result = {};",
      "    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
      "  }",
      "});"
    ].join("\n"));
    const config = settings(root);
    config.mcpServers.push({ id: "stub", command: process.execPath, args: [server], cwd: root });
    const controller = new AbortController();
    try {
      const listed = await tools.execute("mcp_list_tools", { serverId: "stub" }, config, controller.signal);
      assert.equal(listed.tools[0].name, "echo");
      const called = await tools.execute("mcp_call_tool", { serverId: "stub", toolName: "echo", arguments: { value: "works" } }, config, controller.signal);
      assert.equal(called.content[0].text, `works:${listed.tools[0].description}`);
      await assert.rejects(
        tools.execute("mcp_call_tool", { serverId: "stub", toolName: "echo", arguments: { error: true } }, config, controller.signal),
        /MCP tool "stub.echo" failed/
      );
    } finally {
      await tools.closeRun(controller.signal);
    }
  });
});

test("close shuts down a browser session registry without requiring browser startup", async () => {
  assert.equal(typeof tools.closeRun, "function");
  await tools.closeRun(new AbortController().signal);
  await tools.close();
  assert.ok(true);
});

test("closeRun terminates an MCP stdio process bound to the run signal", async () => {
  await withTempDir(async root => {
    const server = path.join(root, "mcp-wait.js");
    await fs.writeFile(server, [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  let index;",
      "  while ((index = buffer.indexOf('\\n')) >= 0) {",
      "    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);",
      "    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'wait', version: '1' } } }) + '\\n');",
      "    else if (message.method === 'tools/call') setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'late' }] } }) + '\\n'), 10000);",
      "  }",
      "});"
    ].join("\n"));
    const config = settings(root);
    config.mcpServers.push({ id: "wait", command: process.execPath, args: [server], cwd: root });
    const controller = new AbortController();
    const pending = tools.execute("mcp_call_tool", { serverId: "wait", toolName: "wait", arguments: {} }, config, controller.signal);
    const rejected = assert.rejects(pending, /exited with code|cancelled|closed/);
    await new Promise(resolve => setTimeout(resolve, 100));
    await tools.closeRun(controller.signal);
    await rejected;
  });
});
