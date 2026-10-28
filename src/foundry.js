"use strict";

const { execFile, spawn } = require("child_process");
const { createClient, parseServerSentEvents } = require("./openai-client");

const client = createClient({ label: "Foundry", reachName: "Foundry Local" });
const { assertLoopback, listModels, chatCompletion, agentCompletion, chatCompletionStream, endpointAlive } = client;

const ENDPOINT_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i;

// Model aliases arrive from the browser, so they are constrained to a safe
// character set before ever reaching the command line.
const SAFE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function isSafeAlias(alias) {
  return typeof alias === "string" && SAFE_ALIAS.test(alias);
}

// "qwen2.5-3b-instruct-generic-cpu:2" -> "qwen2.5-3b-instruct-generic-cpu".
// Loading by this name pins one downloaded build; a bare alias lets Foundry
// pick another build (often a GPU one) that may not be downloaded or may not
// run on this machine.
function variantName(id) {
  return String(id || "").replace(/:\d+$/, "");
}

// Arguments are passed as a real argv array with no shell involved, so they
// are never concatenated into a command string and cannot be used to inject
// further commands. This is the primary defence; isSafeAlias is the second.
function runFoundry(args, timeoutMs) {
  return new Promise(resolve => {
    execFile("foundry", args, { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout || ""}\n${stderr || ""}` }));
  });
}

// Arguments are never interpolated into a shell string. Anything that reaches
// this function has already been validated by isSafeAlias.
function runFoundrySafe(args, timeoutMs) {
  if (!args.every(arg => /^[a-zA-Z0-9._\-]+$/.test(arg))) {
    return Promise.resolve({ ok: false, output: "Rejected unsafe argument." });
  }
  return runFoundry(args, timeoutMs);
}

async function runFoundryJson(args, timeoutMs) {
  const result = await runFoundry([...args, "--output", "json"], timeoutMs);
  if (!result.ok) return null;
  const match = /\{[\s\S]*\}/.exec(result.output);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function serverStatus(timeoutMs = 15000) {
  return runFoundryJson(["server", "status"], timeoutMs);
}

// Whether the Foundry CLI is on PATH at all. Used so Horizon can act as a
// front end for Foundry rather than refusing to start without it.
async function isInstalled(timeoutMs = 10000) {
  const result = await runFoundry(["--version"], timeoutMs);
  if (!result.ok) return { installed: false, version: null };
  const version = (/\d+\.\d+\.\d+/.exec(result.output) || [])[0] || null;
  return { installed: true, version };
}

async function startServer(timeoutMs = 120000) {
  const result = await runFoundry(["server", "start"], timeoutMs);
  if (!result.ok) throw new Error(`Could not start the Foundry service. ${result.output.trim().split("\n").pop() || ""}`.trim());
  return true;
}

async function stopServer(timeoutMs = 60000) {
  const result = await runFoundry(["server", "stop"], timeoutMs);
  if (!result.ok) throw new Error("Could not stop the Foundry service.");
  return true;
}

// Persistent CLI settings: port, cache-directory, idle-timeout-minutes,
// log-level. Values are constrained here because they reach a command line.
async function settings(timeoutMs = 20000) {
  const payload = await runFoundryJson(["config", "show"], timeoutMs);
  if (!payload?.settings) return [];
  return payload.settings.map(item => ({
    key: item.key,
    value: item.value,
    userSet: Boolean(item.userSet)
  }));
}

const SETTING_RULES = {
  "port": /^(auto|\d{1,5})$/,
  "idle-timeout-minutes": /^(disabled|\d{1,5})$/,
  "log-level": /^(trace|debug|info|warn|error)$/
};

// Changing a daemon-affecting setting normally asks for confirmation, and
// there is no terminal here to answer it, so --force is required.
async function setSetting(key, value, timeoutMs = 60000) {
  const rule = SETTING_RULES[key];
  if (!rule) throw new Error(`That setting cannot be changed from here: ${key}`);
  if (!rule.test(String(value))) throw new Error(`"${value}" is not valid for ${key}.`);

  const result = await runFoundrySafe(["config", "set", key, String(value), "--force"], timeoutMs);
  if (!result.ok) throw new Error(`Could not set ${key}. ${result.output.trim().split("\n").pop() || ""}`.trim());
  return true;
}

async function restartServer(timeoutMs = 120000) {
  const result = await runFoundry(["server", "restart"], timeoutMs);
  if (!result.ok) throw new Error("Could not restart the Foundry service.");
  return true;
}

// The whole catalogue, not just what is cached. The plain-text table only
// shows one default target per machine, so JSON is the only complete view.
//
// Filters mirror the documented CLI options:
//   foundry model list [--device cpu|gpu|npu] [--type chat|speech|embedding]
//                      [--search q] [--cached] [--variants]
// "foundry model list" describes the catalogue but omits load state entirely;
// only "foundry cache list" reports whether a model is resident in memory.
// Merging the two is the only way to tell "on disk" from "in memory".
function mergeLoadState(catalogueModels, cacheModels) {
  const loadedAliases = new Set(
    (cacheModels || []).filter(model => model.loaded).map(model => model.alias)
  );
  return catalogueModels.map(model => ({ ...model, loaded: loadedAliases.has(model.alias) }));
}

async function catalogue(options = {}, timeoutMs = 120000) {
  const args = ["model", "list"];

  if (["cpu", "gpu", "npu"].includes(String(options.device).toLowerCase())) {
    args.push("--device", String(options.device).toLowerCase());
  }
  if (["chat", "speech", "embedding"].includes(String(options.type).toLowerCase())) {
    args.push("--type", String(options.type).toLowerCase());
  }
  if (options.cached) args.push("--cached");
  if (options.variants) args.push("--variants");
  if (options.search && /^[\w.\- ]{1,40}$/.test(options.search)) {
    args.push("--search", options.search.trim());
  }

  const payload = await runFoundryJson(args, timeoutMs);
  if (!payload?.models) return [];

  let cacheModels = [];
  try {
    cacheModels = await cachedModels(20000);
  } catch {
    // Load state is a nicety here; the catalogue is still worth showing without it.
  }

  const models = payload.models.map(model => ({
    alias: model.alias,
    id: model.id,
    displayName: model.displayName,
    type: model.type,
    device: model.device,
    sizeMb: model.fileSizeMb,
    cached: Boolean(model.cached),
    loaded: false,
    license: model.license || null,
    supportsTools: Boolean(model.supportsToolCalling)
  }));

  return mergeLoadState(models, cacheModels);
}

// Returns every model downloaded on this machine, with whether it is currently
// resident in memory.
async function cachedModels(timeoutMs = 20000) {
  const payload = await runFoundryJson(["cache", "list"], timeoutMs);
  if (!payload?.models) return [];
  return payload.models.map(model => ({
    alias: model.alias,
    id: model.id,
    displayName: model.displayName,
    type: model.type,
    device: model.device,
    sizeMb: model.fileSizeMb,
    loaded: Boolean(model.loaded),
    supportsTools: Boolean(model.supportsToolCalling)
  }));
}

// The CLI reports progress as lines of "<model-id>: 42%". Streaming them out
// matters because a large model is several gigabytes: with no feedback the UI
// looks frozen for many minutes and people cannot tell it apart from a hang.
function downloadModel(alias, onProgress, timeoutMs = 3600000) {
  if (!isSafeAlias(alias)) return Promise.reject(new Error(`Rejected model name: ${alias}`));

  return new Promise((resolve, reject) => {
    // Same no-shell argv form as runFoundry, so there is no injection surface.
    const child = spawn("foundry", ["model", "download", alias], { windowsHide: true });

    let output = "";
    let pending = "";
    let sizeMb = null;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Downloading "${alias}" timed out.`));
    }, timeoutMs);

    const read = chunk => {
      const text = chunk.toString();
      output += text;

      // The total size appears once, in the opening banner.
      const size = /\(([^,]+),\s*([\d.]+)\s*(MB|GB)\)/i.exec(text);
      if (size && sizeMb === null) {
        sizeMb = Number(size[2]) * (size[3].toUpperCase() === "GB" ? 1024 : 1);
      }

      // Percentages can arrive split across chunks, so buffer to line ends.
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() || "";

      for (const line of [...lines, pending]) {
        const match = /:\s*(\d{1,3})%/.exec(line);
        if (match) {
          const percent = Math.min(100, Number(match[1]));
          if (typeof onProgress === "function") onProgress({ alias, percent, sizeMb });
        }
      }
    };

    child.stdout.on("data", read);
    child.stderr.on("data", read);

    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`Could not run Foundry: ${error.message}`));
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) {
        if (typeof onProgress === "function") onProgress({ alias, percent: 100, sizeMb });
        return resolve(true);
      }
      const last = output.trim().split(/\r?\n/).pop() || "";
      reject(new Error(`Could not download "${alias}". ${last}`.trim()));
    });
  });
}

// Deletes the downloaded files. --force keeps it non-interactive, which
// matters because there is no console to answer a prompt on.
async function removeModel(alias, timeoutMs = 300000) {
  if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
  const result = await runFoundrySafe(["cache", "remove", alias, "--force"], timeoutMs);
  if (!result.ok) throw new Error(`Could not remove "${alias}". ${result.output.trim().split("\n").pop() || ""}`.trim());
  return true;
}

async function loadModel(alias, timeoutMs = 600000) {
  if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
  const result = await runFoundrySafe(["model", "load", alias], timeoutMs);
  if (!result.ok) throw new Error(`Could not load "${alias}". ${result.output.trim().split("\n").pop() || ""}`.trim());
  return true;
}

async function unloadModel(alias, timeoutMs = 120000) {
  if (!isSafeAlias(alias)) throw new Error(`Rejected model name: ${alias}`);
  const result = await runFoundrySafe(["model", "unload", alias], timeoutMs);
  if (!result.ok) throw new Error(`Could not unload "${alias}".`);
  return true;
}

// Used only when FOUNDRY_BASE_URL was not supplied by the launcher, so that
// `npm start` works without the PowerShell wrapper.
// Whether a model is genuinely resident in memory. This matters because
// /v1/models lists everything in the local cache, loaded or not, so it cannot
// be used as a readiness signal. "foundry cache list" carries the real flag.
async function isModelLoaded(alias, timeoutMs = 20000) {
  const models = await cachedModels(timeoutMs);
  // The configured name may be an alias or an exact build (see variantName).
  const entry = models.find(model => model.alias === alias && model.loaded) ||
    models.find(model => variantName(model.id) === alias);
  return Boolean(entry && entry.loaded);
}

// Loads the model only if it is not already resident, so callers can make
// readiness idempotent without paying the load cost twice.
async function ensureLoaded(alias, timeoutMs = 600000) {
  if (await isModelLoaded(alias)) return false;
  await loadModel(alias, timeoutMs);
  return true;
}

async function discoverEndpoint(timeoutMs = 15000) {
  const status = await serverStatus(timeoutMs);
  const fromJson = status?.webUrls?.find(url => ENDPOINT_PATTERN.test(url));
  if (fromJson) return fromJson.replace(/\/+$/, "");

  const result = await runFoundry(["server", "status"], timeoutMs);
  const match = ENDPOINT_PATTERN.exec(result.output || "");
  return match ? match[0].replace(/\/+$/, "") : null;
}

// Matches on the alias reported by Foundry rather than a hardcoded name
// pattern, so any Foundry model works without code changes.
function selectModel(models, alias) {
  const wanted = String(alias).toLowerCase();
  return models.find(m => String(m?.parent || "").toLowerCase() === wanted)
    || models.find(m => String(m?.id || "").toLowerCase() === wanted)
    || models.find(m => String(m?.id || "").toLowerCase().startsWith(wanted))
    || null;
}

async function resolveModelId(baseUrl, alias, timeoutMs) {
  const models = await listModels(baseUrl, timeoutMs);
  const model = selectModel(models, alias);
  if (!model) {
    const available = models.map(m => m.id).join(", ") || "none";
    throw new Error(`No loaded model matches alias "${alias}". Loaded models: ${available}.`);
  }
  return model.id;
}

// Resident memory of a process, in MB. Used to show what the Foundry daemon is
// actually holding, which is the number behind "why is my machine using 10 GB?".
// The PID comes from Foundry's own status output, and is validated as a number
// before it reaches the command line.
function processMemory(pid, timeoutMs = 8000) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);

  if (process.platform !== "win32") {
    return new Promise(resolve => {
      execFile("ps", ["-o", "rss=", "-p", String(id)], { timeout: timeoutMs },
        (error, stdout) => {
          const kb = Number(String(stdout || "").trim());
          resolve(error || !kb ? null : Math.round(kb / 1024));
        });
    });
  }

  return new Promise(resolve => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${id} -ErrorAction SilentlyContinue).WorkingSet64`],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        const bytes = Number(String(stdout || "").trim());
        resolve(error || !bytes ? null : Math.round(bytes / 1024 / 1024));
      });
  });
}

module.exports = {
  ENDPOINT_PATTERN,
  agentCompletion,
  variantName,
  isSafeAlias,
  mergeLoadState,
  isInstalled,
  serverStatus,
  startServer,
  stopServer,
  restartServer,
  settings,
  setSetting,
  catalogue,
  cachedModels,
  processMemory,
  endpointAlive,
  isModelLoaded,
  ensureLoaded,
  downloadModel,
  removeModel,
  loadModel,
  unloadModel,
  discoverEndpoint,
  assertLoopback,
  listModels,
  selectModel,
  resolveModelId,
  chatCompletion,
  chatCompletionStream,
  parseServerSentEvents
};
