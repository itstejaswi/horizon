"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const { loadConfig, saveLocalSettings } = require("./config");
const { isLoopbackHost, listenWithFallback } = require("./net");
const foundry = require("./foundry");
const runtime = require("./runtime");
const desktop = require("./desktop");
const backup = require("./backup");
const reader = require("./reader");
const dictation = require("./dictation");
const { foundryIcon } = require("./brand");

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
  // The dictation session and the pages listening to it. One session at a time:
  // there is only one microphone.
  dictation: { session: null, listeners: new Set(), recovering: false, recovered: false }
};

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

// Foundry picks a new port each time it restarts. If it becomes unreachable
// mid-session, re-discover the endpoint rather than making the user restart.
async function rediscoverFoundry() {
  const endpoint = await foundry.discoverEndpoint(10000);
  if (!endpoint) return false;

  const candidate = (endpoint.endsWith(config.foundry.apiPrefix) ? endpoint : endpoint + config.foundry.apiPrefix)
    .replace(/\/+$/, "");
  if (candidate === state.baseUrl) return false;

  try {
    foundry.assertLoopback(candidate);
    const modelId = await foundry.resolveModelId(candidate, config.model.alias, config.foundry.statusTimeoutMs);
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

    console.log(`  Foundry moved to ${candidate}. Reconnected automatically.`);
    return true;
  } catch {
    return false;
  }
}

async function probeFoundry() {
  const now = Date.now();
  if (state.statusCache && now - state.statusCacheAt < config.foundry.statusCacheMs) return state.statusCache;

  // Not attached yet: try once, so the page recovers on its own once the
  // service is started from the Foundry panel or the command line.
  if (!state.baseUrl) {
    await attachFoundry();
    if (!state.baseUrl) {
      const result = {
        ready: false,
        model: null,
        alias: config.model.alias,
        endpoint: null,
        needsFoundry: true,
        error: "Foundry Local is not running. Open the Foundry panel to start it."
      };
      state.statusCache = result;
      state.statusCacheAt = now;
      return result;
    }
  }

  let result;
  try {
    // /v1/models lists everything cached, loaded or not, so readiness comes
    // from the CLI's loaded flag when this is an instance we manage. For an
    // endpoint supplied explicitly, presence in /v1/models is all we have.
    const loaded = state.managed
      ? await foundry.isModelLoaded(config.model.alias)
      : (await foundry.listModels(state.baseUrl, config.foundry.statusTimeoutMs)).some(m => m.id === state.modelId);

    // The CLI talks to the daemon directly, so it answers correctly even when
    // the daemon has restarted on a new port and our endpoint has gone stale.
    // That combination reported ready:true against a dead address, which is
    // worse than reporting a failure. So when the CLI says a model is loaded,
    // the endpoint we hold is checked rather than assumed.
    if (loaded && state.managed && !(await foundry.endpointAlive(state.baseUrl, config.foundry.statusTimeoutMs))) {
      await rediscoverFoundry();
    }

    result = loaded
      ? { ready: true, model: state.modelId, alias: config.model.alias, endpoint: state.baseUrl }
      : {
          ready: false,
          model: state.modelId,
          alias: config.model.alias,
          endpoint: state.baseUrl,
          needsLoad: true,
          error: `"${config.model.alias}" is downloaded but not in memory. Choose it in the model picker to load it.`
        };
  } catch (error) {
    // The service may simply have restarted on a different port.
    if (await rediscoverFoundry()) {
      try {
        const loaded = state.managed
          ? await foundry.isModelLoaded(config.model.alias)
          : (await foundry.listModels(state.baseUrl, config.foundry.statusTimeoutMs)).some(m => m.id === state.modelId);
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
      error: `${error.message} Try running: foundry server restart`
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

/* ---------------------------------------------------------------- dictation -- */

function dictationBroadcast(payload) {
  for (const listener of state.dictation.listeners) {
    try {
      sendSse(listener, payload);
    } catch {
      // The page went away mid-write; the close handler removes it.
    }
  }
}

// Whether dictation can run at all, and why not when it cannot. The page asks
// this before offering a button, so the answer has to be honest rather than
// optimistic.
function dictationStatus() {
  const capability = dictation.capability();
  const session = state.dictation.session;
  return {
    enabled: Boolean(config.dictation.enabled),
    available: capability.available,
    reason: capability.reason,
    alias: config.dictation.alias,
    maxRecordingMs: config.dictation.maxRecordingMs,
    idleTimeoutMs: config.dictation.idleTimeoutMs,
    // The browser plays no part in recording: the Foundry CLI opens the
    // microphone itself. There is therefore no permission prompt and no
    // recording indicator in the tab, so the page has to supply its own.
    browserCapturesAudio: false,
    // Loading a speech model takes long enough that the page has to say so.
    // Without this the only way to find out was to press record and wait,
    // which looked indistinguishable from nothing happening at all.
    modelState: !session ? "idle" : (session.ready ? "ready" : "loading"),
    state: session ? session.state : { ready: false, recording: false, committed: [], active: "", elapsedMs: 0 }
  };
}

// A session is torn down when the last page goes away, and the CLI takes a few
// seconds to stop, exit, and let the daemon release the audio stream. A browser
// refresh reconnects in about a second, so the new page would otherwise ask for
// a session while the old one is still dying, and be told a stream is already
// active — an error about an implementation detail, caused by nothing the user
// did. Anything that wants a session waits for the teardown to finish instead.
let dictationTeardown = null;

async function dictationSessionAsync() {
  if (dictationTeardown) {
    try {
      await dictationTeardown;
    } catch {
      // Teardown failing is not a reason to refuse a new session.
    }
  }
  return dictationSession();
}

function dictationSession() {
  if (state.dictation.session) return state.dictation.session;

  const session = new dictation.DictationSession({
    alias: config.dictation.alias,
    maxRecordingMs: config.dictation.maxRecordingMs,
    idleTimeoutMs: config.dictation.idleTimeoutMs  });

  session.on("ready", () => dictationBroadcast({ type: "ready" }));
  session.on("recording", () => dictationBroadcast({ type: "recording" }));
  session.on("text", payload => dictationBroadcast({ type: "text", ...payload }));
  session.on("stopped", payload => dictationBroadcast({ type: "stopped", ...payload }));
  session.on("error", payload => {
    const stranded = /streaming session|holding a recording session/i.test(payload.message || "");
    // Clearing a stranded stream and starting again is something Horizon can
    // do on its own. It is attempted ONCE: if the stream is still held after
    // that, retrying cannot help, and a loop would spawn a session every few
    // seconds for as long as the page is left open.
    if (stranded && !state.dictation.recovering && !state.dictation.recovered) {
      state.dictation.recovering = true;
      state.dictation.recovered = true;
      const wanted = Boolean(session.wantedRecording);
      dictationBroadcast({ type: "error", message: "Restarting Foundry to clear a recording session left open earlier. This takes a moment." });
      // The stream is held until the CLI has actually exited, so the close is
      // waited for rather than fired and forgotten. Unloading too early
      // succeeds and releases nothing, which is what made this look unfixable.
      const closing = state.dictation.session
        ? state.dictation.session.close()
        : Promise.resolve();
      state.dictation.session = null;
      Promise.resolve(closing)
        .then(() => dictationClearStranded())
        .then(() => {
          state.dictation.recovering = false;
          const next = dictationSession();
          if (next && wanted) next.once("ready", () => next.record());
        });
      return;
    }

    if (stranded) {
      // Already tried. Say so plainly rather than trying again for ever.
      if (state.dictation.session) {
        state.dictation.session.close();
        state.dictation.session = null;
      }
      dictationBroadcast({
        type: "error",
        message: "Foundry would not release the recording session. Restarting Foundry Local from the Foundry panel will clear it."
      });
      return;
    }

    dictationBroadcast({ type: "error", ...payload });
  });
  session.on("ended", payload => {
    state.dictation.session = null;
    dictationBroadcast({ type: "ended", ...payload });
    // An idle session closes itself; the memory it was holding goes with it.
    dictationRelease();
  });

  if (!session.start()) return null;
  // The speech model is loaded by the Foundry CLI rather than by Horizon, so it
  // would otherwise never be counted as ours and never released. Registering it
  // here means the same shutdown that frees the chat model frees this one too.
  state.loadedByUs.add(config.dictation.alias);
  state.dictation.session = session;
  return session;
}

// Closing the session ends the CLI, but the speech model stays resident in the
// Foundry daemon, which outlives Horizon. Releasing it is the whole point of the
// idle timeout, so it is done explicitly rather than left to chance.
// Fetching the speech model the moment dictation is switched on, rather than
// leaving the first recording to stall behind a 700 MB download. It reuses the
// same progress reporting the model catalogue uses, so the page can show it
// alongside any other download. Nothing is loaded into memory here: that
// happens on the first recording, and is released when idle.
function dictationEnsureModel() {
  const alias = config.dictation.alias;
  if (state.downloads.has(alias)) return;

  foundry.cachedModels(20000)
    .then(cached => {
      const have = (cached || []).some(model => model.alias === alias || model.id === alias);
      if (have) return;

      state.downloads.set(alias, { percent: 0, startedAt: Date.now() });
      return foundry.downloadModel(alias, progress => {
        const entry = state.downloads.get(alias);
        if (entry) Object.assign(entry, progress);
      });
    })
    .catch(() => {
      // A failed download is not fatal: the first recording will try again and
      // report whatever went wrong at that point.
    })
    .then(() => state.downloads.delete(alias));
}

async function dictationRelease() {
  if (!config.dictation.enabled) return;
  if (!state.loadedByUs.has(config.dictation.alias)) return;
  try {
    await foundry.unloadModel(config.dictation.alias, 30000);
    state.loadedByUs.delete(config.dictation.alias);
  } catch {
    // Nothing to do about it: the model is released when Foundry stops.
  }
}

// A session that ended without stopping leaves Foundry holding the audio
// stream. Unloading the model does NOT release it: the unload reports success,
// the model shows as unloaded, and the stream stays held. Restarting the
// Foundry service is what clears it, which is why the CLI's own hint says so.
//
// Horizon manages that service already, so it can do this rather than telling
// the user to run a command. It is a heavy remedy — the chat model is dropped
// and has to be loaded again — so it happens once, only when a recording has
// actually failed, and never speculatively.
let dictationClearing = null;

function dictationClearStranded() {
  if (dictationClearing) return dictationClearing;
  dictationClearing = foundry.restartServer(60000)
    .then(async () => {
      // The service came back on a new port, so readiness has to be
      // re-established before anything else is asked of it.
      state.statusCache = null;
      state.warm = false;
      state.loadedByUs.delete(config.dictation.alias);
      try {
        const endpoint = await foundry.discoverEndpoint(30000);
        if (endpoint) state.baseUrl = endpoint;
      } catch {
        // probeFoundry will pick it up on the next status request.
      }
      return true;
    })
    .catch(() => false)
    .then(result => {
      dictationClearing = null;
      return result;
    });
  return dictationClearing;
}

async function streamChat(req, res, body, truncated) {
  const controller = new AbortController();
  let idleTimer = null;
  let closed = false;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), config.foundry.requestTimeoutMs);
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
    response = await foundry.chatCompletionStream(state.baseUrl, body, controller.signal);
  } catch (error) {
    clearTimeout(idleTimer);
    state.statusCache = null;
    if (closed) return;
    return sendJson(res, error.statusCode || 504, {
      error: error.name === "AbortError"
        ? `Foundry did not respond within ${config.foundry.requestTimeoutMs} ms.`
        : error.message
    });
  }

  startSse(res);
  let usage = null;
  let model = state.modelId;
  let produced = false;
  let finishReason = null;

  try {
    for await (const event of foundry.parseServerSentEvents(response)) {
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
      sendSse(res, { error: "Foundry produced an empty reply." });
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
  // Validate the request before touching Foundry, so a malformed body reports
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

  // A Foundry restart unloads models, so make sure one is actually resident
  // before sending. Loading here is far better than failing mid-stream.
  //
  // This only applies when Horizon discovered the endpoint itself. If the
  // endpoint was supplied explicitly it may be any OpenAI-compatible server,
  // or a Foundry instance this CLI does not manage, so the CLI's view of what
  // is loaded would be misleading.
  if (!state.baseUrl || !state.modelId) {
    await attachFoundry({ load: true });
    if (!state.baseUrl || !state.modelId) {
      return sendJson(res, 503, {
        error: "No model is ready yet. Open the Foundry panel to start the service and load a model."
      });
    }
  } else if (state.managed) {
    const loaded = await foundry.isModelLoaded(config.model.alias).catch(() => null);
    if (loaded === false) {
      try {
        const didLoad = await foundry.ensureLoaded(config.model.alias);
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
    const result = await foundry.chatCompletion(state.baseUrl, { ...body, stream: false }, config.foundry.requestTimeoutMs);

    if (!result.ok) {
      state.statusCache = null;
      return sendJson(res, result.status, {
        error: result.payload?.error?.message || `Foundry returned HTTP ${result.status}.`
      });
    }

    const reply = result.payload?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return sendJson(res, 502, { error: "Foundry returned no assistant message." });
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

  const foundryHop = {
    id: "foundry",
    label: "Foundry service",
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
    foundryHop.state = "error";
    foundryHop.note = "Stopped. Start it above.";
    modelHop.note = "Needs the service running.";
    hops.push(foundryHop, modelHop);
    return { hops, allLoopback: true, endpoint: null, uptimeSeconds: Math.round(process.uptime()) };
  }

  const started = Date.now();
  try {
    const models = await foundry.listModels(state.baseUrl, config.foundry.statusTimeoutMs);
    foundryHop.state = "ok";
    foundryHop.latencyMs = Date.now() - started;

    if (models.some(m => m.id === state.modelId)) {
      modelHop.state = "ok";
      modelHop.detail = state.modelId;
      modelHop.note = state.warm ? "Loaded and warm." : "Loaded.";
    } else {
      modelHop.state = "error";
      modelHop.note = `Not loaded. Run: foundry model load ${config.model.alias}`;
    }
  } catch (error) {
    foundryHop.state = "error";
    foundryHop.note = error.message;
    modelHop.state = "unknown";
    modelHop.note = "Needs the service running.";
  }

  hops.push(foundryHop, modelHop);

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
  const models = await foundry.cachedModels();
  return {
    active: state.modelId,
    activeAlias: config.model.alias,
    models: models.filter(model => model.type === "Chat" || model.type === "Multimodal")
  };
}

// Switching model at run time avoids a restart. The alias is validated before
// it can reach the Foundry command line.
async function activateModel(alias) {
  if (!foundry.isSafeAlias(alias)) throw new Error(`That model name is not allowed: ${alias}`);
  if (!state.baseUrl) throw new Error("Foundry Local is not running. Start it from the Foundry panel first.");

  const available = await foundry.cachedModels();
  if (!available.some(model => model.alias === alias)) {
    throw new Error(`"${alias}" is not downloaded on this machine.`);
  }

  await foundry.loadModel(alias);
  state.loadedByUs.add(alias);
  const modelId = await foundry.resolveModelId(state.baseUrl, alias, config.foundry.statusTimeoutMs);

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

/* ------------------------------------------------------- foundry control -- */

// Re-resolves the endpoint after Foundry starts or restarts. A restart
// unloads every model, so readiness has to be re-established rather than
// assumed from the endpoint coming back.
async function attachFoundry({ load = false } = {}) {
  const resolved = await resolveFoundry();
  state.baseUrl = resolved.baseUrl;
  state.modelId = resolved.modelId;
  state.managed = resolved.managed;
  state.statusCache = null;
  state.warm = false;

  if (load && state.managed && state.baseUrl && config.model.alias) {
    try {
      const didLoad = await foundry.ensureLoaded(config.model.alias);
      if (didLoad) state.loadedByUs.add(config.model.alias);
      state.modelId = await foundry.resolveModelId(state.baseUrl, config.model.alias, config.foundry.statusTimeoutMs);
    } catch (error) {
      resolved.reason = error.message;
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

  if (state.modelId && config.foundry.warmUpOnStart) warmUp();
  return resolved;
}

async function foundryState() {
  const install = await foundry.isInstalled();
  if (!install.installed) {
    return {
      installed: false,
      running: false,
      message: "Foundry Local is not installed, or is not on this account's PATH.",
      docs: "https://learn.microsoft.com/en-us/azure/foundry-local/"
    };
  }

  const status = await foundry.serverStatus();
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
    docs: "https://learn.microsoft.com/en-us/azure/foundry-local/"
  };
}

// The daemon's own memory. This is the number that answers "why is my machine
// using 10 GB?" -- Horizon itself is a rounding error next to a loaded model.
async function measureResources(pid) {
  if (!pid) return null;
  try {
    const result = await foundry.processMemory(pid);
    return result ? { daemonMemoryMb: result } : null;
  } catch {
    return null;
  }
}

// How much disk the downloaded models occupy, and where.
async function measureCache() {
  try {
    const [models, settings] = await Promise.all([
      foundry.cachedModels().catch(() => []),
      foundry.settings().catch(() => [])
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

  if (req.method === "GET" || req.method === "HEAD") {
    if (urlPath === "/api/status") return probeFoundry().then(value => sendJson(res, 200, value));
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
    if (urlPath === "/api/foundry") {
      return foundryState()
        .then(value => sendJson(res, 200, value))
        .catch(error => sendJson(res, 500, { error: error.message }));
    }
    if (urlPath === "/api/foundry/settings") {
      return foundry.settings()
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
    if (urlPath === "/api/dictation") {
      return sendJson(res, 200, dictationStatus());
    }
    if (urlPath === "/api/dictation/events") {
      startSse(res);
      state.dictation.listeners.add(res);
      const session = state.dictation.session;
      sendSse(res, { type: "hello", ...dictationStatus() });
      req.on("close", () => {
        state.dictation.listeners.delete(res);
        // Catch and release. The page is the only thing that shows the
        // microphone is open, so when no page is watching there must be no
        // session: a refresh, a closed tab and a closed browser all mean the
        // same thing. Nothing is preserved across a reload, which is what kept
        // the next recording fighting a stream that was still being released.
        if (state.dictation.listeners.size) return;
        setTimeout(() => {
          if (state.dictation.listeners.size) return;
          const current = state.dictation.session;
          if (!current) return;
          state.dictation.session = null;
          // Recorded so that anything asking for a session waits for this to
          // finish rather than racing it. close() stops the recording first and
          // resolves once the CLI has really gone, so the daemon has released
          // the stream before the next page asks for one.
          dictationTeardown = Promise.resolve(current.close())
            .then(() => dictationRelease())
            .catch(() => {})
            .then(() => { dictationTeardown = null; });
        }, 1200);
      });
      // Nothing further to send until the session says something; the
      // connection stays open for that.
      if (session && session.ready) sendSse(res, { type: "ready" });
      return;
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
    if (urlPath === "/api/foundry/progress") {
      const downloads = {};
      for (const [alias, entry] of state.downloads) {
        downloads[alias] = { ...entry, elapsedMs: Date.now() - entry.startedAt };
      }
      return sendJson(res, 200, { downloads });
    }
    if (urlPath === "/api/foundry/catalogue") {
      const query = new URL(req.url, "http://localhost").searchParams;
      return foundry.catalogue({
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
    if (urlPath === "/api/brand/foundry") {
      // Foundry Local's own icon, read from wherever it is installed on this
      // machine. Horizon keeps no copy of Microsoft's artwork; if Foundry is
      // absent the page falls back to its own glyph.
      return foundryIcon()
        .then(icon => {
          if (!icon) return sendJson(res, 404, { error: "Foundry Local is not installed." });
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": icon.bytes.length,
            "Cache-Control": "no-store",
            "Content-Security-Policy": CSP,
            "X-Content-Type-Options": "nosniff"
          });
          res.end(icon.bytes);
        })
        .catch(() => sendJson(res, 404, { error: "Foundry Local is not installed." }));
    }
    return serveStatic(res, urlPath);
  }

  if (req.method === "POST") {
    if (urlPath === "/api/chat") return handleChat(req, res);

    // Foundry daemon control. These shell out to the Foundry CLI with fixed
    // arguments; nothing from the request body reaches the command line.
    // A graceful shutdown that releases the model, requested by the Stop
    // script or the Exit button. Loopback-only binding is what protects this.
    if (urlPath === "/api/shutdown") {
      return readBody(req, 1024)
        .then(raw => {
          const options = raw ? JSON.parse(raw) : {};
          // The Exit button asks for the service to stop too, so the machine
          // gets its memory back rather than leaving a large daemon resident.
          if (options.stopService) config.foundry.stopServiceOnExit = true;
          sendJson(res, 200, { stopping: true, stopService: Boolean(config.foundry.stopServiceOnExit) });
          setTimeout(() => shutdown("Exit request"), 150);
        })
        .catch(() => {
          sendJson(res, 200, { stopping: true });
          setTimeout(() => shutdown("Exit request"), 150);
        });
    }

    if (urlPath === "/api/foundry/settings") {
      return readBody(req, 2048)
        .then(async raw => {
          const { key, value } = JSON.parse(raw || "{}");
          await foundry.setSetting(key, value);
          return sendJson(res, 200, { settings: await foundry.settings() });
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

    if (urlPath === "/api/dictation") {
      // Switching the capability on or off, and driving one session: start,
      // record, stop, close.
      return readBody(req, 2048)
        .then(async raw => {
          const body = JSON.parse(raw || "{}");

          if (typeof body.enabled === "boolean") {
            saveLocalSettings({ dictation: { enabled: body.enabled } });
            config.dictation.enabled = body.enabled;
            if (!body.enabled && state.dictation.session) {
              state.dictation.session.close();
              state.dictation.session = null;
            }
            // Fetch the speech model as soon as it is asked for, rather than
            // leaving the first recording to stall behind a download nobody
            // was warned about. It is not loaded into memory here: that
            // happens on the first recording and is released when idle.
            if (body.enabled) dictationEnsureModel();
            return sendJson(res, 200, dictationStatus());
          }

          if (!config.dictation.enabled) {
            return sendJson(res, 409, { error: "Dictation is switched off." });
          }

          const capability = dictation.capability();
          if (!capability.available) {
            // Said plainly rather than as a failed button press: this machine
            // cannot run live dictation and no amount of retrying will help.
            return sendJson(res, 501, { error: capability.reason });
          }

          if (body.action === "start" || body.action === "record") {
            const session = await dictationSessionAsync();
            if (!session) return sendJson(res, 500, { error: "The dictation session could not be started." });
            if (body.action === "record") {
              if (!session.ready) {
                // The model is still loading. Recording begins by itself once
                // it is ready, so the user is not left pressing the button to
                // find out whether anything is happening.
                session.once("ready", () => session.record());
                return sendJson(res, 202, dictationStatus());
              }
              session.record();
            }
            return sendJson(res, 200, dictationStatus());
          }

          if (body.action === "stop") {
            const session = state.dictation.session;
            if (!session) return sendJson(res, 409, { error: "Nothing is being recorded." });
            session.stop();
            return sendJson(res, 200, dictationStatus());
          }

          if (body.action === "close") {
            if (state.dictation.session) {
              state.dictation.session.close();
              state.dictation.session = null;
            }
            return sendJson(res, 200, dictationStatus());
          }

          return sendJson(res, 400, { error: "Unknown dictation action." });
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

    if (urlPath === "/api/foundry/download" || urlPath === "/api/foundry/remove") {
      const removing = urlPath.endsWith("remove");
      return readBody(req, 4096)
        .then(async raw => {
          const alias = JSON.parse(raw || "{}").alias;

          if (removing) {
            if (alias === config.model.alias) {
              return sendJson(res, 400, { error: "That model is in use. Switch to another one first." });
            }
            await foundry.removeModel(alias);
            state.loadedByUs.delete(alias);
          } else {
            // Progress is recorded as it arrives so the page can poll for it.
            // A multi-gigabyte download otherwise looks identical to a hang.
            state.downloads.set(alias, { percent: 0, sizeMb: null, startedAt: Date.now() });
            try {
              await foundry.downloadModel(alias, progress => {
                const entry = state.downloads.get(alias);
                if (entry) Object.assign(entry, { percent: progress.percent, sizeMb: progress.sizeMb });
              });
            } catch (error) {
              state.downloads.delete(alias);
              throw error;
            }
            state.downloads.delete(alias);
          }

          return sendJson(res, 200, { alias, models: await foundry.catalogue({}) });
        })
        .catch(error => sendJson(res, 400, { error: error.message }));
    }

    if (urlPath === "/api/foundry/start" || urlPath === "/api/foundry/stop" || urlPath === "/api/foundry/restart") {
      const action = urlPath.split("/").pop();
      const run = action === "start" ? foundry.startServer
        : action === "stop" ? foundry.stopServer
        : foundry.restartServer;

      return run()
        .then(async () => {
          if (action === "stop") {
            state.baseUrl = null;
            state.modelId = null;
            state.statusCache = null;
          } else {
            await attachFoundry({ load: true });
          }
          return sendJson(res, 200, await foundryState());
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
            await foundry.unloadModel(alias);
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

// Horizon can run as a front end for Foundry, so a missing or stopped
// Foundry is a state to display rather than a reason to refuse to start.
// Chat stays unavailable until a model is ready; everything else works.
async function resolveFoundry() {
  let baseUrl = config.foundry.baseUrl;

  // Only an endpoint Horizon discovered itself is one the Foundry CLI is
  // known to manage. An explicitly supplied URL may be any OpenAI-compatible
  // server, so model control is left alone in that case.
  const managed = !baseUrl;

  if (!baseUrl) {
    const endpoint = await foundry.discoverEndpoint();
    if (!endpoint) return { baseUrl: null, modelId: null, managed, reason: "Foundry Local is not running." };
    baseUrl = endpoint.endsWith(config.foundry.apiPrefix) ? endpoint : endpoint + config.foundry.apiPrefix;
  }

  baseUrl = baseUrl.replace(/\/+$/, "");
  try {
    foundry.assertLoopback(baseUrl);
  } catch (error) {
    fail(`${error.message}\n\nThis application is loopback-only by design and will not contact a remote endpoint.`);
  }

  let modelId = config.model.id;
  if (!modelId) {
    try {
      modelId = await foundry.resolveModelId(baseUrl, config.model.alias, config.foundry.statusTimeoutMs);
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
    await foundry.chatCompletion(state.baseUrl, {
      model: state.modelId,
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      max_tokens: 1
    }, config.foundry.warmUpTimeoutMs);
    state.warm = true;
  } catch {
    /* a failed warm-up is not fatal; the first message simply pays the cost */
  }
}

async function main() {
  if (!fs.existsSync(path.join(config.publicDir, "index.html"))) {
    fail(`The interface file is missing:\n  ${path.join(config.publicDir, "index.html")}`);
  }

  // Checked before anything else starts: resolving Foundry or binding a port
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

  const resolved = await resolveFoundry();
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
    console.log(`  Foundry: ${state.baseUrl}`);
  } else {
    console.log(`  Model:   not ready - ${resolved.reason}`);
    console.log(`  Foundry: ${state.baseUrl || "not running"}`);
    console.log(`\n  Open the page and use the Foundry panel to start it.`);
  }
  console.log(`  State:   ${stateFile}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  if (config.web.openBrowser) openInBrowser(url);


  if (config.foundry.warmUpOnStart && state.modelId) {
    warmUp().then(() => {
      if (state.warm) console.log("  The model is warmed up and ready for a fast first reply.\n");
    });
  }
}

/* ---------------------------------------------------------------- shutdown -- */

// Models stay resident in the Foundry daemon long after Horizon exits, so a
// clean shutdown releases whatever we loaded. Only models this instance loaded
// are unloaded, and only when Horizon is managing the service, so a Foundry
// instance someone else is using is left alone.
async function releaseResources() {
  if (!state.managed) return;

  if (config.foundry.unloadOnExit && state.loadedByUs.size) {
    for (const alias of state.loadedByUs) {
      try {
        process.stdout.write(`  Releasing ${alias} from memory... `);
        await foundry.unloadModel(alias, 30000);
        console.log("done");
      } catch {
        console.log("could not unload; it will be released when Foundry stops");
      }
    }
  }

  if (config.foundry.stopServiceOnExit) {
    try {
      process.stdout.write("  Stopping the Foundry service... ");
      await foundry.stopServer(30000);
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

  // A hard cap, so an unresponsive Foundry can never leave the process hanging.
  const guard = setTimeout(() => {
    console.log("  Shutdown took too long; exiting anyway.");
    process.exit(0);
  }, 45000);
  guard.unref();

  server.close();
  // Before anything else: a dictation session holds the microphone open, and
  // leaving it open after Horizon exits would be indefensible.
  if (state.dictation.session) {
    try {
      state.dictation.session.close();
    } catch { /* the process may already be gone */ }
    state.dictation.session = null;
  }
  try {
    await releaseResources();
  } catch { /* never block exit on cleanup */ }

  runtime.clearState(config);
  clearTimeout(guard);
  console.log("  Goodbye.\n");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("unhandledRejection", error => fail(`Unexpected error: ${error?.message || error}`));

main().catch(error => fail(error?.message || String(error)));
