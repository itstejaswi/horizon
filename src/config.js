"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const defaultsPath = path.join(rootDir, "config.json");
const localPath = path.join(rootDir, "config.local.json");

function readJsonIfPresent(file, required) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Required configuration file is missing: ${file}`);
    return {};
  }
  try {
    // Windows editors often save JSON with a byte order mark, which is not
    // valid JSON. Strip it rather than failing on the user's behalf.
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not parse ${path.basename(file)}: ${error.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay || {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

function parseCliArgs(argv) {
  const args = {};
  for (const entry of argv) {
    const match = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(entry);
    if (match) args[match[1]] = match[2] === undefined ? "true" : match[2];
  }
  return args;
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

// Resolution order for every setting: CLI argument > environment variable >
// config.local.json > config.json > built-in fallback.
function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const file = merge(readJsonIfPresent(defaultsPath, true), readJsonIfPresent(localPath, false));
  const cli = parseCliArgs(argv);

  const config = {
    rootDir,
    publicDir: path.join(rootDir, "public"),
    app: {
      name: file.app?.name || "horizon",
      displayName: firstDefined(cli["display-name"], env.HORIZON_DISPLAY_NAME, file.app?.displayName, file.app?.name, "Horizon"),
      tagline: firstDefined(env.HORIZON_TAGLINE, file.app?.tagline, "Your models, running on your machine"),
      author: firstDefined(env.HORIZON_AUTHOR, file.app?.author, null),
      // Where the About page's feedback buttons point. Null hides them
      // entirely, so a fork with no contact page shows no dead link.
      contactUrl: firstDefined(env.HORIZON_CONTACT_URL, file.app?.contactUrl, null)
    },
    web: {
      host: firstDefined(cli.host, env.HORIZON_HOST, file.web?.host, "127.0.0.1"),
      port: toInt(firstDefined(cli.port, env.HORIZON_PORT, file.web?.port), 3000),
      portSearchLimit: toInt(firstDefined(cli["port-search-limit"], env.HORIZON_PORT_SEARCH_LIMIT, file.web?.portSearchLimit), 20),
      openBrowser: toBool(firstDefined(cli["open-browser"], env.HORIZON_OPEN_BROWSER, file.web?.openBrowser), true),
      // Launching twice normally means the user double-clicked the shortcut
      // again, so the second launch hands over to the first. Set this to run
      // deliberate parallel instances (the test suite does).
      allowMultipleInstances: toBool(firstDefined(cli["allow-multiple-instances"], env.HORIZON_ALLOW_MULTIPLE_INSTANCES, file.web?.allowMultipleInstances), false)
    },
    model: {
      alias: firstDefined(cli["model-alias"], env.HORIZON_MODEL_ALIAS, file.model?.alias, "phi-4"),
      id: firstDefined(cli["model-id"], env.FOUNDRY_MODEL_ID) || null
    },
    foundry: {
      baseUrl: firstDefined(cli["foundry-base-url"], env.FOUNDRY_BASE_URL) || null,
      apiPrefix: firstDefined(env.HORIZON_API_PREFIX, file.foundry?.apiPrefix, "/v1"),
      requestTimeoutMs: toInt(firstDefined(cli["request-timeout-ms"], env.HORIZON_REQUEST_TIMEOUT_MS, file.foundry?.requestTimeoutMs), 120000),
      statusTimeoutMs: toInt(firstDefined(env.HORIZON_STATUS_TIMEOUT_MS, file.foundry?.statusTimeoutMs), 5000),
      statusCacheMs: toInt(firstDefined(env.HORIZON_STATUS_CACHE_MS, file.foundry?.statusCacheMs), 3000),
      warmUpOnStart: toBool(firstDefined(env.HORIZON_WARM_UP, file.foundry?.warmUpOnStart), true),
      warmUpTimeoutMs: toInt(firstDefined(env.HORIZON_WARM_UP_TIMEOUT_MS, file.foundry?.warmUpTimeoutMs), 300000),
      // Models stay resident in the Foundry daemon after Horizon exits, so
      // by default the one we loaded is released on shutdown.
      unloadOnExit: toBool(firstDefined(cli["unload-on-exit"], env.HORIZON_UNLOAD_ON_EXIT, file.foundry?.unloadOnExit), true),
      stopServiceOnExit: toBool(firstDefined(cli["stop-service-on-exit"], env.HORIZON_STOP_SERVICE_ON_EXIT, file.foundry?.stopServiceOnExit), false)
    },
    chat: {
      systemPrompt: firstDefined(env.HORIZON_SYSTEM_PROMPT, file.chat?.systemPrompt, "You are a helpful, concise local assistant."),
      historyLimit: toInt(firstDefined(env.HORIZON_HISTORY_LIMIT, file.chat?.historyLimit), 30),
      maxMessageChars: toInt(firstDefined(env.HORIZON_MAX_MESSAGE_CHARS, file.chat?.maxMessageChars), 20000),
      maxRequestBytes: toInt(firstDefined(env.HORIZON_MAX_REQUEST_BYTES, file.chat?.maxRequestBytes), 1000000),
      temperature: toFloat(firstDefined(cli.temperature, env.HORIZON_TEMPERATURE, file.chat?.temperature), 0.7),
      stream: toBool(firstDefined(cli.stream, env.HORIZON_STREAM, file.chat?.stream), true)
    },
    runtime: {
      // Overridable so parallel instances (and the test suite) can keep their
      // own state file instead of overwriting each other's.
      directory: path.resolve(rootDir, firstDefined(env.HORIZON_RUNTIME_DIR, file.runtime?.directory, ".runtime")),
      stateFile: firstDefined(env.HORIZON_STATE_FILE, file.runtime?.stateFile, "horizon.json")
    },
    backup: {
      // Off by default and deliberately so: writing conversations to disk is a
      // bigger commitment than keeping them in the browser, and it should be
      // the user's decision rather than ours.
      enabled: toBool(firstDefined(env.HORIZON_BACKUP, file.backup?.enabled), false),
      directory: firstDefined(env.HORIZON_BACKUP_DIR, file.backup?.directory) || null
    },
    reader: {
      // The one part of Horizon that leaves this machine, so it is off unless
      // asked for. When on, Horizon fetches a pasted page and hands the real
      // text to the model instead of letting it guess from the address.
      enabled: toBool(firstDefined(env.HORIZON_READ_LINKS, file.reader?.enabled), false),
      maxChars: toInt(firstDefined(env.HORIZON_READ_MAX_CHARS, file.reader?.maxChars), 12000)
    },
    dictation: {
      // Speaking instead of typing. Off unless asked for, because it opens the
      // microphone and holds a second model in memory.
      enabled: toBool(firstDefined(env.HORIZON_DICTATION, file.dictation?.enabled), false),
      alias: firstDefined(env.HORIZON_DICTATION_MODEL, file.dictation?.alias, "nemotron-speech-streaming-en-0.6b"),
      // A recording that is never stopped would hold the microphone open for as
      // long as the page is left alone, so there is an upper bound on one take.
      maxRecordingMs: toInt(firstDefined(env.HORIZON_DICTATION_MAX_MS, file.dictation?.maxRecordingMs), 300000),
      // How long an unused session stays loaded before it releases the model.
      idleTimeoutMs: toInt(firstDefined(env.HORIZON_DICTATION_IDLE_MS, file.dictation?.idleTimeoutMs), 300000)
    }
  };

  if (config.web.port < 0 || config.web.port > 65535) {
    throw new Error(`Invalid web port: ${config.web.port}. Use 0 for an automatically assigned port.`);
  }

  // The alias reaches the Foundry command line, so it is checked here rather
  // than trusted from a file that a user may have edited by hand.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(config.dictation.alias)) {
    throw new Error(`Invalid dictation model alias: ${config.dictation.alias}`);
  }

  // One minute is long enough to be useful; thirty is long enough that the user
  // has clearly chosen it. Outside that range the value is almost certainly a
  // mistake, and a wrong value here means a microphone left open.
  const idleMs = config.dictation.idleTimeoutMs;
  if (idleMs < 60000 || idleMs > 1800000) {
    throw new Error(`Invalid dictation idle timeout: ${idleMs} ms. Use 60000 to 1800000 (1 to 30 minutes).`);
  }

  if (config.dictation.maxRecordingMs < 5000 || config.dictation.maxRecordingMs > 1800000) {
    throw new Error(`Invalid dictation recording limit: ${config.dictation.maxRecordingMs} ms. Use 5000 to 1800000.`);
  }

  return config;
}

// Persists a user choice into config.local.json, which sits above config.json
// in the resolution order and is not tracked by git. Only the keys given are
// touched, so hand-edited settings survive.
function saveLocalSettings(patch) {
  const existing = readJsonIfPresent(localPath, false);
  const merged = merge(existing, patch);
  // No BOM: the parser tolerates one, but writing a clean file is better.
  fs.writeFileSync(localPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

module.exports = { loadConfig, saveLocalSettings, rootDir, defaultsPath, localPath };
