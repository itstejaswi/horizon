"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const { loadConfig, saveLocalSettings } = require("./config");
const { isLoopbackHost, listenWithFallback } = require("./net");
const { createProvider } = require("./providers");
const runtime = require("./runtime");
const desktop = require("./desktop");
const backup = require("./backup");
const reader = require("./reader");
const { AgentService } = require("./agents");
const agentTools = require("./agent-tools");
const { InferenceQueue } = require("./inference-queue");
const { acquireAgentOwner } = require("./agent-owner");

const CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

const config = loadConfig();
const provider = createProvider(config);
const state = {
  baseUrl: null,
  modelId: null,
  port: null,
  managed: false,
  // Aliases this instance put into memory, so shutdown releases only those and
  // never a model someone else loaded.
  loadedByUs: new Set(),
  statusCache: null,
  statusCacheAt: 0,
  warm: false,
  // Live download progress, keyed by alias, so the page can poll while a
  // multi-gigabyte model comes down.
  downloads: new Map(),
};

const inferenceQueue = new InferenceQueue();
let stopOllamaOnExit = false;
let agents = null;
let agentOwner = null;
function createAgentService() {
  const complete = (body, signal) => inferenceQueue.run(async () => {
    const status = await probeRuntime();
    signal.throwIfAborted();
    if (!status.ready || !state.baseUrl || !state.modelId) {
      throw new Error(status.error || "Load a local model before running a model-driven agent.");
    }
    provider.assertLoopback(state.baseUrl);
    return provider.agentCompletion(state.baseUrl, { ...body, model: state.modelId, stream: false }, signal);
  }, signal);
  return new AgentService({
    directory: config.runtime.directory,
    tools: agentTools,
    complete
  });
}

function agentRequestAllowed(req) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!isLoopbackHost(host.hostname) || Number(host.port || 80) !== req.socket.localPort) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    if (req.headers.origin && req.headers.origin !== host.origin) return false;
    return true;
  } catch {
    return false;
  }
}

async function handleAgents(req, res, urlPath) {
  if (!agentRequestAllowed(req)) return sendJson(res, 403, { error: "Agent controls require a same-origin local connection." });
  if (req.method === "GET" && urlPath === "/api/agents") return sendJson(res, 200, agents.snapshot());
  if (req.method === "GET" && urlPath === "/api/agents/run") {
    try {
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      return sendJson(res, 200, agents.getRun(id));
    } catch (error) {
      return sendJson(res, 404, { error: error.message });
    }
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
  if (req.headers["x-horizon-agent-token"] !== agents.csrfToken) {
    return sendJson(res, 403, { error: "Reload the Agents panel before changing agent controls." });
  }
  if (!(req.headers["content-type"] || "").startsWith("application/json")) {
    return sendJson(res, 415, { error: "Agent controls accept application/json only." });
  }
  try {
    const body = JSON.parse(await readBody(req, 131072));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request must be a JSON object.");
    let result;
    switch (urlPath) {
      case "/api/agents/settings": result = agents.saveSettings(body); break;
      case "/api/agents/save": result = agents.saveAgent(body); break;
      case "/api/agents/delete": result = agents.deleteAgent(body.id); break;
      case "/api/agents/run": result = agents.run(body.agentId, body.prompt); break;
      case "/api/agents/cancel": result = agents.cancel(body.id); break;
      case "/api/agents/cancel-chat": result = agents.cancelConversation(body.id); break;
      case "/api/agents/approve": result = agents.approve(body.id, body.approvalId, body.approve); break;
      case "/api/agents/stop": result = agents.stop(); break;
      case "/api/agents/erase": result = await agents.erase(); break;
      default: return sendJson(res, 404, { error: "Agent operation not found." });
    }
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }
}

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
    ...extra
  };
}

function sendJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length
  }));
  res.end(data);
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const target = path.resolve(config.publicDir, relative);

  // Path traversal guard: the resolved file must stay inside public/.
  if (target !== config.publicDir && !target.startsWith(config.publicDir + path.sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, securityHeaders({
      "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length
    }));
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return sendJson(res, 404, { error: `Not found: ${urlPath}` });
    }
    sendJson(res, 500, { error: `Could not read ${relative}: ${error.message}` });
  }
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        const error = new Error(`Request body exceeded ${limitBytes} bytes.`);
        error.statusCode = 413;
        req.pause();
        return reject(error);
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Refresh the model binding after the service or installed models change.
async function rediscoverRuntime() {
  const endpoint = await provider.discoverEndpoint(10000);
  if (!endpoint) return false;

  const candidate = (endpoint.endsWith("/v1") ? endpoint : endpoint + "/v1").replace(/\/+$/, "");
  try {
    provider.assertLoopback(candidate);
    const modelId = await provider.resolveModelId(candidate, config.model.alias, config.inference.statusTimeoutMs);
    state.baseUrl = candidate;
    state.modelId = modelId;
    state.warm = false;
    state.statusCache = null;

    runtime.writeState(config, {
      url: `http://${config.web.host}:${state.port}`,
      host: config.web.host,
      port: state.port,
      endpoint: candidate,
      modelId,
      modelAlias: config.model.alias
    });

    console.log(`  ${provider.label} moved to ${candidate}. Reconnected automatically.`);
    return true;
  } catch {
    return false;
  }
}

function providerInfo() {
  return {
    name: provider.name,
    label: provider.label,
    docs: provider.docsUrl,
    loadsOnDemand: Boolean(provider.loadsOnDemand)
  };
}

async function probeRuntime() {
  const now = Date.now();
  if (state.statusCache && now - state.statusCacheAt < config.inference.statusCacheMs) return state.statusCache;

  // Not attached yet: try once, so the page recovers on its own once the
  // service is started from the Ollama panel or the command line.
  if (!state.baseUrl || !state.modelId) {
    await attachRuntime();
    if (!state.baseUrl) {
      const result = {
        ready: false,
        model: null,
        alias: config.model.alias,
        endpoint: null,
        needsRuntime: true,
        error: `${provider.label} is not running. Open the ${provider.label} panel to start it.`
      };
      state.statusCache = result;
      state.statusCacheAt = now;
      return result;
    }
  }

  let result;
  try {
    const models = await provider.listModels(state.baseUrl, config.inference.statusTimeoutMs);
    const loaded = Boolean(state.modelId && models.some(model => model.id === state.modelId));

    result = loaded
      ? { ready: true, model: state.modelId, alias: config.model.alias, endpoint: state.baseUrl }
      : {
          ready: false,
          model: state.modelId,
          alias: config.model.alias,
          endpoint: state.baseUrl,
          needsLoad: true,
          error: `"${config.model.alias}" is not installed in ${provider.label}. Download it from the model picker.`
        };
  } catch (error) {
    // The service may simply have restarted on a different port.
    if (await rediscoverRuntime()) {
      try {
        const loaded = (await provider.listModels(state.baseUrl, config.inference.statusTimeoutMs)).some(m => m.id === state.modelId);
        if (loaded) {
          result = { ready: true, model: state.modelId, alias: config.model.alias, endpoint: state.baseUrl, reconnected: true };
          state.statusCache = result;
          state.statusCacheAt = Date.now();
          return result;
        }
      } catch { /* fall through to the error below */ }
    }
    result = {
      ready: false,
      model: state.modelId,
      alias: config.model.alias,
      endpoint: state.baseUrl,
      error: `${error.message} Try running: ${provider.restartHint}`
    };
  }

  state.statusCache = result;
  state.statusCacheAt = now;
  return result;
}

function sanitizeMessages(input) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const system = messages.filter(m => m?.role === "system" && typeof m.content === "string").slice(0, 1);
  const turns = messages
    .filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-config.chat.historyLimit);
  const truncated = turns.length < messages.filter(m => ["user", "assistant"].includes(m?.role)).length;

  const systemContent = system.length ? system[0].content : config.chat.systemPrompt;
  const clean = [{ role: "system", content: systemContent.slice(0, config.chat.maxMessageChars) }]
    .concat(turns.map(m => ({ role: m.role, content: m.content.slice(0, config.chat.maxMessageChars) })));

  return { clean, truncated };
}

function startSse(res) {
  res.writeHead(200, securityHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  }));
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamChat(req, res, body, truncated) {
  const controller = new AbortController();
  let idleTimer = null;
  let closed = false;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), config.inference.requestTimeoutMs);
  };

  // If the browser navigates away or the user stops generation, drop the
  // upstream request instead of letting the model run on unattended.
  req.on("close", () => {
    closed = true;
    clearTimeout(idleTimer);
    controller.abort();
  });

  let response;
  try {
    resetIdleTimer();
    response = await provider.chatCompletionStream(state.baseUrl, body, controller.signal);
  } catch (error) {
    clearTimeout(idleTimer);
    state.statusCache = null;
    if (closed) return;
    return sendJson(res, error.statusCode || 504, {
      error: error.name === "AbortError"
        // Said as a limit rather than a fault, because that is what it is. A
        // long page and a large model can genuinely take longer than this, and
        // the remedy is in the user's hands.
        ? `The model did not finish within ${Math.round(config.inference.requestTimeoutMs / 1000)} seconds. A long page or a large model can need more; try a shorter question, or raise inference.requestTimeoutMs in config.local.json.`
        : error.message
    });
  }

  startSse(res);
  let usage = null;
  let model = state.modelId;
  let produced = false;
  let finishReason = null;

  try {
    for await (const event of provider.parseServerSentEvents(response)) {
      resetIdleTimer();
      if (event.model) model = event.model;
      if (event.usage) usage = event.usage;
      if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason;
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        produced = true;
        sendSse(res, { delta });
      }
    }
    clearTimeout(idleTimer);
    if (closed) return;
    if (!produced) {
      sendSse(res, { error: `${provider.label} produced an empty reply.` });
      return res.end();
    }
    sendSse(res, { done: true, usage, model, temperature: body.temperature, truncated, finishReason });
    res.end();
  } catch (error) {
    clearTimeout(idleTimer);
    state.statusCache = null;
    if (closed) return;
    sendSse(res, {
      error: error.name === "AbortError"
        ? "The reply stopped early because the model went quiet."
        : `The reply was interrupted: ${error.message}`
    });
    res.end();
  }
}

async function handleChat(req, res) {
  // Validate the request before touching Ollama, so a malformed body reports
  // 400 rather than a misleading service error.
  let raw;
  try {
    raw = await readBody(req, config.chat.maxRequestBytes);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: error.statusCode === 413
        ? `Your message is too large. The limit is ${config.chat.maxRequestBytes} bytes; start a new conversation or shorten the text.`
        : `Could not read the request: ${error.message}`
    });
  }

  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "The request body was not valid JSON." });
  }

  const { clean, truncated } = sanitizeMessages(input);
  if (clean.length < 2 || clean[clean.length - 1].role !== "user") {
    return sendJson(res, 400, { error: "A user message is required." });
  }

  if (agents.conversationEnabled()) {
    if (!agentRequestAllowed(req) || req.headers["x-horizon-agent-token"] !== agents.csrfToken) {
      return sendJson(res, 403, { error: "Reload Horizon to authorise conversation tools on this local page." });
    }
    if (!(req.headers["content-type"] || "").startsWith("application/json")) {
      return sendJson(res, 415, { error: "Tool-enabled conversations accept application/json only." });
    }
    try {
      const run = agents.chat(clean, input.clientRunId, input.conversationId, input.approvalPreferences);
      return sendJson(res, 200, { run, truncated, model: state.modelId || config.model.alias });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  // Ollama loads installed models on demand.
  if (!state.baseUrl || !state.modelId) {
    await attachRuntime({ load: true });
    if (!state.baseUrl || !state.modelId) {
      return sendJson(res, 503, {
        error: `No model is ready yet. Open the ${provider.label} panel to start the service and load a model.`
      });
    }
  } else if (state.managed) {
    const loaded = await provider.isModelLoaded(config.model.alias).catch(() => null);
    if (loaded === false) {
      try {
        const didLoad = await provider.ensureLoaded(config.model.alias);
        if (didLoad) state.loadedByUs.add(config.model.alias);
        state.statusCache = null;
      } catch (error) {
        return sendJson(res, 503, { error: `Could not load "${config.model.alias}": ${error.message}` });
      }
    }
  }

  const temperature = Number.isFinite(Number(input.temperature))
    ? Math.min(Math.max(Number(input.temperature), 0), 2)
    : config.chat.temperature;

  const body = { model: state.modelId, messages: clean, temperature };
  const wantsStream = input.stream === undefined ? config.chat.stream : Boolean(input.stream);
  if (wantsStream) return streamChat(req, res, body, truncated);

  try {
    const result = await provider.chatCompletion(state.baseUrl, { ...body, stream: false }, config.inference.requestTimeoutMs);

    if (!result.ok) {
      state.statusCache = null;
      return sendJson(res, result.status, {
        error: result.payload?.error?.message || `${provider.label} returned HTTP ${result.status}.`
      });
    }

    const reply = result.payload?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return sendJson(res, 502, { error: `${provider.label} returned no assistant message.` });
    }

    return sendJson(res, 200, {
      reply,
      usage: result.payload.usage || null,
      model: result.payload.model || state.modelId,
      temperature,
      truncated
    });
  } catch (error) {
    state.statusCache = null;
    return sendJson(res, 504, { error: error.message });
  }
}

/* ------------------------------------------------------------ diagnostics -- */

// Reports the health of each hop separately so a failure points at the link
// that broke rather than just saying "something went wrong".
async function diagnostics() {
  const hops = [];

  hops.push({
    id: "server",
    label: "Local web server",
    state: "ok",
    detail: `${config.web.host}:${state.port}`,
    note: "Loopback only.",
    loopback: true
  });

  const runtimeHop = {
    id: "runtime",
    label: `${provider.label} service`,
    state: "unknown",
    detail: state.baseUrl || "not running",
    note: "Hosts the model.",
    loopback: true
  };
  const modelHop = {
    id: "model",
    label: "Model",
    state: "unknown",
    detail: state.modelId || "none loaded",
    note: "Runs on your processor.",
    loopback: true
  };

  if (!state.baseUrl) {
    runtimeHop.state = "error";
    runtimeHop.note = "Stopped. Start it above.";
    modelHop.note = "Needs the service running.";
    hops.push(runtimeHop, modelHop);
    return { hops, allLoopback: true, endpoint: null, uptimeSeconds: Math.round(process.uptime()) };
  }

  const started = Date.now();
  try {
    const models = await provider.listModels(state.baseUrl, config.inference.statusTimeoutMs);
    runtimeHop.state = "ok";
    runtimeHop.latencyMs = Date.now() - started;

    if (models.some(m => m.id === state.modelId)) {
      modelHop.state = "ok";
      modelHop.detail = state.modelId;
      modelHop.note = state.warm ? "Loaded and warm." : "Installed; loads on demand.";
    } else {
      modelHop.state = "error";
      modelHop.note = `Not loaded. Run: ${provider.loadHint(config.model.alias)}`;
    }
  } catch (error) {
    runtimeHop.state = "error";
    runtimeHop.note = error.message;
    modelHop.state = "unknown";
    modelHop.note = "Needs the service running.";
  }

  hops.push(runtimeHop, modelHop);

  return {
    hops,
    // Every hop is verified loopback at startup and refuses to be otherwise,
    // so this is an assertion the server can make honestly.
    allLoopback: hops.every(hop => hop.loopback),
    endpoint: state.baseUrl,
    uptimeSeconds: Math.round(process.uptime())
  };
}

/* ---------------------------------------------------------- agent control -- */

async function listAgentModels() {
  const models = await provider.cachedModels();
  return {
    active: state.modelId,
    activeAlias: config.model.alias,
    models: models.filter(model => model.type === "Chat" || model.type === "Multimodal")
  };
}

// Switching model at run time avoids a restart. The provider validates model
// names before they reach its command or HTTP API.
async function activateModel(alias) {
  if (!provider.isSafeAlias(alias)) throw new Error(`That model name is not allowed: ${alias}`);
  if (!state.baseUrl) throw new Error(`${provider.label} is not running. Start it from the ${provider.label} panel first.`);

  const available = await provider.cachedModels();
  if (!available.some(model => model.alias === alias)) {
    throw new Error(`"${alias}" is not downloaded on this machine.`);
  }

  await provider.loadModel(alias);
  state.loadedByUs.add(alias);
  const modelId = await provider.resolveModelId(state.baseUrl, alias, config.inference.statusTimeoutMs);

  state.modelId = modelId;
  config.model.alias = alias;
  state.statusCache = null;
  state.warm = false;

  runtime.writeState(config, {
    url: `http://${config.web.host}:${state.port}`,
    host: config.web.host,
    port: state.port,
    endpoint: state.baseUrl,
    modelId,
    modelAlias: alias
  });

  warmUp();
  return { active: modelId, activeAlias: alias };
}

/* ------------------------------------------------------- inference control -- */

async function attachRuntime({ load = false } = {}) {
  const resolved = await resolveRuntime();
  state.baseUrl = resolved.baseUrl;
  state.modelId = resolved.modelId;
  state.managed = resolved.managed;
  state.statusCache = null;
  state.warm = false;

  if (load && state.managed && state.baseUrl && config.model.alias) {
    try {
      const didLoad = await provider.ensureLoaded(config.model.alias);
      if (didLoad) state.loadedByUs.add(config.model.alias);
      state.modelId = await provider.resolveModelId(state.baseUrl, config.model.alias, config.inference.statusTimeoutMs);
    } catch (error) {
      resolved.reason = error.message;
      state.modelId = null;
      console.error(`  Could not prepare the model: ${error.message}`);
    }
  }

  if (state.port) {
    runtime.writeState(config, {
      url: `http://${config.web.host}:${state.port}`,
      host: config.web.host,
      port: state.port,
      endpoint: state.baseUrl,
      modelId: state.modelId,
      modelAlias: config.model.alias
    });
  }

  if (state.modelId && config.inference.warmUpOnStart) warmUp();
  return resolved;
}

async function runtimeState() {
  const install = await provider.isInstalled();
  if (!install.installed) {
    return {
      installed: false,
      running: false,
      provider: providerInfo(),
      message: `${provider.label} is not installed, or is not on this account's PATH.`,
      docs: provider.docsUrl
    };
  }

  const status = await provider.serverStatus();
  const running = Boolean(status?.running);

  // The question people actually have is "what is this costing me?". A loaded
  // model is gigabytes of RAM and gigabytes on disk, and neither is visible
  // anywhere else without opening a terminal.
  const [resources, cache] = await Promise.all([
    measureResources(status?.pid),
    measureCache()
  ]);

  return {
    installed: true,
    version: install.version,
    running,
    serviceOwned: provider.ownsService(),
    state: status?.state || null,
    pid: status?.pid || null,
    uptime: status?.uptime || null,
    startedAt: status?.startedAt || null,
    logFile: status?.logFile || null,
    endpoints: status?.webUrls || [],
    endpoint: state.baseUrl,
    modelId: state.modelId,
    modelAlias: config.model.alias,
    // Which models this Horizon put into memory, so shutdown can be honest
    // about what it will and will not release.
    loadedByUs: [...state.loadedByUs],
    resources,
    cache,
    host: {
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model?.trim() || null,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      node: process.version
    },
    horizon: {
      pid: process.pid,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
      port: state.port,
      managed: state.managed
    },
    provider: providerInfo(),
    docs: provider.docsUrl
  };
}

// The daemon's own memory. This is the number that answers "why is my machine
// using 10 GB?" -- Horizon itself is a rounding error next to a loaded model.
async function measureResources(pid) {
  if (!pid) return null;
  try {
    const result = await provider.processMemory(pid);
    return result ? { daemonMemoryMb: result } : null;
  } catch {
    return null;
  }
}

// How much disk the downloaded models occupy, and where.
async function measureCache() {
  try {
    const [models, settings] = await Promise.all([
      provider.cachedModels().catch(() => []),
      provider.settings().catch(() => [])
    ]);

    const cached = models.filter(model => model.cached !== false);
    const directory = settings.find(item => item.key === "cache-directory")?.value || null;

    return {
      directory,
      modelCount: cached.length,
      loadedCount: cached.filter(model => model.loaded).length,
      totalMb: cached.reduce((sum, model) => sum + (model.sizeMb || 0), 0)
    };
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/api/agents" || urlPath.startsWith("/api/agents/")) {
    return handleAgents(req, res, urlPath)
      .catch(error => sendJson(res, 500, { error: error.message }));
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (urlPath === "/api/chat-tools") {
      if (!agentRequestAllowed(req)) return sendJson(res, 403, { error: "Conversation tools require a same-origin local connection." });
      return sendJson(res, 200, { enabled: agents.conversationEnabled(), csrfToken: agents.csrfToken });
    }
    if (urlPath === "/api/status") return probeRuntime().then(value => sendJson(res, 200, {
      ...value, provider: providerInfo(), conversationTools: agents.conversationEnabled(),
      privacy: { ...agents.privacy(), readerEnabled: config.reader.enabled }
    })).catch(error => sendJson(res, 503, { ready: false, error: error.message, provider: providerInfo() }));
    if (urlPath === "/api/diagnostics") {
      return diagnostics()
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/models") {
      return listAgentModels()
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/ollama") {
      return runtimeState()
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/ollama/settings") {
      return provider.settings()
        .then(items => sendJson(res, 200, { settings: items }))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/setup") {
      return desktop.status()
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/reader") {
      return sendJson(res, 200, {
        enabled: Boolean(config.reader.enabled),
        maxChars: config.reader.maxChars
      });
    }
    if (urlPath === "/api/backup") {
      return backup.status(config)
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/backup/data") {
      // Reading the saved copy back, so the page can restore itself.
      return backup.read(config)
        .then(record => sendJson(res, 200, record))
        .catch(error => sendJson(res, 404, { error: error.message }));
    }
    if (urlPath === "/api/ollama/progress") {
      const downloads = {};
      for (const [alias, entry] of state.downloads) {
        downloads[alias] = { ...entry, elapsedMs: Date.now() - entry.startedAt };
      }
      return sendJson(res, 200, { downloads });
    }
    if (urlPath === "/api/ollama/catalogue") {
      const query = new URL(req.url, "http://localhost").searchParams;
      return provider.catalogue({
        device: query.get("device"),
        type: query.get("type"),
        search: query.get("search"),
        cached: query.get("cached") === "1"
      })
        .then(models => sendJson(res, 200, { models, activeAlias: config.model.alias }))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/config") {
      return sendJson(res, 200, {
        app: config.app,
        alias: config.model.alias,
        endpoint: state.baseUrl,
        defaults: {
          systemPrompt: config.chat.systemPrompt,
          temperature: config.chat.temperature,
          historyLimit: config.chat.historyLimit,
          stream: config.chat.stream
        },
        // The page needs these to tell the user what will actually be sent.
        // Silently truncating an attached file would be worse than refusing it.
        limits: {
          maxMessageChars: config.chat.maxMessageChars,
          maxRequestBytes: config.chat.maxRequestBytes
        }
      });
    }
    return serveStatic(res, urlPath);
  }

  if (req.method === "POST") {
    if (urlPath === "/api/chat") {
      const controller = new AbortController();
      res.on("close", () => controller.abort(new Error("Chat connection closed.")));
      return inferenceQueue.run(() => handleChat(req, res), controller.signal)
        .catch(error => {
          if (!res.destroyed && !res.writableEnded) sendJson(res, 503, { error: error.message });
        });
    }

    if (urlPath === "/api/shutdown") {
      if (!agentRequestAllowed(req)) return sendJson(res, 403, { error: "Shutdown requires a same-origin local connection." });
      return readBody(req, 1024)
        .then(raw => {
          const options = raw ? JSON.parse(raw) : {};
          stopOllamaOnExit = options.stopService === true;
          if (stopOllamaOnExit && !provider.ownsService()) {
            stopOllamaOnExit = false;
            return sendJson(res, 409, { error: "Ollama was not started by Horizon. Exit without stopping its service, or use its own service manager." });
          }
          sendJson(res, 200, { stopping: true, stopService: stopOllamaOnExit });
          setTimeout(() => shutdown("Exit request"), 150);
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/ollama/settings") {
      return readBody(req, 2048)
        .then(async raw => {
          const { key, value } = JSON.parse(raw || "{}");
          await provider.setSetting(key, value);
          return sendJson(res, 200, { settings: await provider.settings() });
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/setup") {
      return readBody(req, 1024)
        .then(async raw => {
          const body = JSON.parse(raw || "{}");
          return sendJson(res, 200, await desktop.apply({
            startAtLogon: body.startAtLogon,
            desktopShortcut: body.desktopShortcut
          }));
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/reader") {
      // Two jobs: switching the capability on or off, and doing the fetching.
      return readBody(req, 2048)
        .then(async raw => {
          const body = JSON.parse(raw || "{}");

          if (typeof body.enabled === "boolean") {
            saveLocalSettings({ reader: { enabled: body.enabled } });
            config.reader.enabled = body.enabled;
            return sendJson(res, 200, {
              enabled: config.reader.enabled,
              maxChars: config.reader.maxChars
            });
          }

          if (!config.reader.enabled) {
            return sendJson(res, 409, { error: "Reading links is switched off." });
          }
          if (!body.url) {
            return sendJson(res, 400, { error: "No address was given." });
          }

          const started = Date.now();
          const page = await reader.fetchPage(body.url, config.reader.maxChars);
          // Logged, because this is the one thing Horizon does that leaves
          // this machine and it should be visible.
          console.log(`  Read ${page.url} (${page.characters} chars, ${Date.now() - started}ms)`);
          return sendJson(res, 200, page);
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/backup") {
      // Turning the copy on or off, and choosing where it lives. The choice is
      // written to config.local.json so it survives a restart.
      return readBody(req, 4096)
        .then(async raw => {
          const body = JSON.parse(raw || "{}");
          const patch = { backup: {} };

          if (typeof body.enabled === "boolean") patch.backup.enabled = body.enabled;
          if (typeof body.directory === "string" && body.directory.trim()) {
            patch.backup.directory = body.directory.trim();
          }

          saveLocalSettings(patch);
          Object.assign(config.backup, patch.backup);

          // Switching off leaves the file alone unless asked; deleting someone's
          // only copy of their conversations should never be a side effect.
          if (body.enabled === false && body.deleteFile === true) {
            return sendJson(res, 200, await backup.remove(config));
          }
          return sendJson(res, 200, await backup.status(config));
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/backup/data") {
      // The page sends its whole store; the server only writes it down.
      return readBody(req, config.chat.maxRequestBytes)
        .then(async raw => {
          if (!config.backup.enabled) {
            return sendJson(res, 409, { error: "Saving to disk is switched off." });
          }
          const body = JSON.parse(raw || "{}");
          return sendJson(res, 200, await backup.write(config, body.data));
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/ollama/download" || urlPath === "/api/ollama/remove") {
      const removing = urlPath.endsWith("remove");
      return readBody(req, 4096)
        .then(async raw => {
          const alias = JSON.parse(raw || "{}").alias;

          if (removing) {
            if (alias === config.model.alias) {
              return sendJson(res, 400, { error: "That model is in use. Switch to another one first." });
            }
            await provider.removeModel(alias);
            state.loadedByUs.delete(alias);
          } else {
            // Progress is recorded as it arrives so the page can poll for it.
            // A multi-gigabyte download otherwise looks identical to a hang.
            state.downloads.set(alias, { percent: 0, sizeMb: null, startedAt: Date.now() });
            try {
              await provider.downloadModel(alias, progress => {
                const entry = state.downloads.get(alias);
                if (entry) Object.assign(entry, { percent: progress.percent, sizeMb: progress.sizeMb });
              });
            } catch (error) {
              state.downloads.delete(alias);
              throw error;
            }
            state.downloads.delete(alias);
          }

          return sendJson(res, 200, { alias, models: await provider.catalogue({}) });
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/ollama/start" || urlPath === "/api/ollama/stop" || urlPath === "/api/ollama/restart") {
      const action = urlPath.split("/").pop();
      const run = action === "start" ? provider.startServer
        : action === "stop" ? provider.stopServer
        : provider.restartServer;

      return run()
        .then(async () => {
          if (action === "stop") {
            state.baseUrl = null;
            state.modelId = null;
            state.statusCache = null;
          } else {
            await attachRuntime({ load: true });
          }
          return sendJson(res, 200, await runtimeState());
        })
        .catch(error => sendJson(res, 500, { error: error.message }));
    }

    if (urlPath === "/api/models/activate" || urlPath === "/api/models/unload") {
      return readBody(req, 4096)
        .then(async raw => {
          const alias = JSON.parse(raw || "{}").alias;
          if (urlPath.endsWith("unload")) {
            if (alias === config.model.alias) {
              return sendJson(res, 400, { error: "That model is in use. Switch to another one first." });
            }
            await provider.unloadModel(alias);
            state.loadedByUs.delete(alias);
            return sendJson(res, 200, await listAgentModels());
          }
          await activateModel(alias);
          const refreshed = await listAgentModels();
          return sendJson(res, 200, refreshed);
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }
  }

  sendJson(res, 404, { error: `Not found: ${req.method} ${urlPath}` });
});

function openInBrowser(url) {
  const command = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(command, () => { /* opening a browser is a convenience, never fatal */ });
}

function fail(message) {
  console.error(`\n${config.app.displayName} could not start.\n\n${message}\n`);
  process.exit(1);
}

async function findExistingInstance() {
  if (config.web.allowMultipleInstances) return null;
  try {
    return await runtime.findRunningInstance(config);
  } catch {
    // A guard that cannot answer must not block startup.
    return null;
  }
}

// The interface stays available when Ollama or the selected model is absent.
async function resolveRuntime() {
  const managed = true;
  const endpoint = await provider.discoverEndpoint();
  if (!endpoint) return { baseUrl: null, modelId: null, managed, reason: `${provider.label} is not running.` };
  const baseUrl = (endpoint.endsWith("/v1") ? endpoint : endpoint + "/v1").replace(/\/+$/, "");
  try {
    provider.assertLoopback(baseUrl);
  } catch (error) {
    fail(`${error.message}\n\nThis application is loopback-only by design and will not contact a remote endpoint.`);
  }

  let modelId = config.model.id;
  if (!modelId) {
    try {
      modelId = await provider.resolveModelId(baseUrl, config.model.alias, config.inference.statusTimeoutMs);
    } catch (error) {
      return { baseUrl, modelId: null, managed, reason: error.message };
    }
  }

  return { baseUrl, modelId, managed, reason: null };
}

// The first completion after a model loads pays a one-off cost. Doing it here
// means the user's first real message is not the one that waits for it.
async function warmUp() {
  try {
    const result = await inferenceQueue.run(() => provider.chatCompletion(state.baseUrl, {
      model: state.modelId,
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      max_tokens: 1
    }, config.inference.warmUpTimeoutMs));
    if (!result.ok) throw new Error(result.payload?.error?.message || `HTTP ${result.status}`);
    state.warm = true;
  } catch (error) {
    console.error(`  Model warm-up failed: ${error.message}`);
  }
}

async function main() {
  if (!fs.existsSync(path.join(config.publicDir, "index.html"))) {
    fail(`The interface file is missing:\n  ${path.join(config.publicDir, "index.html")}`);
  }

  // Checked before anything else starts: resolving Ollama or binding a port
  // first would mean a second launch had already done work, and writing the
  // state file would point the Stop script at the wrong process.
  const running = await findExistingInstance();
  if (running) {
    console.log(`\n  ${config.app.displayName} is already running.`);
    console.log(`  Open:    ${running.url}`);
    console.log(`\n  Opening that window instead of starting a second one.\n`);
    if (config.web.openBrowser) openInBrowser(running.url);
    process.exit(0);
  }

  agentOwner = await acquireAgentOwner(config.runtime.directory);
  agentOwner.on("error", error => {
    console.error(`Agent ownership failed: ${error.message}`);
    shutdown("Agent ownership lost");
  });
  agents = createAgentService();

  // Ollama is normally left running in the background. If it is not, starting it
  // here saves a trip to the panel; failure is reported without hiding the UI.
  if (config.ollama.autoStart && !config.ollama.baseUrl) {
    await provider.startServer(20000).catch(error => console.error(`  Ollama was not started: ${error.message}`));
  }

  const resolved = await resolveRuntime();
  state.baseUrl = resolved.baseUrl;
  state.modelId = resolved.modelId;
  state.managed = resolved.managed;

  if (!isLoopbackHost(config.web.host)) {
    fail(`Refusing to bind to a non-loopback address: ${config.web.host}\n\nThis application is intended for local use only.`);
  }

  let bound;
  try {
    bound = await listenWithFallback(server, config.web);
  } catch (error) {
    fail(error.message);
  }

  const url = `http://${bound.host}:${bound.port}`;
  state.port = bound.port;
  const stateFile = runtime.writeState(config, {
    url,
    host: bound.host,
    port: bound.port,
    endpoint: state.baseUrl,
    modelId: state.modelId,
    modelAlias: config.model.alias
  });

  console.log(`\n  ${config.app.displayName} is ready`);
  console.log(`  Open:    ${url}`);
  if (bound.reassigned) console.log(`  Note:    port ${config.web.port} was busy, so ${bound.port} was used instead`);

  if (state.modelId) {
    console.log(`  Model:   ${state.modelId}  (alias: ${config.model.alias})`);
    console.log(`  ${provider.label}: ${state.baseUrl}`);
  } else {
    console.log(`  Model:   not ready - ${resolved.reason}`);
    console.log(`  ${provider.label}: ${state.baseUrl || "not running"}`);
    console.log(`\n  Open the page and use the ${provider.label} panel to start it.`);
  }
  console.log(`  State:   ${stateFile}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  agents.start();

  if (config.web.openBrowser) openInBrowser(url);

  if (config.inference.warmUpOnStart && state.modelId) {
    warmUp().then(() => {
      if (state.warm) console.log("  The model is warmed up and ready for a fast first reply.\n");
    });
  }
}

/* ---------------------------------------------------------------- shutdown -- */

// Only models explicitly loaded by this instance are released on exit.
async function releaseResources() {
  if (!state.managed) return;

  if (state.loadedByUs.size) {
    for (const alias of state.loadedByUs) {
      try {
        process.stdout.write(`  Releasing ${alias} from memory... `);
        await provider.unloadModel(alias, 30000);
        console.log("done");
      } catch {
        console.log(`could not unload; it will be released when ${provider.label} stops`);
      }
    }
  }

  if (stopOllamaOnExit) {
    try {
      process.stdout.write(`  Stopping the ${provider.label} service... `);
      await provider.stopServer(30000);
      console.log("done");
    } catch {
      console.log("could not stop it");
    }
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Shutting down...`);

  // A hard cap, so an unresponsive service can never leave the process hanging.
  const guard = setTimeout(() => {
    console.log("  Shutdown took too long; exiting anyway.");
    process.exit(0);
  }, 45000);
  guard.unref();

  server.close();
  try {
    if (agents) await agents.close();
  } catch (error) {
    console.error(`  Agent cleanup failed: ${error.message}`);
  }
  try {
    await releaseResources();
  } catch { /* never block exit on cleanup */ }

  runtime.clearState(config);
  if (agentOwner) agentOwner.close();
  clearTimeout(guard);
  console.log("  Goodbye.\n");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("unhandledRejection", error => fail(`Unexpected error: ${error?.message || error}`));

main().catch(error => fail(error?.message || String(error)));
