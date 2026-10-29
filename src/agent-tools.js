"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");
const { spawn } = require("node:child_process");
const agentMcp = require("./agent-mcp");

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOOL_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const browserRuns = new Map();
const browserRunSet = new Set();

const schemas = {
  file_list: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  file_read: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  file_search: { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["path", "query"], additionalProperties: false },
  file_write: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean", description: "Omit for a new file. Set true only when replacing an existing file, with its expectedSha256." },
      expectedSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Existing file hash returned by file_read; required only for overwrite=true. Omit for a new file. Never invent a hash." }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  command_run: { type: "object", properties: { commandId: { type: "string" } }, required: ["commandId"], additionalProperties: false },
  browser_open: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  browser_snapshot: { type: "object", properties: {}, additionalProperties: false },
  browser_click: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false },
  browser_fill: {
    type: "object",
    properties: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
    additionalProperties: false
  },
  browser_close: { type: "object", properties: {}, additionalProperties: false },
  mcp_list_tools: { type: "object", properties: { serverId: { type: "string" } }, required: ["serverId"], additionalProperties: false },
  mcp_call_tool: {
    type: "object",
    properties: {
      serverId: { type: "string" },
      toolName: { type: "string" },
      arguments: { type: "object" }
    },
    required: ["serverId", "toolName", "arguments"],
    additionalProperties: false
  }
};

const descriptions = {
  file_list: "List entries in a directory under an approved root.",
  file_read: "Read a bounded UTF-8 text file under an approved root.",
  file_search: "Search bounded text files recursively under an approved root.",
  file_write: "Create a bounded UTF-8 text file under an approved root using path and content only. To overwrite an existing file, also provide overwrite=true and its current SHA-256 from file_read.",
  command_run: "Run one preconfigured command by id; its executable, arguments and working directory cannot be supplied by the model.",
  browser_open: "Open a public HTTPS page in an isolated ephemeral browser and return its title plus the start of its main text as excerpt. Public network access is routed through an IP-validating proxy; private/internal and non-HTTPS requests are blocked.",
  browser_snapshot: "Return up to 20000 characters of visible text from the current browser page. Use it when the browser_open excerpt does not contain what you need.",
  browser_click: "Click the first element matching a CSS selector on the current page.",
  browser_fill: "Fill a form field matching a CSS selector on the current page.",
  browser_close: "Close and discard the current isolated browser session.",
  mcp_list_tools: "Start a configured local MCP server and list its tool names and schemas.",
  mcp_call_tool: "Start a configured local MCP server and call one of its tools. Calls may have side effects and require engine approval."
};

function tool(name) {
  return { type: "function", function: { name, description: descriptions[name], parameters: schemas[name] } };
}

function definitions(settings = {}) {
  const flags = settings.flags || {};
  const output = [];
  if (flags.files === true && Array.isArray(settings.roots) && settings.roots.length) {
    output.push(...["file_list", "file_read", "file_search", "file_write"].map(tool));
  }
  if (flags.commands === true && Array.isArray(settings.commands) && settings.commands.length) output.push(tool("command_run"));
  if (flags.browser === true) output.push(...["browser_open", "browser_snapshot", "browser_click", "browser_fill", "browser_close"].map(tool));
  if (flags.mcp === true && Array.isArray(settings.mcpServers) && settings.mcpServers.length) {
    output.push(tool("mcp_list_tools"), tool("mcp_call_tool"));
  }
  return output;
}

function ensureArgs(args, required, optional = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error(`Missing required argument "${key}"`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`Unexpected argument "${key}"`);
  }
}

function stringArg(value, label, maxBytes = MAX_FILE_BYTES) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  return value;
}

function approvedRoots(settings) {
  if (!settings || !Array.isArray(settings.roots)) throw new Error("Approved roots are not configured");
  return settings.roots.map(root => {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Every approved root must be an absolute path");
    return path.resolve(root);
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function rejectLinksInPath(target, root) {
  const absoluteRoot = path.parse(root).root;
  const rootRelative = path.relative(absoluteRoot, root);
  const targetRelative = path.relative(root, target);
  let current = absoluteRoot;
  for (const part of [...rootRelative.split(path.sep).filter(Boolean), ...targetRelative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${current}`);
    if (path.resolve(current) === path.resolve(root) && !stat.isDirectory()) {
      throw new Error(`Approved root is not a real directory: ${root}`);
    }
  }
  return current;
}

async function resolveApprovedPath(pathArg, settings, { mustExist = false } = {}) {
  stringArg(pathArg, "path", 4096);
  if (!pathArg || pathArg.includes("\0")) throw new Error("path must be a non-empty path without NUL characters");
  const roots = approvedRoots(settings);
  if (!roots.length) throw new Error("No approved roots are configured");
  const candidates = path.isAbsolute(pathArg)
    ? [path.resolve(pathArg)]
    : roots.map(root => path.resolve(root, pathArg));
  for (const candidate of candidates) {
    const root = roots.find(item => isWithin(item, candidate));
    if (!root) continue;
    const checked = await rejectLinksInPath(candidate, root);
    if (mustExist) {
      const stat = await fsp.lstat(checked);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${checked}`);
    }
    return { path: checked, root };
  }
  throw new Error(`Path is outside the approved roots: ${pathArg}`);
}

async function readBoundedFile(target, maxBytes) {
  const before = await fsp.lstat(target);
  if (before.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${target}`);
  if (!before.isFile()) throw new Error(`Expected a regular file: ${target}`);
  if (before.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte limit`);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(target, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`File changed while opening; refusing to read: ${target}`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte limit`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fileList(args, settings) {
  ensureArgs(args, ["path"]);
  const { path: target } = await resolveApprovedPath(args.path, settings, { mustExist: true });
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new Error("file_list path must be a directory");
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    output.push({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    if (output.length >= 100) break;
  }
  return { entries: output, truncated: entries.length > output.length };
}

async function fileRead(args, settings) {
  ensureArgs(args, ["path"]);
  const { path: target } = await resolveApprovedPath(args.path, settings, { mustExist: true });
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error("file_read path must be a regular file");
  const buffer = await readBoundedFile(target, MAX_FILE_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  return { path: target, content: text, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

async function fileSearch(args, settings) {
  ensureArgs(args, ["path", "query"], ["limit"]);
  const query = stringArg(args.query, "query", 4096);
  if (!query) throw new Error("query must not be empty");
  const limit = args.limit === undefined ? 50 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
  const { path: root, root: approvedRoot } = await resolveApprovedPath(args.path, settings, { mustExist: true });
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error("file_search path must be a directory");
  const found = [];
  let totalBytes = 0;
  let truncated = false;
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= limit || totalBytes >= MAX_TOOL_BYTES) {
        truncated = true;
        return;
      }
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${filename}`);
      if (entry.isDirectory()) {
        await visit(filename);
      } else if (entry.isFile()) {
        const checked = await resolveApprovedPath(filename, { roots: [approvedRoot] }, { mustExist: true });
        const stat = await fsp.lstat(checked.path);
        if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOOL_BYTES) {
          truncated = true;
          continue;
        }
        const buffer = await readBoundedFile(checked.path, Math.min(MAX_FILE_BYTES, MAX_TOOL_BYTES - totalBytes));
        totalBytes += buffer.length;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(query)) {
            const result = { path: checked.path, line: index + 1, text: lines[index].slice(0, 500) };
            const currentBytes = Buffer.byteLength(JSON.stringify(found), "utf8");
            if (currentBytes + Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TOOL_BYTES) {
              truncated = true;
              return;
            }
            found.push(result);
            if (found.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  }
  await visit(root);
  return { matches: found, truncated };
}

async function fileWrite(args, settings) {
  ensureArgs(args, ["path", "content"], ["overwrite", "expectedSha256"]);
  const content = stringArg(args.content, "content");
  if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") throw new Error("overwrite must be a boolean");
  if (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(args.expectedSha256))) {
    throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256");
  }
  const overwrite = args.overwrite === true;
  if (overwrite && !args.expectedSha256) throw new Error("overwrite requires the existing file's expectedSha256");
  const { path: target } = await resolveApprovedPath(args.path, settings);
  const parent = path.dirname(target);
  await rejectLinksInPath(parent, (await resolveApprovedPath(args.path, settings)).root);
  const parentStat = await fsp.stat(parent);
  if (!parentStat.isDirectory()) throw new Error("The parent path must be a directory");
  const data = Buffer.from(content, "utf8");
  const temp = path.join(parent, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const handle = await fsp.open(temp, "wx", 0o600);
  let writeError;
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close().catch(error => {
      if (!writeError) writeError = error;
    });
  }
  if (writeError) {
    try {
      await fsp.unlink(temp);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw new AggregateError([writeError, cleanupError], "File write failed and its temporary file could not be removed");
      }
    }
    throw writeError;
  }

  try {
    const current = await fsp.lstat(target).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current && current.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed: ${target}`);
    if (current && !overwrite) throw new Error("Target exists; set overwrite=true and provide its expectedSha256 to replace it");
    if (overwrite) {
      if (!current || !current.isFile()) throw new Error("Overwrite target must be an existing regular file");
      const old = await readBoundedFile(target, MAX_FILE_BYTES);
      const hash = crypto.createHash("sha256").update(old).digest("hex");
      if (hash !== args.expectedSha256.toLowerCase()) throw new Error("Existing file hash changed; refusing to overwrite");
      await fsp.rename(temp, target);
    } else {
      await fsp.link(temp, target);
      await fsp.unlink(temp);
    }
    return { path: target, bytesWritten: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

function configuredCommand(settings, commandId) {
  if (!Array.isArray(settings.commands)) throw new Error("No approved commands are configured");
  const matches = settings.commands.filter(item => item && item.id === commandId);
  if (matches.length !== 1) throw new Error(`Command id is not uniquely configured: ${commandId}`);
  const command = matches[0];
  if (typeof command.executable !== "string" || !path.isAbsolute(command.executable)) {
    throw new Error(`Configured command "${commandId}" must have an absolute executable`);
  }
  if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string")) {
    throw new Error(`Configured command "${commandId}" must have fixed string arguments`);
  }
  if (typeof command.cwd !== "string" || !path.isAbsolute(command.cwd)) {
    throw new Error(`Configured command "${commandId}" must have an absolute working directory`);
  }
  const root = approvedRoots(settings).find(item => isWithin(item, path.resolve(command.cwd)));
  if (!root) throw new Error(`Configured command "${commandId}" working directory is outside approved roots`);
  return { ...command, cwd: path.resolve(command.cwd), root };
}

function killProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false
    });
    killer.on("error", error => {
      child.kill();
      process.emitWarning(`Unable to terminate command process tree: ${error.message}`);
    });
  } else {
    child.kill("SIGKILL");
  }
}

async function runCommand(args, settings, signal) {
  ensureArgs(args, ["commandId"]);
  const commandId = stringArg(args.commandId, "commandId", 256);
  const command = configuredCommand(settings, commandId);
  await rejectLinksInPath(command.cwd, command.root);
  if (!(await fsp.stat(command.cwd)).isDirectory()) throw new Error(`Command "${commandId}" working directory is not a directory`);
  if (signal && signal.aborted) throw new Error("Command cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let failure;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (current, chunk, stream) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length + (stream === "stdout" ? stderr.length : stdout.length) > MAX_COMMAND_BYTES) {
        if (!failure) {
          failure = new Error(`Command output exceeded the ${MAX_COMMAND_BYTES}-byte limit`);
          killProcessTree(child);
        }
        return current;
      }
      return combined;
    };
    const onAbort = () => {
      if (!failure) {
        failure = new Error("Command cancelled");
        killProcessTree(child);
      }
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk, "stderr"); });
    child.on("error", error => finish(new Error(`Unable to start command "${commandId}": ${error.message}`)));
    child.on("close", (code, exitSignal) => {
      if (failure) return finish(failure);
      if (code !== 0) {
        finish(new Error(`Command "${commandId}" exited with code ${code}${exitSignal ? ` (${exitSignal})` : ""}: ${stderr.toString("utf8")}`));
      } else {
        finish(null, { commandId, exitCode: code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      }
    });
    timer = setTimeout(() => {
      if (!failure) {
        failure = new Error(`Command "${commandId}" timed out after ${COMMAND_TIMEOUT_MS}ms`);
        killProcessTree(child);
      }
    }, COMMAND_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function ipv4IsPublic(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6ToBigInt(address) {
  let value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = value.slice(separator + 1);
    if (!ipv4IsPublic(ipv4)) return null;
    const numbers = ipv4.split(".").map(Number);
    value = `${value.slice(0, separator)}:${((numbers[0] << 8) | numbers[1]).toString(16)}:${((numbers[2] << 8) | numbers[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || zeros < 0) return null;
  const words = [...left, ...Array(zeros).fill("0"), ...right].map(word => parseInt(word, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}

function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) return ipv4IsPublic(address);
  if (version !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  const firstWord = value >> 112n;
  const secondWord = (value >> 96n) & 0xffffn;
  return (value >> 125n) === 1n && !(
    (firstWord === 0x2001n && secondWord === 0x0db8n) ||
    (firstWord === 0x2001n && secondWord <= 0x01ffn) ||
    (firstWord === 0x2002n) ||
    (firstWord === 0x3fffn && (secondWord >> 12n) === 0n)
  );
}

function safeHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      normalized.endsWith(".test") || normalized.endsWith(".invalid") ||
      normalized.endsWith(".example") || normalized.endsWith(".onion") || normalized.endsWith(".arpa") ||
      (!normalized.includes(".") && net.isIP(normalized) === 0)) {
    return false;
  }
  return true;
}

async function resolvePublicAddresses(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(normalized)) {
    if (!isPublicIp(normalized)) throw new Error("Private or reserved browser address blocked");
    return [{ address: normalized, family: net.isIP(normalized) }];
  }
  if (!safeHostname(normalized)) throw new Error("Internal or non-public browser hostname blocked");
  let addresses;
  try {
    addresses = await dns.lookup(normalized, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Browser hostname could not be resolved safely: ${error.message}`);
  }
  if (!addresses.length || addresses.some(entry => !isPublicIp(entry.address))) {
    throw new Error("Browser hostname resolves to a private, reserved, or unresolved address");
  }
  return addresses;
}

async function startPublicProxy() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(15_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let header = Buffer.alloc(0);
    const onData = async chunk => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 8192) {
        socket.destroy(new Error("Proxy header too large"));
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", onData);
      socket.pause();
      const request = header.subarray(0, end).toString("latin1");
      const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/i.exec(request.split("\r\n", 1)[0]);
      if (!match) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      try {
        const authority = new URL(`https://${match[1]}`);
        if (authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) {
          throw new Error("Invalid CONNECT authority");
        }
        if (authority.port && authority.port !== "443") throw new Error("Only HTTPS port 443 is permitted");
        const addresses = await resolvePublicAddresses(authority.hostname);
        if (socket.destroyed) return;
        const selected = addresses[0];
        const upstream = net.connect({ host: selected.address, port: 443, family: selected.family });
        upstream.setTimeout(15_000, () => upstream.destroy());
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.once("connect", () => {
          upstream.setTimeout(30_000, () => upstream.destroy());
          socket.setTimeout(30_000, () => socket.destroy());
          let bytes = 0;
          const count = chunk => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024) {
              socket.destroy();
              upstream.destroy();
            }
          };
          socket.on("data", count);
          upstream.on("data", count);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remainder = header.subarray(end + 4);
          if (remainder.length) upstream.write(remainder);
          socket.pipe(upstream);
          upstream.pipe(socket);
          socket.resume();
        });
        socket.once("close", () => upstream.destroy());
        upstream.once("close", () => socket.destroy());
        upstream.once("error", () => socket.destroy());
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    };
    socket.on("data", onData);
    socket.once("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    sockets,
    address: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

function currentBrowserRun(signal) {
  if (!signal || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean") {
    throw new Error("Browser tools require the AbortSignal for the current agent run");
  }
  if (!browserRuns.has(signal)) {
    const run = { key: signal, browser: null, context: null, page: null, proxy: null, pending: null, closing: null };
    browserRuns.set(signal, run);
    browserRunSet.add(run);
    signal.addEventListener("abort", () => {
      closeBrowserRun(run).catch(error => {
        process.emitWarning(`Unable to close browser after run cancellation: ${error.message}`);
      });
    }, { once: true });
  }
  return browserRuns.get(signal);
}

// Prefer the bundled Chromium. Where it could not be installed (for example
// when security software blocks unpacking it), drive the installed Microsoft
// Edge instead. Either way Playwright launches a fresh temporary profile, never
// the user's own browser profile, and the isolation below is identical.
function browserLaunchOptions(chromium, exists = fs.existsSync) {
  return exists(chromium.executablePath()) ? {} : { channel: "msedge" };
}

async function ensureBrowser(run) {
  if (run.context) return run;
  if (run.pending) return run.pending;
  run.pending = (async () => {
    const proxy = await startPublicProxy();
    let browser;
    try {
      const { chromium } = require("playwright");
      browser = await chromium.launch({
        ...browserLaunchOptions(chromium),
        headless: true,
        proxy: { server: proxy.address, bypass: "<-loopback>" },
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-quic",
          "--dns-prefetch-disable",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
        ]
      });
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      await context.route("**/*", async route => {
        let url;
        try {
          url = new URL(route.request().url());
        } catch {
          return route.abort("blockedbyclient");
        }
        if (url.protocol !== "https:" || !safeHostname(url.hostname)) return route.abort("blockedbyclient");
        try {
          await resolvePublicAddresses(url.hostname);
        } catch {
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      context.routeWebSocket("**/*", websocket => websocket.close());
      run.proxy = proxy;
      run.browser = browser;
      run.context = context;
      run.page = await context.newPage();
      return run;
    } catch (error) {
      const cleanupErrors = [];
      if (browser) await browser.close().catch(closeError => cleanupErrors.push(closeError));
      await proxy.close().catch(closeError => cleanupErrors.push(closeError));
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Browser startup failed and resources could not be fully closed");
      }
      if (/Executable doesn't exist|browserType.launch/i.test(error.message)) {
        throw new Error(`Playwright Chromium is not installed. Run "npx playwright install chromium" in the Horizon project. ${error.message}`);
      }
      throw error;
    }
  })();
  try {
    return await run.pending;
  } finally {
    run.pending = null;
  }
}

function closeBrowserRun(run) {
  if (run.closing) return run.closing;
  run.closing = (async () => {
    if (run.pending) await run.pending.catch(() => {});
    const errors = [];
    if (run.context) await run.context.close().catch(error => errors.push(error));
    if (run.browser) await run.browser.close().catch(error => errors.push(error));
    if (run.proxy) await run.proxy.close().catch(error => errors.push(error));
    run.context = null;
    run.browser = null;
    run.page = null;
    run.proxy = null;
    if (browserRuns.get(run.key) === run) browserRuns.delete(run.key);
    browserRunSet.delete(run);
    if (errors.length) throw new Error(`Unable to fully close browser session: ${errors.map(error => error.message).join("; ")}`);
  })();
  return run.closing;
}

async function browserOpen(args, signal) {
  ensureArgs(args, ["url"]);
  const urlText = stringArg(args.url, "url", 4096);
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("browser_open requires an absolute public HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !safeHostname(url.hostname)) {
    throw new Error("browser_open requires a public HTTPS URL without embedded credentials");
  }
  try {
    await resolvePublicAddresses(url.hostname);
  } catch (error) {
    throw new Error(`browser_open requires a public HTTPS URL: ${error.message}`);
  }
  const run = await ensureBrowser(currentBrowserRun(signal));
  await run.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  return { ...(await pageState(run.page)), ...(await pageExcerpt(run.page)) };
}

// Small models often answer straight after opening a page instead of calling
// browser_snapshot, and then invent the facts. Returning the start of the
// main content with the open puts real page text in front of them. It is kept
// short because small models run with a few thousand tokens of context.
const OPEN_EXCERPT_CHARS = 3000;

async function pageExcerpt(page) {
  try {
    return await page.evaluate(maxChars => {
      const root = document.querySelector("main, [role=main]") || document.body;
      const text = String(root?.innerText || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
      return { excerpt: text.slice(0, maxChars), excerptTruncated: text.length > maxChars };
    }, OPEN_EXCERPT_CHARS);
  } catch {
    // A page that cannot be read still opened; browser_snapshot can retry.
    return { excerpt: "", excerptTruncated: false };
  }
}

async function pageState(page) {
  const url = page.url();
  const title = await page.title();
  return {
    url: url.slice(0, 4096),
    urlTruncated: url.length > 4096,
    title: title.slice(0, 1000),
    titleTruncated: title.length > 1000
  };
}

async function browserSnapshot(signal) {
  const run = currentBrowserRun(signal);
  if (!run.page) throw new Error("No browser page is open; call browser_open first");
  const content = await run.page.locator("body").evaluate((body, maxChars) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = "";
    let visited = 0;
    let truncated = false;
    let node;
    while ((node = walker.nextNode())) {
      visited += 1;
      const parent = node.parentElement;
      if (parent && parent.closest("script,style,template,noscript")) continue;
      const piece = node.nodeValue || "";
      const separator = text ? "\n" : "";
      const remaining = maxChars - text.length - separator.length;
      if (piece.length > remaining) {
        text += separator + piece.slice(0, Math.max(0, remaining));
        truncated = true;
        break;
      }
      text += separator + piece;
      if (visited >= 10_000) {
        truncated = true;
        break;
      }
    }
    return { text, truncated };
  }, 20_000, { timeout: 5_000 });
  return { ...(await pageState(run.page)), ...content };
}

async function browserClick(args, signal) {
  ensureArgs(args, ["selector"]);
  const selector = stringArg(args.selector, "selector", 2048);
  const run = currentBrowserRun(signal);
  if (!run.page) throw new Error("No browser page is open; call browser_open first");
  await run.page.locator(selector).first().click({ timeout: 5_000 });
  return pageState(run.page);
}

async function browserFill(args, signal) {
  ensureArgs(args, ["selector", "value"]);
  const selector = stringArg(args.selector, "selector", 2048);
  const value = stringArg(args.value, "value", 4096);
  const run = currentBrowserRun(signal);
  if (!run.page) throw new Error("No browser page is open; call browser_open first");
  await run.page.locator(selector).first().fill(value, { timeout: 5_000 });
  return { filled: true };
}

function mcpServer(settings, serverId) {
  if (!Array.isArray(settings.mcpServers)) throw new Error("No MCP servers are configured");
  const matches = settings.mcpServers.filter(server => server && server.id === serverId);
  if (matches.length !== 1) throw new Error(`MCP server id is not uniquely configured: ${serverId}`);
  const server = matches[0];
  if (typeof server.command !== "string" || !path.isAbsolute(server.command) ||
      typeof server.cwd !== "string" || !path.isAbsolute(server.cwd) ||
      !Array.isArray(server.args) || server.args.some(arg => typeof arg !== "string")) {
    throw new Error(`MCP server "${serverId}" must use an absolute command and working directory with fixed string arguments`);
  }
  const root = approvedRoots(settings).find(item => isWithin(item, path.resolve(server.cwd)));
  if (!root) throw new Error(`MCP server "${serverId}" working directory is outside approved roots`);
  return rejectLinksInPath(path.resolve(server.cwd), root).then(async cwd => {
    if (!(await fsp.stat(cwd)).isDirectory()) throw new Error(`MCP server "${serverId}" working directory is not a directory`);
    return { ...server, cwd };
  });
}

async function execute(name, args, settings = {}, signal) {
  const available = new Set(definitions(settings).map(entry => entry.function.name));
  if (!available.has(name)) throw new Error(`Tool "${name}" is disabled or not configured`);
  if (signal && signal.aborted) throw new Error(`Tool "${name}" cancelled`);
  switch (name) {
    case "file_list": return fileList(args, settings);
    case "file_read": return fileRead(args, settings);
    case "file_search": return fileSearch(args, settings);
    case "file_write": return fileWrite(args, settings);
    case "command_run": return runCommand(args, settings, signal);
    case "browser_open": return browserOpen(args, signal);
    case "browser_snapshot": ensureArgs(args, []); return browserSnapshot(signal);
    case "browser_click": return browserClick(args, signal);
    case "browser_fill": return browserFill(args, signal);
    case "browser_close": {
      ensureArgs(args, []);
      currentBrowserRun(signal);
      const run = browserRuns.get(signal);
      if (run) await closeBrowserRun(run);
      return { closed: true };
    }
    case "mcp_list_tools": {
      ensureArgs(args, ["serverId"]);
      const server = await mcpServer(settings, stringArg(args.serverId, "serverId", 256));
      return agentMcp.listTools(server, signal);
    }
    case "mcp_call_tool": {
      ensureArgs(args, ["serverId", "toolName", "arguments"]);
      const server = await mcpServer(settings, stringArg(args.serverId, "serverId", 256));
      const toolName = stringArg(args.toolName, "toolName", 256);
      if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
        throw new Error("arguments must be an object");
      }
      if (Buffer.byteLength(JSON.stringify(args.arguments), "utf8") > MAX_TOOL_BYTES) throw new Error("MCP arguments exceed the 64-KiB limit");
      return agentMcp.callTool(server, toolName, args.arguments, signal);
    }
    default: throw new Error(`Unknown tool "${name}"`);
  }
}

async function close() {
  const runs = Array.from(browserRunSet);
  const results = await Promise.allSettled([...runs.map(run => closeBrowserRun(run)), agentMcp.close()]);
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new Error(`Unable to close all agent tools: ${errors.map(error => error.message).join("; ")}`);
}

async function closeRun(signal) {
  if (!signal || (typeof signal !== "object" && typeof signal !== "function")) {
    throw new Error("closeRun requires the AbortSignal used for this agent run");
  }
  const run = browserRuns.get(signal);
  const results = await Promise.allSettled([
    run ? closeBrowserRun(run) : Promise.resolve(),
    agentMcp.closeRun(signal)
  ]);
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) {
    throw new Error(`Unable to close agent run resources: ${errors.map(error => error.message).join("; ")}`);
  }
}

module.exports = { definitions, execute, closeRun, close, browserLaunchOptions };
