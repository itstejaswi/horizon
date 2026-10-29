"use strict";
/*
 * Local regression suite.
 *
 *   npm test
 *
 * Runs entirely on this machine against a stub Ollama, so it needs no model,
 * no GPU and no network. It covers the parts that have actually broken during
 * development: config resolution, port fallback, path traversal, command
 * injection, streaming, and honest readiness reporting.
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------- stub ollama -- */

function startStubOllama() {
  const calls = [];
  const resident = new Set();
  const models = [{ name: "stub-model", size: 1024, details: {} }];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      const json = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
        res.end(data);
      };

      if (req.method === "GET" && url === "/api/version") return json(200, { version: "0.6.1" });
      if (req.method === "GET" && url === "/api/tags") return json(200, { models });
      if (req.method === "GET" && url === "/api/ps") {
        return json(200, { models: [...resident].map(name => ({ name, size_vram: 0 })) });
      }
      if (req.method === "GET" && url === "/v1/models") {
        return json(200, { data: models.map(model => ({ id: model.name })) });
      }

      if (req.method === "POST" && url === "/api/generate") {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        return req.on("end", () => {
          const body = JSON.parse(raw || "{}");
          calls.push({ method: req.method, url, body });
          if (!models.some(model => model.name === body.model)) return json(404, { error: "model not found" });
          if (body.keep_alive === 0) resident.delete(body.model);
          else resident.add(body.model);
          return json(200, { model: body.model, response: "", done: true });
        });
      }

      if (req.method === "POST" && url === "/v1/chat/completions") {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        return req.on("end", () => {
          const body = JSON.parse(raw || "{}");
          calls.push({ method: req.method, url, body });
          if (!models.some(model => model.name === body.model)) return json(404, { error: "model not found" });
          resident.add(body.model);

          if (!body.stream) {
            return json(200, {
              model: body.model,
              choices: [{ message: { role: "assistant", content: "stub reply" } }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
            });
          }

          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const piece of ["stub ", "streamed ", "reply"]) {
            res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop" }], usage: { completion_tokens: 3 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        });
      }

      json(404, { error: "stub: not found" });
    });

    server.listen(0, "127.0.0.1", () => resolve({ server, calls, resident, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- helpers -- */

function startApp(env) {
  return new Promise((resolve, reject) => {
    const isolatedRuntime = env.HORIZON_RUNTIME_DIR ? null : fs.mkdtempSync(path.join(os.tmpdir(), "horizon-regression-"));
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
      env: { ...process.env, ...env, HORIZON_RUNTIME_DIR: env.HORIZON_RUNTIME_DIR || isolatedRuntime },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    let settled = false;
    // Generous, because the suite starts several servers and the machine may
    // also be busy downloading a model. A slow start is not a failure.
    const timer = setTimeout(() => reject(new Error(`server did not start\n${out}`)), 60000);

    const finish = () => {
      const match = /Open:\s+(http:\/\/127\.0\.0\.1:(\d+))/.exec(out);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, url: match[1], port: Number(match[2]), output: () => out, runtimeDirectory: env.HORIZON_RUNTIME_DIR || isolatedRuntime });
    };

    // The banner arrives across several writes, so wait for the whole block
    // rather than resolving on the first chunk that happens to contain the URL.
    child.stdout.on("data", chunk => {
      out += chunk;
      if (/Press Ctrl\+C to stop/.test(out)) finish();
    });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("exit", code => {
      clearTimeout(timer);
      if (isolatedRuntime) fs.rmSync(isolatedRuntime, { recursive: true, force: true });
      if (!settled) reject(new Error(`server exited (${code})\n${out}`));
    });
  });
}

async function stop(app) {
  if (!app?.child) return;
  app.child.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
}

const request = (url, options = {}) => fetch(url, options);

const stubEnv = port => ({
  HORIZON_PROVIDER: "ollama",
  HORIZON_OLLAMA_URL: `http://127.0.0.1:${port}`,
  HORIZON_MODEL_ID: "stub-model",
  HORIZON_MODEL_ALIAS: "stub-model",
  HORIZON_OLLAMA_AUTOSTART: "false",
  HORIZON_PORT: "0",
  HORIZON_OPEN_BROWSER: "false",
  HORIZON_WARM_UP: "false",
  // Several tests deliberately run servers side by side, which the
  // single-instance guard would otherwise hand over. The guard has its own
  // test below, where this is left off.
  HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
});

/* ------------------------------------------------------------------ tests -- */

test("config: resolution order and validation", t => {
  const { loadConfig, localPath } = require(path.join(ROOT, "src", "config.js"));
  const existsSync = fs.existsSync;
  t.mock.method(fs, "existsSync", file => file === localPath ? false : existsSync(file));

  const base = loadConfig([], {});
  assert.equal(base.provider, "ollama");
  assert.equal("foundry" in base, false, "removed runtime settings must not be exposed");
  assert.equal("dictation" in base, false, "removed microphone settings must not be exposed");
  assert.equal(base.web.host, "127.0.0.1", "must default to loopback");
  assert.ok(base.web.port > 0, "must have a stable default port");

  const viaEnv = loadConfig([], { HORIZON_PORT: "4321" });
  assert.equal(viaEnv.web.port, 4321, "environment must override the file");

  const viaCli = loadConfig(["--port=8765"], { HORIZON_PORT: "4321" });
  assert.equal(viaCli.web.port, 8765, "CLI must override the environment");

  const runtime = loadConfig(["--ollama-url=http://127.0.0.1:12345", "--request-timeout-ms=9000"], {
    HORIZON_OLLAMA_URL: "http://127.0.0.1:23456",
    HORIZON_REQUEST_TIMEOUT_MS: "8000",
    HORIZON_STATUS_TIMEOUT_MS: "700",
    HORIZON_STATUS_CACHE_MS: "100",
    HORIZON_WARM_UP_TIMEOUT_MS: "11000",
    HORIZON_MODEL_ID: "stub-model"
  });
  assert.equal(runtime.ollama.baseUrl, "http://127.0.0.1:12345");
  assert.equal(runtime.inference.requestTimeoutMs, 9000);
  assert.equal(runtime.inference.statusTimeoutMs, 700);
  assert.equal(runtime.inference.statusCacheMs, 100);
  assert.equal(runtime.inference.warmUpTimeoutMs, 11000);
  assert.equal(runtime.model.id, "stub-model");
  const runtimeViaEnv = loadConfig([], {
    HORIZON_OLLAMA_URL: "http://127.0.0.1:23456",
    HORIZON_REQUEST_TIMEOUT_MS: "8000"
  });
  assert.equal(runtimeViaEnv.ollama.baseUrl, "http://127.0.0.1:23456");
  assert.equal(runtimeViaEnv.inference.requestTimeoutMs, 8000);

  assert.throws(() => loadConfig(["--port=999999"], {}), /Invalid web port/);
});

// The contact URL took an edit in two files to work: config.json alone was not
// enough, because loadConfig builds "app" from an explicit whitelist and
// silently drops unknown keys. This test fails if that whitelist is trimmed.
test("config: contact URL reaches the client, and is optional", () => {
  const { loadConfig } = require(path.join(ROOT, "src", "config.js"));

  const base = loadConfig([], {});
  assert.ok("contactUrl" in base.app, "app.contactUrl must survive config loading");

  const viaEnv = loadConfig([], { HORIZON_CONTACT_URL: "https://example.test/contact" });
  assert.equal(viaEnv.app.contactUrl, "https://example.test/contact",
    "environment must be able to set the contact URL");
});

// The feedback buttons must stay gated on a contact URL, or a fork with
// no contact page ships a dead link.
test("about: gated feedback survives runtime branding removal", () => {
  const client = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(client, /const contactUrl = state\.app\?\.contactUrl;\s*\n\s*if \(contactUrl\)/,
    "feedback must render only when a contact URL is configured");
  for (const glyph of ["i-thumb-up", "i-thumb-down"]) {
    assert.ok(client.includes(glyph), `${glyph} must be used by the feedback buttons`);
  }

  // Both glyphs must actually exist in the built sprite, or the buttons render
  // empty squares.
  const built = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const glyph of ["i-thumb-up", "i-thumb-down"]) {
    assert.ok(built.includes(`<symbol id="${glyph}"`), `${glyph} must be in the built sprite`);
  }
});

test("net: loopback detection", () => {
  const { isLoopbackHost } = require(path.join(ROOT, "src", "net.js"));
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "example.com"]) {
    assert.equal(isLoopbackHost(host), false, `${host} is not loopback`);
  }
});

test("ollama: rejects unsafe model aliases", () => {
  const { isSafeAlias } = require(path.join(ROOT, "src", "ollama.js"));
  for (const bad of ["phi-4; calc.exe", "a && whoami", "../../etc", "a|b", "$(id)", "`id`", "", "a b"]) {
    assert.equal(isSafeAlias(bad), false, `must reject: ${bad}`);
  }
  for (const good of ["phi4-mini", "qwen2.5-coder:1.5b", "hf.co/example/model:Q4_K_M"]) {
    assert.equal(isSafeAlias(good), true, `must accept: ${good}`);
  }
});

// Installed models and resident models are separate states in Ollama.
test("ollama: catalogue takes load state from the resident listing", () => {
  const { createOllama } = require(path.join(ROOT, "src", "ollama.js"));
  const ollama = createOllama({});

  const catalogueModels = [
    { alias: "phi4-mini:latest", cached: true, loaded: false },
    { alias: "qwen3:1.7b", cached: true, loaded: false },
    { alias: "gpt-oss:20b", cached: false, loaded: false }
  ];
  const cacheModels = [
    { alias: "phi4-mini:latest", loaded: false },
    { alias: "qwen3:1.7b", loaded: true }
  ];

  const merged = ollama.mergeLoadState(catalogueModels, cacheModels);
  const byAlias = Object.fromEntries(merged.map(model => [model.alias, model]));

  assert.equal(byAlias["qwen3:1.7b"].loaded, true, "a resident model must read as loaded");
  assert.equal(byAlias["phi4-mini:latest"].loaded, false, "a downloaded but unloaded model must not read as loaded");
  assert.equal(byAlias["gpt-oss:20b"].loaded, false, "an absent model must not read as loaded");
  assert.equal(byAlias["phi4-mini:latest"].cached, true, "merging must not disturb the other fields");

  assert.deepEqual(
    ollama.mergeLoadState(catalogueModels, []).map(model => model.loaded),
    [false, false, false],
    "with no cache listing nothing should claim to be loaded"
  );
});

test("client: parses server-sent events and stops at [DONE]", async () => {
  const { parseServerSentEvents } = require(path.join(ROOT, "src", "openai-client.js"));
  const body = [
    'data: {"choices":[{"delta":{"content":"a"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"b"}}]}',
    "",
    "data: [DONE]",
    "",
    'data: {"choices":[{"delta":{"content":"never"}}]}',
    ""
  ].join("\n");

  const seen = [];
  for await (const event of parseServerSentEvents({ body: [Buffer.from(body)] })) {
    seen.push(event.choices[0].delta.content);
  }
  assert.deepEqual(seen, ["a", "b"], "must stop at [DONE]");
});

test("server: starts without Ollama and reports it honestly", async t => {
  const stub = await startStubOllama();
  await new Promise(resolve => stub.server.close(resolve));
  const app = await startApp({
    ...stubEnv(stub.port),
    HORIZON_PORT: "0",
    HORIZON_OPEN_BROWSER: "false",
    HORIZON_WARM_UP: "false",
    // Without this the single-instance guard hands over to any Horizon already
    // running on the machine, and the test sees a clean exit instead of a
    // server. That is what made this suite fail intermittently during
    // development, while passing whenever nothing else was running.
    HORIZON_ALLOW_MULTIPLE_INSTANCES: "true",
    PATH: path.join(__dirname, "no-ollama")
  });
  t.after(() => stop(app));

  assert.equal((await request(`${app.url}/`)).status, 200, "page must serve with no Ollama");

  const status = await (await request(`${app.url}/api/status`)).json();
  assert.equal(status.ready, false, "must not claim to be ready");

  const chat = await request(`${app.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(chat.status, 503, "chat must refuse cleanly rather than hang");
});

// The app fills the window exactly once: a header row above a rail+content
// row. If a flex child forgets min-height:0 it refuses to shrink, and the
// composer gets pushed off the bottom of the screen instead of the thread
// scrolling. That is invisible to a unit test, so assert the rules directly.
test("ui: the shell cannot overflow the window", () => {
  // Comments are stripped first: they discuss the very properties being
  // asserted, and would otherwise match as if they were declarations.
  const css = fs.readFileSync(path.join(ROOT, "public", "app.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // A selector may be declared in more than one rule; the effective style is
  // the union of them, so collect every block rather than only the first.
  const rule = name => {
    const blocks = [...css.matchAll(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, "g"))]
      .map(match => match[1]);
    assert.ok(blocks.length, `.${name} must exist`);
    return blocks.join(" ");
  };

  // Exactly one element is pinned to the viewport height.
  const pinned = css.match(/height:\s*100dvh/g) || [];
  assert.equal(pinned.length, 1, "only one element may be pinned to the viewport height");
  assert.match(rule("app-shell"), /height:\s*100dvh/, "the shell is what fills the window");

  // Every flex ancestor between the shell and the scrolling thread must be
  // allowed to shrink below its content.
  for (const name of ["app-grid", "main", "thread"]) {
    assert.match(rule(name), /min-height:\s*0/, `.${name} needs min-height: 0 to shrink`);
  }

  assert.match(rule("thread"), /overflow-y:\s*auto/, "the thread is the scrolling region");
  assert.match(rule("topbar"), /min-width:\s*0/, "the header must not force the window wider");
  assert.match(rule("main"), /min-width:\s*0/, "content must not force the window wider");

  // The model picker drops out of the header. Clipping the header therefore
  // swallows the entire menu, which looked exactly like "the picker is broken"
  // -- the menu was in the DOM and not hidden, just invisible.
  assert.doesNotMatch(rule("topbar"), /overflow:\s*hidden/,
    "the header must not clip: the model picker menu overflows it by design");

  // A fixed min-width on a header control would push the window wider on a
  // small screen; it must be allowed to give way instead.
  assert.doesNotMatch(rule("picker-btn"), /min-width:\s*[1-9]/, "the model picker must be shrinkable");

  // dvh alone is not trustworthy: a browser can report the dynamic viewport
  // before its own chrome has settled, which made the shell 978px tall inside
  // a 950px window until something forced a resize. The measured height must
  // therefore override it, and something must actually do the measuring.
  assert.match(rule("app-shell"), /height:\s*var\(--app-height/,
    "the shell must prefer the measured height over dvh");

  const js = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.match(js, /setProperty\(\s*"--app-height"/, "something must measure the real viewport height");
  assert.match(js, /addEventListener\("resize",\s*syncAppHeight\)/, "the height must be re-measured on resize");
});

// Preferences and saved data must survive a reload, and a rename of the app
// must not orphan them. Exercised here against a minimal localStorage stand-in
// so the rules are pinned without needing a browser.
test("store: preferences and data persist, and legacy data migrates", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "store.js"), "utf8");

  // Real localStorage exposes its keys as own enumerable properties, which is
  // what Object.keys() relies on. A plain object with methods does not, so the
  // stand-in is a Proxy that behaves the same way.
  const makeStorage = (seed = {}) => {
    const map = new Map(Object.entries(seed));
    const api = {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)); },
      removeItem: key => { map.delete(key); },
      key: index => [...map.keys()][index]
    };

    return new Proxy(api, {
      get: (target, prop) => {
        if (prop === "length") return map.size;
        if (prop in target) return target[prop];
        return map.get(prop);
      },
      has: (target, prop) => prop in target || map.has(prop),
      ownKeys: () => [...map.keys()],
      getOwnPropertyDescriptor: (target, prop) => (
        map.has(prop)
          ? { value: map.get(prop), enumerable: true, configurable: true }
          : Object.getOwnPropertyDescriptor(target, prop)
      )
    });
  };

  // store.js is browser code; give it just enough of a window to load.
  const load = storage => {
    const context = { localStorage: storage, window: {} };
    context.Object = Object;
    new Function("localStorage", "window", `${source}\nreturn window.HorizonStore;`)
      .call(null, storage, context.window);
    return context.window.HorizonStore;
  };

  // 1. Defaults, including dark as the shipped theme.
  const fresh = makeStorage();
  const store = load(fresh);
  assert.equal(store.prefs().theme, "dark", "dark is the default theme");

  // 2. A saved preference is written under the current namespace and read back.
  store.setPref("temperature", 1.4);
  store.setPref("systemPrompt", "Be terse.");
  assert.equal(store.prefs().temperature, 1.4, "temperature must persist");
  assert.equal(store.prefs().systemPrompt, "Be terse.", "the system prompt must persist");
  assert.ok(fresh.getItem("horizon.v1.prefs"), "preferences are stored under the horizon namespace");

  // 3. Clearing an override removes the key entirely, so the app falls back to
  //    the server's default rather than pinning a stale copy of it.
  store.setPref("temperature", null);
  assert.equal("temperature" in store.prefs(), false, "clearing must delete the key, not store null");

  // 4. Data saved before the rename is carried across, and never overwrites
  //    anything already saved under the new name.
  const legacy = makeStorage({
    "localmind.v1.chats": JSON.stringify([{ id: "c1", title: "Old chat" }]),
    "localmind.v1.prefs": JSON.stringify({ theme: "light" })
  });
  const migrated = load(legacy);
  assert.equal(legacy.getItem("localmind.v1.chats"), null, "legacy keys are removed after moving");
  assert.equal(migrated.chats()[0].title, "Old chat", "chats survive the rename");
  assert.equal(migrated.prefs().theme, "light", "preferences survive the rename");
});

// The Settings panel tells the user they can install Horizon as an app. That
// claim is only true if the page actually ships an installable manifest, and
// Windows will not use an SVG for a taskbar icon, so real PNGs are required.
test("ui: the page is installable as an app", () => {
  const manifestPath = path.join(ROOT, "public", "manifest.webmanifest");
  assert.ok(fs.existsSync(manifestPath), "a web app manifest must exist");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.display, "standalone", "an installed app needs its own window");
  assert.ok(manifest.name, "the app needs a name");
  assert.ok(manifest.start_url, "the app needs a start URL");

  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes("192x192"), "192px icon is required for installability");
  assert.ok(sizes.includes("512x512"), "512px icon is required for installability");
  assert.ok(manifest.icons.some(icon => icon.purpose === "maskable"),
    "a maskable icon keeps the mark intact when the platform crops it");

  for (const icon of manifest.icons) {
    const file = path.join(ROOT, "public", icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `${icon.src} must exist`);
  }

  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /rel="manifest"/, "the page must link its manifest");

  // A manifest the browser cannot fetch is the same as no manifest at all.
  const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
  assert.match(server, /manifest-src 'self'/, "the CSP must allow the manifest");
  assert.match(server, /\.webmanifest/, "the server must serve the manifest media type");
});

// Memory is not read by the model from anywhere -- it is injected as text into
// the system prompt on every message. That is worth pinning: if this quietly
// stopped, the app would still work and simply forget everything.
test("ui: the composer hint stays neutral when model status changes", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const assignments = [...app.matchAll(/ui\.prompt\.placeholder\s*=\s*([^;]+);/g)];
  assert.ok(assignments.length > 0);
  for (const assignment of assignments) assert.equal(assignment[1], '"Send a message"');
});

test("store: memory and preferences reach the model as a system prompt", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const build = /function buildSystemPrompt\(\)\s*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(build, "buildSystemPrompt must exist");

  assert.match(build[1], /state\.settings\.systemPrompt/, "the user's instructions must be included");
  assert.match(build[1], /db\.memory\(\)/, "memory must be read when building the prompt");
  assert.match(build[1], /memory\.enabled/, "memory switched off must not be sent");
  assert.match(build[1], /fact\.text/, "the facts themselves must be included");

  // And the result must actually be sent as the system message.
  assert.match(source, /role:\s*"system",\s*content:\s*buildSystemPrompt\(\)/,
    "the built prompt must be sent as the system message");
});

// Everything the user creates lives in the browser, which is private but
// fragile. The copy on disk is what makes it survivable, so what it captures
// matters: a backup missing prompts or preferences is a surprise, not a backup.
test("store: a backup captures everything the user created", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "store.js"), "utf8");
  const exported = /exportAll\(\)\s*\{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(exported, "exportAll must exist");

  for (const key of ["chats", "prompts", "memory", "library", "prefs"]) {
    assert.match(exported[1], new RegExp(`${key}:`), `a backup must include ${key}`);
  }

  // Every kind the store persists must appear in the export; a new key added
  // later without updating exportAll would silently not be backed up.
  const persisted = [...source.matchAll(/read\("(\w+)"/g)].map(match => match[1]);
  for (const key of new Set(persisted)) {
    assert.match(exported[1], new RegExp(`${key}:`), `${key} is persisted but missing from the backup`);
  }
});

// A model cannot open a link -- it reads the words in the address and writes
// plausible prose around them. Tested with an invented Reuters URL, phi-4
// produced a detailed summary of an event that never happened, and invented a
// birthplace and degrees for a real public official. The warning is the only
// thing standing between that and a confident fabrication, so it is pinned.
test("ui: pasting a link warns that the model cannot read it", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  const pattern = /const URL_PATTERN = (\/.*\/[a-z]*);/.exec(source);
  assert.ok(pattern, "a URL pattern must exist");

  // Rebuilt here rather than trusted, so the assertions test real behaviour.
  const match = /^\/(.*)\/([a-z]*)$/.exec(pattern[1]);
  const regex = new RegExp(match[1], match[2]);

  for (const text of [
    "summarise https://www.thehindu.com/news/article71349308.ece",
    "check http://example.com",
    "look at www.reuters.com/business please"
  ]) {
    assert.ok(regex.test(text), `must warn about: ${text}`);
  }

  for (const text of [
    "what is the capital of France?",
    "my email is someone@example.com",
    "the ratio is 3://4 apparently"
  ]) {
    assert.equal(regex.test(text), false, `must not warn about: ${text}`);
  }

  assert.match(source, /updateUrlWarning/, "the warning must be wired to the composer");

  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /id="url-warning"/, "the warning element must exist");
  assert.match(html, /can't open links/i, "the warning must say the model cannot open links");
});

// The reader is the one part of Horizon that leaves this machine. A pasted
// link must never be able to reach the machine it was pasted on, or anything
// else on the local network -- that would turn Horizon into a way to probe a
// router admin page, a database bound to localhost, or a cloud metadata
// endpoint. Verified live against all of those; this pins the rules.
test("reader: private and local addresses are refused", () => {
  const reader = require(path.join(ROOT, "src", "reader.js"));

  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.169.254",           // cloud metadata
    "100.64.0.1",                // carrier-grade NAT
    "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
    "224.0.0.1", "not-an-address"
  ]) {
    assert.equal(reader.isPrivateAddress(address), true, `must refuse: ${address}`);
  }

  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111", "172.32.0.1"]) {
    assert.equal(reader.isPrivateAddress(address), false, `must allow: ${address}`);
  }
});

test("reader: strips markup down to readable text", () => {
  const reader = require(path.join(ROOT, "src", "reader.js"));

  const html = `<html><head><title>Test</title><style>body{color:red}</style></head>
    <body><script>alert('x')</script><h1>Heading</h1><p>First &amp; second.</p>
    <p>Third&nbsp;line.</p></body></html>`;

  const text = reader.toText(html);
  assert.match(text, /Heading/, "content must survive");
  assert.match(text, /First & second/, "entities must be decoded");
  assert.doesNotMatch(text, /alert/, "scripts must be removed");
  assert.doesNotMatch(text, /color:red/, "styles must be removed");
  assert.doesNotMatch(text, /</, "no markup may remain");
});

test("server: readiness is not claimed against a stale endpoint", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");

  const probe = /async function probeRuntime\(\)[\s\S]*?\n}/.exec(source);
  assert.ok(probe, "probeRuntime must exist");
  assert.match(probe[0], /await provider\.listModels\(state\.baseUrl, config\.inference\.statusTimeoutMs\)/,
    "readiness must verify models at the current endpoint");
  assert.match(probe[0], /models\.some\(model => model\.id === state\.modelId\)/,
    "the selected model must still be installed");
  assert.match(probe[0], /rediscoverRuntime/,
    "a stale endpoint must trigger rediscovery");
});

test("server: serves assets, blocks traversal, streams a reply", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  for (const [asset, type] of [["/", "text/html"], ["/app.css", "text/css"], ["/app.js", "text/javascript"], ["/store.js", "text/javascript"]]) {
    const response = await request(app.url + asset);
    assert.equal(response.status, 200, `${asset} must be served`);
    assert.match(response.headers.get("content-type"), new RegExp(type));
  }

  const csp = (await request(`${app.url}/`)).headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/, "no inline script or style is allowed");

  assert.equal((await request(`${app.url}/nope.txt`)).status, 404);
  assert.equal((await request(`${app.url}/%2e%2e%2fconfig.json`)).status, 403, "traversal must be blocked");

  assert.equal((await request(`${app.url}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "not json"
  })).status, 400);

  assert.equal((await request(`${app.url}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [] })
  })).status, 400, "a user message is required");

  const streamed = await request(`${app.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  assert.match(streamed.headers.get("content-type") || "", /text\/event-stream/,
    `expected a stream, got ${streamed.status}`);
  const text = await streamed.text();
  assert.match(text, /"delta":"stub "/, "must forward deltas");
  assert.match(text, /"done":true/, "must send a completion frame");

  const plain = await request(`${app.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false })
  });
  assert.equal((await plain.json()).reply, "stub reply");
});

test("server: rejects command injection through the model picker", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  for (const alias of ["phi-4; calc.exe", "a && whoami", "../../etc", "$(id)"]) {
    const response = await request(`${app.url}/api/models/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias })
    });
    assert.equal(response.status, 400, `must reject: ${alias}`);
  }
});

test("server: diagnostics report every hop on loopback", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  const data = await (await request(`${app.url}/api/diagnostics`)).json();
  assert.deepEqual(data.hops.map(hop => hop.id), ["server", "runtime", "model"]);
  assert.equal(data.hops[1].label, "Ollama service");
  assert.equal(data.allLoopback, true, "every hop must be loopback");
});

test("server: refuses a non-loopback Ollama endpoint", async () => {
  await assert.rejects(startApp({
    HORIZON_PROVIDER: "ollama",
    HORIZON_OLLAMA_URL: "http://example.com",
    HORIZON_OLLAMA_AUTOSTART: "false",
    HORIZON_MODEL_ID: "stub-model",
    HORIZON_ALLOW_MULTIPLE_INSTANCES: "true",
    HORIZON_PORT: "0",
    HORIZON_OPEN_BROWSER: "false"
  }), /non-loopback Ollama endpoint/, "must explicitly refuse a remote endpoint, not merely fail startup for another reason");
});

// Launching twice used to start a second server on the next free port AND
// overwrite the state file, after which Stop-Horizon targeted the wrong
// process and left the real one running.
test("server: a second launch hands over to the first", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  // Its own state file, so a Horizon running outside the test suite cannot
  // perturb this and the test cannot disturb it either.
  const runtimeDir = ".runtime-test-instance";
  const isolated = { ...stubEnv(stub.port), HORIZON_RUNTIME_DIR: runtimeDir };
  const stateFile = path.join(ROOT, runtimeDir, "horizon.json");
  t.after(() => fs.rmSync(path.join(ROOT, runtimeDir), { recursive: true, force: true }));

  const first = await startApp(isolated);
  t.after(() => stop(first));

  const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(before.url, first.url, "the running server must own the state file");

  // The guard is on by default, so this launch should defer and exit cleanly.
  const env = { ...isolated };
  delete env.HORIZON_ALLOW_MULTIPLE_INSTANCES;

  const second = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no exit\n${out}`)); }, 20000);
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, out }); });
  });

  assert.equal(second.code, 0, `must exit cleanly, got:\n${second.out}`);
  assert.match(second.out, /already running/i, "must say why it did not start");
  assert.match(second.out, new RegExp(first.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "must point at the instance that is already serving");

  const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(after, before, "the state file must still describe the running server");

  // The original must be untouched and still serving.
  const alive = await request(`${first.url}/api/config`);
  assert.equal(alive.status, 200, "the first instance must still be serving");
});

test("server: falls back when the chosen port is busy", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  const blocker = http.createServer(() => {});
  await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const busy = blocker.address().port;
  t.after(() => blocker.close());

  const app = await startApp({ ...stubEnv(stub.port), HORIZON_PORT: String(busy) });
  t.after(() => stop(app));

  assert.notEqual(app.port, busy, "must not bind the busy port");
  assert.match(app.output(), /was busy/, "must say it moved");
});

// Closing the launcher window is the wrong way out, and the README says so.
// This is the right way: the Exit button and Ctrl+C must both release the
// model before the process goes, and must finish the work rather than racing
// the exit. A shutdown that returns before the unload lands would leave
// gigabytes resident with nothing left running to release them.
test("server: exiting releases the model before the process ends", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  const reply = await request(`${app.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false })
  });
  assert.equal(reply.status, 200);
  assert.equal(stub.resident.has("stub-model"), true, "chat must load the model before shutdown can release it");

  const exited = new Promise(resolve => app.child.on("exit", code => resolve(code)));
  const response = await request(`${app.url}/api/shutdown`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stopService: false })
  });
  assert.equal(response.status, 200, "the exit request must be acknowledged");
  assert.equal((await response.json()).stopping, true, "must confirm it is stopping");

  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("did not exit")), 20000))
  ]);
  assert.equal(code, 0, "must exit cleanly rather than being killed");
  assert.ok(stub.calls.some(call => call.url === "/api/generate" &&
    call.body.model === "stub-model" && call.body.keep_alive === 0),
    "shutdown must unload through the native Ollama API before exiting");
  assert.equal(stub.resident.has("stub-model"), false);

  const out = app.output();
  assert.match(out, /Shutting down/, "must announce the shutdown");
  assert.match(out, /Goodbye/, "must run cleanup through to the end, not exit early");

  // Ordering, not just presence: "Goodbye" is printed after releaseResources
  // resolves, so anything the shutdown does must appear before it.
  assert.ok(out.indexOf("Shutting down") < out.indexOf("Goodbye"),
    "cleanup must complete before the process says it is done");

  // The state file is what a second launch reads to find the first. Leaving it
  // behind would make the next start defer to a server that no longer exists.
  const stateFile = path.resolve(ROOT, app.runtimeDirectory, "horizon.json");
  assert.equal(fs.existsSync(stateFile), false,
    "the runtime state file must be cleared on exit");
});

/* ------------------------------------------------------ removed recording -- */

test("server: dictation endpoints are removed", async t => {
  const stub = await startStubOllama();
  t.after(() => stub.server.close());
  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  for (const endpoint of ["/api/dictation", "/api/dictation/events"]) {
    assert.equal((await request(app.url + endpoint)).status, 404, `${endpoint} must not expose a recording capability`);
  }
  for (const action of ["record", "stop", "nonsense"]) {
    const response = await request(`${app.url}/api/dictation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    assert.equal(response.status, 404, "removed recording actions must not be accepted");
  }
});

test("ui: removed dictation exposes no microphone controls or recording requests", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.doesNotMatch(html, /id="(?:dictate-btn|dictate-icon|dictation-bar|dictation-stop|mic-picker|dictation-device)"/,
    "the page must not offer removed microphone controls");
  assert.doesNotMatch(html, /<symbol\b[^>]*id="i-mic"/, "the removed microphone glyph must not ship");
  assert.doesNotMatch(app, /\/api\/dictation\b|renderDictationSetup|\bgetUserMedia\b|\b(?:webkit)?SpeechRecognition\b/,
    "the client must neither invoke removed endpoints nor substitute browser recording");
});

test("ui: local read-aloud remains wired independently of recording", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const speech = fs.readFileSync(path.join(ROOT, "public", "speech.js"), "utf8");
  assert.match(html, /<script\b[^>]*src="\/speech\.js"/, "the local read-aloud module must still load");
  assert.match(app, /HorizonSpeech\?\.attach\(/, "assistant replies must retain read-aloud controls");
  assert.match(app, /HorizonSpeech\.mountSettings\(/, "local voice settings must remain available");
  assert.match(speech, /voice\.localService === true/, "only verified local voices may read replies");
  assert.doesNotMatch(speech, /\bfetch\s*\(|\/api\/dictation\b|\bgetUserMedia\b/,
    "read-aloud must not use a server speech endpoint or microphone");
});

test("ui: a link is read whatever case it was typed in", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  // The match is case-insensitive, so the scheme test has to be too. It was
  // not: "HTTps://example.com" failed a startsWith("http") check and had a
  // second scheme glued in front of it, producing an address that resolved to
  // nothing recognisable and an error about a certificate for somewhere else.
  assert.match(app, /\/\^https\?:\\\/\\\/\/i\.test\(url\)/,
    "the scheme test must be case-insensitive, like the match that found it");
  assert.ok(!/url\.startsWith\("http"\)/.test(app),
    "a case-sensitive startsWith must not decide whether a scheme is present");

  // A failed read must not hand the model a certificate or DNS dump: it names
  // hosts that have nothing to do with the request, and the model answers
  // about the wrong thing entirely.
  assert.match(app, /Could not be read\. Do not guess at what it says\./,
    "a failed page must be reported plainly to the model");
  assert.ok(!/--- Could not be read: \$\{error\.message\}/.test(app),
    "the raw error must not be pasted into the conversation");
});

test("store: an empty chat is not written down", () => {
  // A localStorage stand-in that behaves like the real one, so Object.keys
  // sees the keys the way the erase path expects.
  class FakeStorage {
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; }
    setItem(k, v) { this[k] = String(v); }
    removeItem(k) { delete this[k]; }
  }
  global.localStorage = new FakeStorage();
  global.window = { localStorage: global.localStorage, addEventListener() {} };

  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(ROOT, "public", "store.js"), "utf8"));
  const db = global.window.HorizonStore;

  // An empty chat is an intention, not a record. Writing one down on every
  // launch left a list of "New chat" entries nobody asked for, and one of them
  // reappeared immediately after erasing everything.
  const chat = db.createChat();
  assert.equal(db.chats().length, 0, "creating a chat must not save an empty one");

  db.createChat();
  db.createChat();
  assert.equal(db.chats().length, 0, "nor must pressing the button repeatedly");

  // The first message earns it a place.
  db.updateChat(chat.id, { turns: [{ role: "user", content: "hello" }] });
  assert.equal(db.chats().length, 1, "a chat with something in it must be kept");
  assert.equal(db.chats()[0].id, chat.id, "and must be the chat that was used");

  // Erasing leaves nothing behind, and starting again creates no orphan.
  db.eraseEverything();
  assert.equal(db.chats().length, 0, "erasing everything must leave nothing");
  db.createChat();
  assert.equal(db.chats().length, 0, "and the next launch must not write one back");

  delete global.localStorage;
  delete global.window;
});

test("ui: choosing a view closes whatever panel was open", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  // A drawer is a panel over the conversation. Leaving it open when the view
  // changed lit two rail buttons at once and hid the chosen view behind a
  // panel the user then had to dismiss by hand.
  const setMode = app.slice(app.indexOf("function setMode(mode)"));
  assert.match(setMode.slice(0, 400), /if \(state\.drawer\) closeDrawer\(\)/,
    "changing view must close an open drawer");

  // And the other way: opening History from Settings used to leave the
  // Settings page behind the panel, so closing it landed you somewhere you
  // had left rather than back in the conversation.
  const openDrawer = app.slice(app.indexOf("function openDrawer(name)"));
  assert.match(openDrawer.slice(0, 400), /if \(state\.mode !== "chat"\) setMode\("chat"\)/,
    "opening a drawer must return to the conversation it sits over");

  // The two call each other, so the guards matter: setMode only closes a
  // drawer that is open, and openDrawer only changes a mode that is not
  // already chat. Without both, they would call back and forth for ever.
  assert.match(setMode.slice(0, 400), /if \(state\.drawer\)/,
    "setMode must only close a drawer that is actually open");
  assert.match(openDrawer.slice(0, 400), /if \(state\.mode !== "chat"\)/,
    "openDrawer must only change a mode that is not already chat");
});

test("chat: a reasoning model's working is separated from its answer", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  const helper = /\/\/ A tag can be cut in half[\s\S]*?\nfunction withoutPartialTag\([\s\S]*?\n\}/.exec(source);
  assert.ok(helper, "withoutPartialTag must exist");
  const split = /function splitThinking\([\s\S]*?\n\}/.exec(source);
  assert.ok(split, "splitThinking must exist");

  const splitThinking = new Function(
    `${helper[0]}\n${split[0]}\nreturn splitThinking;`)();

  // Nothing to separate: an ordinary model's reply passes straight through.
  assert.deepEqual(splitThinking("Just an answer."),
    { thinking: "", answer: "Just an answer." });

  // Qwen3 and friends wrap their working in <think>...</think>, and only the
  // answer belongs in the bubble.
  const done = splitThinking("<think>Compare 9.11 and 9.9.</think>\n\n9.9 is larger.");
  assert.equal(done.thinking, "Compare 9.11 and 9.9.");
  assert.equal(done.answer, "9.9 is larger.");

  // Mid-stream the block has no end yet, so nothing may leak into the answer.
  const open = splitThinking("<think>Still working", true);
  assert.equal(open.answer, "", "an unterminated block must not print as an answer");
  assert.equal(open.thinking, "Still working");

  // The reveal advances a few characters at a time, so it can land inside a
  // tag. A half-written tag was printed, then taken away again: visible junk.
  for (const cut of ["<", "<t", "<th", "<thi", "<thin", "<think"]) {
    assert.equal(splitThinking(cut, true).answer, "",
      `a partial opening tag (${cut}) must not be shown`);
  }
  for (let n = 1; n < "</think>".length; n++) {
    const partial = splitThinking("<think>Working" + "</think>".slice(0, n), true);
    assert.equal(partial.thinking, "Working",
      "a partial closing tag must not be shown as reasoning");
  }

  // Once the reply is complete a trailing "<" is just a character.
  assert.equal(splitThinking("3 < 4").answer, "3 < 4");
  assert.equal(splitThinking("ends with <").answer, "ends with <");
});

test("chat: reasoning says how long it took, and survives a reload", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  const label = /function thinkingLabel\([\s\S]*?\n\}/.exec(source);
  assert.ok(label, "thinkingLabel must exist");
  const thinkingLabel = new Function(`${label[0]}\nreturn thinkingLabel;`)();

  // Present tense only while it is actually happening.
  assert.equal(thinkingLabel(null), "Working it out");
  assert.equal(thinkingLabel(undefined), "Working it out");
  // A fast model can open and close its reasoning inside a single chunk, so
  // zero is a real measurement. Treating it as "no measurement" left a finished
  // reply claiming to still be working.
  assert.equal(thinkingLabel(0), "Thought for 0.0s");
  assert.equal(thinkingLabel(8200), "Thought for 8.2s");
  assert.equal(thinkingLabel(45000), "Thought for 45s");
  // Rolls over to minutes rather than counting to "125s", which nobody reads
  // as two minutes. A small model on modest hardware does reach that long.
  assert.equal(thinkingLabel(125000), "Thought for 2m 5s");

  // Timed from arrival, not from the reveal, which lags on purpose.
  assert.match(source, /thoughtStartedAt === null && full\.includes\("<think>"\)/,
    "the clock must start when the opening tag arrives");
  assert.match(source, /full\.includes\("<\/think>"\)/,
    "the clock must stop when the closing tag arrives");

  // A reloaded chat must not claim to still be working.
  assert.match(source, /thoughtMs === null \? \{\} : \{ thoughtMs: Math\.round\(thoughtMs\) \}/,
    "the duration must be stored whenever it was measured, including zero");
  assert.match(source, /thinkingLabel\(turn\.thoughtMs \?\? 0\)/,
    "a replayed turn must use its stored duration, and never claim to still be working");

  // The orbit stops at the closing tag, not at the answer's first character:
  // otherwise it spins through the gap between the two.
  assert.match(source, /const closed = visible\.includes\("<\/think>"\)/,
    "the live state must be driven by the closing tag");

  // Painting runs every frame while the answer reveals. Collapsing on each
  // pass shut the box again a moment after a reader opened it to look.
  assert.ok(!source.includes("collapsedOnce"),
    "streaming must never override the reader's expansion choice");
  assert.match(source, /thinkingBox\.open = false/,
    "reasoning starts compact");
  assert.ok(!/if \(closed && thinkingBox\.open\)/.test(source),
    "nothing may re-close a box the reader has opened");
});

test("chat: a model's headings and rules are shown as structure, not as text", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  const block = /\/\/ Models structure long answers[\s\S]*?\nfunction appendBlocks\([\s\S]*?\n\}/.exec(source);
  assert.ok(block, "appendBlocks must exist");

  // No DOM here, so the smallest stand-ins that let the real parsing run. What
  // is under test is which lines become structure, not how they are appended.
  const harness = `
    const out = [];
    const el = (tag, cls) => ({ tag, cls, text: "", append() {} });
    const appendInline = (node, text) => {
      if (node.tag) { node.text = text; return; }
      out.push({ tag: "text", text });
    };
    const container = { append: node => out.push(node) };
    ${block[0]}
    return text => { out.length = 0; appendBlocks(container, text); return out; };
  `;
  const run = new Function(harness)();

  // Headings become headings, and keep their own emphasis.
  const heads = run("### Step 1\ntext here\n#### Deeper");
  assert.equal(heads[0].tag, "h4", "### sits inside a message, so it is capped");
  assert.equal(heads[0].text, "Step 1", "the hashes must not be printed");
  assert.equal(heads[1].tag, "text");
  assert.equal(heads[2].tag, "h4");

  // A single hash is still a heading, but never outranks the page around it.
  assert.equal(run("# Title")[0].tag, "h3");
  assert.equal(run("## Title")[0].tag, "h4");

  // Three or more dashes alone on a line is a divider.
  for (const rule of ["---", "----", "***", "___", "  ---  "]) {
    const parts = run(`before\n${rule}\nafter`);
    assert.ok(parts.some(p => p.tag === "hr"), `${JSON.stringify(rule)} must be a rule`);
  }

  // Punctuation and prose must survive untouched: a model writes far more
  // dashes and hashes than it does structure.
  for (const plain of ["a - b", "--", "well -- maybe", "C# is a language", "#1 pick", "3 - 2 = 1"]) {
    const parts = run(plain);
    assert.ok(!parts.some(p => p.tag === "hr" || String(p.tag).startsWith("h")),
      `${JSON.stringify(plain)} is prose, not structure`);
  }

  // Consecutive prose lines stay one run, so paragraphs are not broken up.
  const prose = run("one\ntwo\nthree");
  assert.equal(prose.length, 1, "unbroken prose must not be split into pieces");
  assert.equal(prose[0].text, "one\ntwo\nthree");

  // The cheap path skips all of this, so it must not skip text that needs it.
  const fast = /if \(!\/\[`\*#\]\/\.test\(value\) && !value\.includes\("---"\)\)/.exec(source);
  assert.ok(fast, "the fast path must also rule out headings and rules");
});
