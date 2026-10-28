"use strict";

const path = require("path");
const { execFile, spawn } = require("child_process");
const { createClient, parseServerSentEvents } = require("./openai-client");

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

// Ollama model names carry a tag and may point at a Hugging Face GGUF, e.g.
// "qwen2.5:3b" or "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M". They
// travel in JSON bodies to the local API and never reach a command line, but
// are still constrained so a hand-edited config or a hostile page cannot send
// anything odd.
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]{0,127}$/;

function isSafeAlias(alias) {
  return typeof alias === "string" && SAFE_NAME.test(alias) && !alias.includes("..") && !alias.includes("//");
}

// Ollama has no remote catalogue API, so these are small, well-known models
// that fit a modest machine. They are suggestions, not a registry: any name the
// Ollama library or a Hugging Face GGUF repository provides can be pulled.
const SUGGESTED = [
  { name: "llama3.2:1b", sizeMb: 1300, tools: true },
  { name: "llama3.2:3b", sizeMb: 2000, tools: true },
  { name: "qwen2.5:1.5b", sizeMb: 986, tools: true },
  { name: "qwen2.5:3b", sizeMb: 1900, tools: true },
  { name: "qwen3:1.7b", sizeMb: 1400, tools: true },
  { name: "qwen3:4b", sizeMb: 2500, tools: true },
  { name: "phi4-mini", sizeMb: 2500, tools: true },
  { name: "gemma3:1b", sizeMb: 815, tools: false },
  { name: "gemma3:4b", sizeMb: 3300, tools: false },
  { name: "smollm2:1.7b", sizeMb: 1800, tools: false }
];

// /api/tags does not report tool support without a call per model, so this is a
// family-level hint for the badge only. A model that lacks it simply fails the
// agent protocol and Horizon reports that, as it does for any weak model.
const TOOL_FAMILIES = /^(llama3\.[123]|qwen2\.5|qwen3|phi4-mini|mistral|mixtral|granite3|command-r|firefunction|hermes3|nemotron)/i;

function toModel(entry, loadedNames) {
  const name = entry.name || entry.model;
  const embedding = /embed/i.test(name) || /bert/i.test(entry.details?.family || "");
  return {
    alias: name,
    id: name,
    displayName: name,
    type: embedding ? "Embedding" : "Chat",
    device: null,
    sizeMb: entry.size ? Math.round(entry.size / 1024 / 1024) : null,
    cached: true,
    loaded: loadedNames.has(name),
    license: null,
    supportsTools: TOOL_FAMILIES.test(name),
    parameterSize: entry.details?.parameter_size || null,
    quantization: entry.details?.quantization_level || null
  };
}

function binaryCandidates(configured) {
  const list = [configured || "ollama"];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
  }
  return list;
}

function createOllama(options = {}) {
  const client = createClient({ label: "Ollama", reachName: "Ollama" });
  const configuredBase = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  const keepAlive = options.keepAlive || "30m";
  const configuredBinary = options.binary || null;
  let endpoint = configuredBase;
  let child = null;

  const api = pathname => `${endpoint}${pathname}`;

  async function getJson(pathname, timeoutMs = 10000) {
    const result = await client.fetchJson(api(pathname), { method: "GET" }, timeoutMs);
    if (!result.ok) throw new Error(`Ollama returned HTTP ${result.status} for ${pathname}.`);
    return result.payload || {};
  }

  async function postJson(pathname, body, timeoutMs, method = "POST") {
    const result = await client.fetchJson(api(pathname), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, timeoutMs);
    if (!result.ok) {
      const detail = result.payload?.error || `HTTP ${result.status}`;
      throw new Error(String(detail));
    }
    return result.payload || {};
  }

  function runBinary(args, timeoutMs) {
    const tryNext = candidates => new Promise(resolve => {
      if (!candidates.length) return resolve({ ok: false, output: "" });
      const [command, ...rest] = candidates;
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") return resolve(tryNext(rest));
        resolve({ ok: !error, output: `${stdout || ""}\n${stderr || ""}`, command });
      });
    });
    return tryNext(binaryCandidates(configuredBinary));
  }

  async function serverStatus(timeoutMs = 5000) {
    try {
      const version = await getJson("/api/version", timeoutMs);
      return { running: true, state: "running", pid: child?.pid || null, version: version.version || null, webUrls: [endpoint] };
    } catch {
      return { running: false, state: "stopped", pid: null, webUrls: [] };
    }
  }

  async function isInstalled(timeoutMs = 10000) {
    const status = await serverStatus(Math.min(timeoutMs, 3000));
    if (status.running) return { installed: true, version: status.version };
    const result = await runBinary(["--version"], timeoutMs);
    if (!result.ok) return { installed: false, version: null };
    return { installed: true, version: (/\d+\.\d+\.\d+/.exec(result.output) || [])[0] || null };
  }

  async function waitUntilUp(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await serverStatus(1500)).running) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  async function startServer(timeoutMs = 120000) {
    if ((await serverStatus(2000)).running) return true;

    let spawned = null;
    for (const command of binaryCandidates(configuredBinary)) {
      try {
        spawned = await new Promise((resolve, reject) => {
          // A non-default loopback port has to be passed on, or the service
          // would come up where Horizon is not looking.
          const proc = spawn(command, ["serve"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env, OLLAMA_HOST: new URL(configuredBase).host }
          });
          proc.once("error", reject);
          proc.once("spawn", () => resolve(proc));
        });
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Could not start Ollama. ${error.message}`);
      }
    }
    if (!spawned) throw new Error("Could not start Ollama. It is not installed, or is not on this account's PATH.");

    spawned.unref();
    child = spawned;
    child.once("exit", () => { if (child === spawned) child = null; });

    if (!(await waitUntilUp(timeoutMs))) throw new Error("Ollama started but did not become reachable in time.");
    return true;
  }

  // Ollama has no stop command. Only a process this instance started can be
  // stopped without guessing at someone else's tray app or Windows service.
  async function stopServer() {
    if (!child) {
      throw new Error("Ollama was not started by Horizon. Quit it from the system tray or its own service manager.");
    }
    const pid = child.pid;
    child = null;
    await new Promise(resolve => {
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      } else {
        try { process.kill(pid); } catch { /* already gone */ }
        resolve();
      }
    });
    return true;
  }

  async function restartServer(timeoutMs = 120000) {
    await stopServer();
    await new Promise(resolve => setTimeout(resolve, 500));
    return startServer(timeoutMs);
  }

  async function settings() {
    return [];
  }

  async function setSetting(key) {
    throw new Error(`Ollama has no settings that can be changed from here: ${key}`);
  }

  async function psNames(timeoutMs) {
    const payload = await getJson("/api/ps", timeoutMs);
    return new Map((payload.models || []).map(entry => [entry.name || entry.model, entry]));
  }

  // Every model on disk, with whether it is resident in memory right now.
  async function cachedModels(timeoutMs = 20000) {
    const [tags, loaded] = await Promise.all([getJson("/api/tags", timeoutMs), psNames(timeoutMs).catch(() => new Map())]);
    const names = new Set(loaded.keys());
    return (tags.models || []).map(entry => {
      const model = toModel(entry, names);
      const resident = loaded.get(model.alias);
      if (resident) model.device = resident.size_vram > 0 ? "gpu" : "cpu";
      return model;
    });
  }

  async function catalogue(options = {}, timeoutMs = 20000) {
    const installed = await cachedModels(timeoutMs);
    const have = new Set(installed.map(model => model.alias));
    const suggested = SUGGESTED.filter(item => !have.has(item.name)).map(item => ({
      alias: item.name,
      id: item.name,
      displayName: item.name,
      type: "Chat",
      device: null,
      sizeMb: item.sizeMb,
      cached: false,
      loaded: false,
      license: null,
      supportsTools: item.tools,
      suggested: true
    }));

    let models = [...installed, ...suggested];
    if (options.cached) models = models.filter(model => model.cached);
    if (["chat", "speech", "embedding"].includes(String(options.type).toLowerCase())) {
      const wanted = String(options.type).toLowerCase();
      models = models.filter(model => model.type.toLowerCase() === wanted);
    }
    if (options.search && /^[\w.\-/: ]{1,60}$/.test(options.search)) {
      const needle = options.search.trim().toLowerCase();
      models = models.filter(model => model.alias.toLowerCase().includes(needle));
    }
    return models;
  }

  // /api/pull streams one JSON object per line. Layers report their own
  // totals, so overall progress is the sum across every layer seen so far.
  async function downloadModel(alias, onProgress, timeoutMs = 3600000) {
    if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const layers = new Map();
    let highest = 0;
    // Layers are announced one after another, so the running total can grow and
    // make the sum fall. A progress bar that moves backwards looks broken.
    const report = () => {
      let total = 0;
      let done = 0;
      for (const layer of layers.values()) {
        total += layer.total;
        done += layer.completed;
      }
      if (typeof onProgress === "function") {
        onProgress({
          alias,
          percent: highest = Math.max(highest, total ? Math.min(99, Math.floor((done / total) * 100)) : 0),
          sizeMb: total ? Math.round(total / 1024 / 1024) : null
        });
      }
    };

    try {
      let response;
      try {
        response = await fetch(api("/api/pull"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: alias, stream: true }),
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(`Could not reach Ollama at ${endpoint} (${error.message}).`);
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try { detail = JSON.parse(await response.text()).error || detail; } catch { /* keep status */ }
        throw new Error(`Could not download "${alias}". ${detail}`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let succeeded = false;
      const handle = line => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.error) throw new Error(`Could not download "${alias}". ${event.error}`);
        if (event.status === "success") succeeded = true;
        if (event.digest && event.total) {
          layers.set(event.digest, { total: event.total, completed: event.completed || 0 });
          report();
        }
      };

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(handle);
      }
      handle(buffer);

      if (!succeeded) throw new Error(`Downloading "${alias}" ended before it finished.`);
      if (typeof onProgress === "function") onProgress({ alias, percent: 100, sizeMb: null });
      return true;
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`Downloading "${alias}" timed out.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function removeModel(alias, timeoutMs = 60000) {
    if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
    try {
      await postJson("/api/delete", { model: alias }, timeoutMs, "DELETE");
    } catch (error) {
      throw new Error(`Could not remove "${alias}". ${error.message}`);
    }
    return true;
  }

  // An empty /api/generate request loads the model and keeps it resident.
  async function loadModel(alias, timeoutMs = 600000) {
    if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
    try {
      await postJson("/api/generate", { model: alias, prompt: "", stream: false, keep_alive: keepAlive }, timeoutMs);
    } catch (error) {
      throw new Error(`Could not load "${alias}". ${error.message}`);
    }
    return true;
  }

  async function unloadModel(alias, timeoutMs = 120000) {
    if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
    try {
      await postJson("/api/generate", { model: alias, prompt: "", stream: false, keep_alive: 0 }, timeoutMs);
    } catch (error) {
      throw new Error(`Could not unload "${alias}". ${error.message}`);
    }
    return true;
  }

  // "llama3.2" and "llama3.2:latest" are the same model to Ollama.
  function sameModel(candidate, wanted) {
    const a = String(candidate).toLowerCase();
    const b = String(wanted).toLowerCase();
    return a === b || a === `${b}:latest` || `${a}:latest` === b;
  }

  async function isModelLoaded(alias, timeoutMs = 20000) {
    const loaded = await psNames(timeoutMs);
    return [...loaded.keys()].some(name => sameModel(name, alias));
  }

  // Ollama loads a model by itself on the first request, so an installed model
  // is ready to use even when it is not resident yet.
  async function isModelAvailable(alias, timeoutMs = 20000) {
    const models = await cachedModels(timeoutMs);
    return models.some(model => sameModel(model.alias, alias));
  }

  async function ensureLoaded(alias, timeoutMs = 600000) {
    if (await isModelLoaded(alias)) return false;
    await loadModel(alias, timeoutMs);
    return true;
  }

  async function discoverEndpoint(timeoutMs = 5000) {
    endpoint = configuredBase;
    return (await serverStatus(timeoutMs)).running ? endpoint : null;
  }

  function selectModel(models, alias) {
    const wanted = String(alias).toLowerCase();
    return models.find(model => String(model?.id || "").toLowerCase() === wanted)
      || models.find(model => sameModel(model?.id || "", wanted))
      || models.find(model => String(model?.id || "").toLowerCase().startsWith(`${wanted}:`))
      || null;
  }

  async function resolveModelId(baseUrl, alias, timeoutMs) {
    const models = await client.listModels(baseUrl, timeoutMs);
    const model = selectModel(models, alias);
    if (!model) {
      const available = models.map(item => item.id).join(", ") || "none";
      throw new Error(`No installed model matches "${alias}". Installed models: ${available}. Pull it with: ollama pull ${alias}`);
    }
    return model.id;
  }

  return {
    name: "ollama",
    label: "Ollama",
    docsUrl: "https://ollama.com/download",
    loadsOnDemand: true,
    supportsDictation: false,
    restartHint: "ollama serve",
    loadHint: alias => `ollama run ${alias}`,
    defaultAlias: "llama3.2:3b",
    isSafeAlias,
    variantName: id => String(id || ""),
    mergeLoadState: (catalogueModels, cacheModels) => {
      const loaded = new Set((cacheModels || []).filter(model => model.loaded).map(model => model.alias));
      return catalogueModels.map(model => ({ ...model, loaded: loaded.has(model.alias) }));
    },
    isInstalled,
    serverStatus,
    startServer,
    stopServer,
    restartServer,
    settings,
    setSetting,
    catalogue,
    cachedModels,
    processMemory: async () => null,
    endpointAlive: client.endpointAlive,
    isModelLoaded,
    isModelAvailable,
    ensureLoaded,
    downloadModel,
    removeModel,
    loadModel,
    unloadModel,
    discoverEndpoint,
    assertLoopback: client.assertLoopback,
    listModels: client.listModels,
    selectModel,
    resolveModelId,
    chatCompletion: client.chatCompletion,
    chatCompletionStream: client.chatCompletionStream,
    agentCompletion: client.agentCompletion,
    parseServerSentEvents
  };
}

module.exports = { createOllama, isSafeAlias, SUGGESTED, DEFAULT_BASE_URL };
