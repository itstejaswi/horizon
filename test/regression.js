"use strict";
/*
 * Local regression suite.
 *
 *   npm test
 *
 * Runs entirely on this machine against a stub Foundry, so it needs no model,
 * no GPU and no network. It covers the parts that have actually broken during
 * development: config resolution, port fallback, path traversal, command
 * injection, streaming, and honest readiness reporting.
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------ stub foundry -- */

function startStubFoundry() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "").split("?")[0];
      const json = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
        res.end(data);
      };

      if (req.method === "GET" && url === "/v1/models") {
        return json(200, { data: [{ id: "stub-model", parent: "stub" }] });
      }

      if (req.method === "POST" && url === "/v1/chat/completions") {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        return req.on("end", () => {
          const body = JSON.parse(raw || "{}");

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

    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------------- helpers -- */

function startApp(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
      env: { ...process.env, ...env },
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
      resolve({ child, url: match[1], port: Number(match[2]), output: () => out });
    };

    // The banner arrives across several writes, so wait for the whole block
    // rather than resolving on the first chunk that happens to contain the URL.
    child.stdout.on("data", chunk => {
      out += chunk;
      if (/Press Ctrl\+C to stop/.test(out)) finish();
    });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("exit", code => { clearTimeout(timer); if (!settled) reject(new Error(`server exited (${code})\n${out}`)); });
  });
}

async function stop(app) {
  if (!app?.child) return;
  app.child.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
}

const request = (url, options = {}) => fetch(url, options);

const stubEnv = port => ({
  FOUNDRY_BASE_URL: `http://127.0.0.1:${port}/v1`,
  FOUNDRY_MODEL_ID: "stub-model",
  HORIZON_MODEL_ALIAS: "stub",
  HORIZON_PORT: "0",
  HORIZON_OPEN_BROWSER: "false",
  HORIZON_WARM_UP: "false",
  // Several tests deliberately run servers side by side, which the
  // single-instance guard would otherwise hand over. The guard has its own
  // test below, where this is left off.
  HORIZON_ALLOW_MULTIPLE_INSTANCES: "true"
});

/* ------------------------------------------------------------------ tests -- */

test("config: resolution order and validation", () => {
  const { loadConfig } = require(path.join(ROOT, "src", "config.js"));

  const base = loadConfig([], {});
  assert.equal(base.web.host, "127.0.0.1", "must default to loopback");
  assert.ok(base.web.port > 0, "must have a stable default port");

  const viaEnv = loadConfig([], { HORIZON_PORT: "4321" });
  assert.equal(viaEnv.web.port, 4321, "environment must override the file");

  const viaCli = loadConfig(["--port=8765"], { HORIZON_PORT: "4321" });
  assert.equal(viaCli.web.port, 8765, "CLI must override the environment");

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

// The About page names Microsoft's trademarks, so the disclaimer has to stay.
// The feedback buttons must also stay gated on a contact URL, or a fork with
// no contact page ships a dead link.
test("about: trademark notice and gated feedback survive edits", () => {
  const client = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  assert.match(client, /not a Microsoft product/,
    "About must disclaim affiliation while using the Foundry name");
  assert.match(client, /trademarks of the Microsoft group of companies/,
    "About must carry the trademark attribution");

  assert.match(client, /const contactUrl = state\.app\?\.contactUrl;\s*\n\s*if \(contactUrl\)/,
    "feedback must render only when a contact URL is configured");
  for (const glyph of ["i-thumb-up", "i-thumb-down"]) {
    assert.ok(client.includes(glyph), `${glyph} must be used by the feedback buttons`);
  }

  // Both glyphs must actually exist in the built sprite, or the buttons render
  // empty squares.
  const built = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const glyph of ["i-thumb-up", "i-thumb-down", "i-foundry"]) {
    assert.ok(built.includes(`<symbol id="${glyph}"`), `${glyph} must be in the built sprite`);
  }
});

// Foundry's icon is read from the local install rather than copied into this
// repo, so that publishing Horizon redistributes none of Microsoft's artwork.
// This test guards the boundary: no image files, and a lookup that fails
// softly when Foundry is absent.
test("brand: Foundry artwork is never vendored into the repo", async () => {
  const { foundryIcon } = require(path.join(ROOT, "src", "brand.js"));

  const icon = await foundryIcon();
  if (icon) {
    assert.ok(icon.bytes.length > 0, "a located icon must have content");
    assert.equal(icon.bytes.readUInt32BE(0), 0x89504e47, "must be served as a real PNG");
    assert.ok(!icon.source.startsWith(ROOT),
      "the icon must come from the Foundry install, never from inside this repo");
  }

  // Nothing Foundry-branded may sit in the published tree.
  const publicDir = path.join(ROOT, "public");
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const suspicious = walk(publicDir).filter(file =>
    /foundry|azure|microsoft/i.test(path.basename(file)) &&
    /\.(png|jpe?g|svg|ico|webp)$/i.test(file));
  assert.deepEqual(suspicious, [], "no Microsoft-branded image may ship in public/");
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

test("foundry: rejects unsafe model aliases", () => {
  const foundry = require(path.join(ROOT, "src", "foundry.js"));
  for (const bad of ["phi-4; calc.exe", "a && whoami", "../../etc", "a|b", "$(id)", "`id`", "", "a b"]) {
    assert.equal(foundry.isSafeAlias(bad), false, `must reject: ${bad}`);
  }
  for (const good of ["phi-4", "qwen2.5-coder-1.5b", "Phi-4-generic-gpu"]) {
    assert.equal(foundry.isSafeAlias(good), true, `must accept: ${good}`);
  }
});

// "foundry model list" reports the catalogue but has no "loaded" field at all,
// so trusting it alone made every model look unloaded even while one was live.
test("foundry: catalogue takes load state from the cache listing", () => {
  const foundry = require(path.join(ROOT, "src", "foundry.js"));

  const catalogueModels = [
    { alias: "phi-4", cached: true, loaded: false },
    { alias: "qwen3-1.7b", cached: true, loaded: false },
    { alias: "gpt-oss-20b", cached: false, loaded: false }
  ];
  const cacheModels = [
    { alias: "phi-4", loaded: false },
    { alias: "qwen3-1.7b", loaded: true }
  ];

  const merged = foundry.mergeLoadState(catalogueModels, cacheModels);
  const byAlias = Object.fromEntries(merged.map(model => [model.alias, model]));

  assert.equal(byAlias["qwen3-1.7b"].loaded, true, "a resident model must read as loaded");
  assert.equal(byAlias["phi-4"].loaded, false, "a downloaded but unloaded model must not read as loaded");
  assert.equal(byAlias["gpt-oss-20b"].loaded, false, "an absent model must not read as loaded");
  assert.equal(byAlias["phi-4"].cached, true, "merging must not disturb the other fields");

  assert.deepEqual(
    foundry.mergeLoadState(catalogueModels, []).map(model => model.loaded),
    [false, false, false],
    "with no cache listing nothing should claim to be loaded"
  );
});

test("foundry: parses server-sent events and stops at [DONE]", async () => {
  const foundry = require(path.join(ROOT, "src", "foundry.js"));
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
  for await (const event of foundry.parseServerSentEvents({ body: [Buffer.from(body)] })) {
    seen.push(event.choices[0].delta.content);
  }
  assert.deepEqual(seen, ["a", "b"], "must stop at [DONE]");
});

test("server: starts without Foundry and reports it honestly", async t => {
  const app = await startApp({
    HORIZON_PORT: "0",
    HORIZON_OPEN_BROWSER: "false",
    HORIZON_WARM_UP: "false",
    // Without this the single-instance guard hands over to any Horizon already
    // running on the machine, and the test sees a clean exit instead of a
    // server. That is what made this suite fail intermittently during
    // development, while passing whenever nothing else was running.
    HORIZON_ALLOW_MULTIPLE_INSTANCES: "true",
    PATH: path.join(__dirname, "no-foundry")
  });
  t.after(() => stop(app));

  assert.equal((await request(`${app.url}/`)).status, 200, "page must serve with no Foundry");

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

// Foundry picks a new port every time it restarts. The CLI talks to the daemon
// directly, so it keeps answering correctly while the endpoint Horizon holds
// has gone stale -- which produced ready:true against a dead address. Worse
// than an error, because the page looks fine until a message fails.
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
  const foundry = require(path.join(ROOT, "src", "foundry.js"));

  assert.equal(typeof foundry.endpointAlive, "function",
    "there must be a way to check an endpoint is still alive");

  const probe = /async function probeFoundry\(\)[\s\S]*?\n}/.exec(source);
  assert.ok(probe, "probeFoundry must exist");
  assert.match(probe[0], /endpointAlive/,
    "readiness must verify the endpoint rather than trusting the CLI alone");
  assert.match(probe[0], /rediscoverFoundry/,
    "a stale endpoint must trigger rediscovery");
});

test("server: serves assets, blocks traversal, streams a reply", async t => {
  const stub = await startStubFoundry();
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
  const stub = await startStubFoundry();
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
  const stub = await startStubFoundry();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

  const data = await (await request(`${app.url}/api/diagnostics`)).json();
  assert.deepEqual(data.hops.map(hop => hop.id), ["server", "foundry", "model"]);
  assert.equal(data.allLoopback, true, "every hop must be loopback");
});

test("server: refuses a non-loopback Foundry endpoint", async () => {
  await assert.rejects(startApp({
    FOUNDRY_BASE_URL: "http://example.com/v1",
    HORIZON_PORT: "0",
    HORIZON_OPEN_BROWSER: "false"
  }), /exited/, "must refuse to start against a remote endpoint");
});

// Launching twice used to start a second server on the next free port AND
// overwrite the state file, after which Stop-Horizon targeted the wrong
// process and left the real one running.
test("server: a second launch hands over to the first", async t => {
  const stub = await startStubFoundry();
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
  const stub = await startStubFoundry();
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
  const stub = await startStubFoundry();
  t.after(() => stub.server.close());

  const app = await startApp(stubEnv(stub.port));
  t.after(() => stop(app));

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

  const out = app.output();
  assert.match(out, /Shutting down/, "must announce the shutdown");
  assert.match(out, /Goodbye/, "must run cleanup through to the end, not exit early");

  // Ordering, not just presence: "Goodbye" is printed after releaseResources
  // resolves, so anything the shutdown does must appear before it.
  assert.ok(out.indexOf("Shutting down") < out.indexOf("Goodbye"),
    "cleanup must complete before the process says it is done");

  // The state file is what a second launch reads to find the first. Leaving it
  // behind would make the next start defer to a server that no longer exists.
  const stateFile = path.join(ROOT, ".runtime", "horizon.json");
  assert.equal(fs.existsSync(stateFile), false,
    "the runtime state file must be cleared on exit");
});

/* ------------------------------------------------------------- dictation -- */

test("dictation: settings are validated before they reach the command line", () => {
  const { loadConfig } = require(path.join(ROOT, "src", "config.js"));

  // Explicitly off rather than read from config.local.json, which belongs to
  // whoever is running the suite and may legitimately have dictation switched
  // on. The shipped default is asserted from config.json instead.
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  assert.equal(shipped.dictation.enabled, false,
    "dictation opens the microphone, so it must ship switched off");

  const base = loadConfig([], { HORIZON_DICTATION: "false" });
  assert.equal(base.dictation.enabled, false, "the setting must be honoured");

  // The alias is passed to the Foundry CLI. A hand-edited config file is not a
  // trusted source, so anything outside the safe set has to be refused rather
  // than forwarded.
  assert.throws(() => loadConfig([], { HORIZON_DICTATION_MODEL: "model; rm -rf /" }),
    /Invalid dictation model alias/, "must refuse an alias containing shell syntax");
  assert.throws(() => loadConfig([], { HORIZON_DICTATION_MODEL: "--output=json" }),
    /Invalid dictation model alias/, "must refuse an alias that looks like a flag");

  // A wrong idle timeout means a speech model held in memory, or a microphone
  // released so aggressively that dictation is unusable.
  assert.throws(() => loadConfig([], { HORIZON_DICTATION_IDLE_MS: "1000" }),
    /Invalid dictation idle timeout/, "must refuse an idle timeout under a minute");
  assert.throws(() => loadConfig([], { HORIZON_DICTATION_IDLE_MS: "5400000" }),
    /Invalid dictation idle timeout/, "must refuse an idle timeout over thirty minutes");

  const chosen = loadConfig([], { HORIZON_DICTATION_IDLE_MS: "600000" });
  assert.equal(chosen.dictation.idleTimeoutMs, 600000, "a value in range must be kept");
});

test("dictation: terminal decoration is never mistaken for speech", () => {
  const dictation = require(path.join(ROOT, "src", "dictation.js"));

  // The CLI draws a prompt around the transcript. None of it was spoken, and
  // all of it would otherwise be typed into the user's message.
  for (const line of [
    "Transcribing model (nemotron-speech-streaming-en-0.6b)",
    "note: Type /help to see transcribe commands, /exit to quit.",
    "note: Recording... type /stop to finish.",
    "Press space bar and speak...",
    "/record",
    "--------------------------------"
  ]) {
    assert.equal(dictation.isChrome(line), true, `must ignore CLI chrome: ${line}`);
  }

  assert.equal(dictation.isChrome("This is a test dictation"), false,
    "must keep what was actually said");

  // Colour and title sequences arrive mixed into the text.
  assert.equal(dictation.stripAnsi("\u001b[32mhello\u001b[0m"), "hello",
    "must remove colour codes");
  assert.equal(dictation.stripAnsi("\u001b]0;title\u0007hello"), "hello",
    "must remove the window title sequence");

  // The CLI wraps its output at the terminal width, and a narrow terminal
  // splits words across chunks ("requested" arriving as "requ" then "ested").
  // The width is the defence against that, so it is asserted rather than left
  // as a number someone might reasonably tidy up later.
  assert.ok(dictation.PTY_COLUMNS >= 2000,
    "the terminal must be wide enough that lines are not wrapped mid-word");
});

test("dictation: the page is told honestly what this machine can do", async () => {
  const stub = await startStubFoundry();
  // Pinned off explicitly. Whether dictation is switched on lives in
  // config.local.json, which belongs to whoever is running the suite, so the
  // test must not read their setting and must not leave one behind.
  const app = await startApp({ ...stubEnv(stub.port), HORIZON_DICTATION: "false" });

  try {
    const status = await (await request(`${app.url}/api/dictation`)).json();

    // Whether node-pty is installed depends on the machine, but the answer must
    // always be accompanied by a reason when the answer is no.
    assert.equal(typeof status.available, "boolean", "must state whether dictation can run");
    if (!status.available) {
      assert.ok(status.reason, "must say why dictation is unavailable rather than failing silently");
    }

    // The browser plays no part in recording: the Foundry CLI opens the
    // microphone. The page relies on this to know it must show its own
    // recording indicator, because the tab will not show one.
    assert.equal(status.browserCapturesAudio, false,
      "the page must know that the browser does not capture the audio");

    // Off by default, and refusing to act while off.
    assert.equal(status.enabled, false, "must be off until switched on");
    const refused = await request(`${app.url}/api/dictation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "record" })
    });
    assert.equal(refused.status, 409, "must refuse to record while switched off");

    const unknownAction = await request(`${app.url}/api/dictation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "nonsense" })
    });
    // Still 409 while switched off: the capability gate comes first, which is
    // the behaviour that matters.
    assert.equal(unknownAction.status, 409, "must not act on an unknown action");
  } finally {
    await stop(app);
    stub.server.close();
  }
});

test("ui: a recording is always visible on the page", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "app.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  // Horizon never calls getUserMedia, so the browser shows no permission prompt
  // and no recording indicator in the tab. The banner is the only signal the
  // user gets that the microphone is open, and it must exist and be announced.
  assert.match(html, /id="dictation-bar"/, "the recording banner must exist");
  assert.match(html, /id="dictation-bar"[^>]*role="status"/,
    "the banner must be announced to assistive technology");
  assert.match(html, /aria-live="assertive"/,
    "a live microphone is interrupting news, not a passing status");
  assert.match(html, /id="dictation-stop"/, "the banner must offer a way to stop");

  assert.ok(/\.dictation-bar\s*\{[^}]*\}/.test(css), ".dictation-bar must be styled");

  // A microphone picker in the page would be a lie: the CLI records through
  // whatever Windows has chosen, and nothing the page offers can change it.
  assert.ok(!/id="mic-picker"|id="dictation-device"/.test(html),
    "the page must not offer a microphone picker it cannot honour");
});

test("dictation: a redraw replaces the line rather than repeating it", () => {
  const { DictationSession } = require(path.join(ROOT, "src", "dictation.js"));
  const session = new DictationSession({ alias: "stub" });

  const updates = [];
  session.on("text", payload => updates.push(payload));

  // How the CLI actually behaves, taken from a recorded session: while speech
  // is being decoded it rewrites its last line in place and sends NO newline,
  // the way a progress indicator does. Each update repositions the cursor
  // first, which is the terminal saying the text draws over what is there.
  session._consume("\u001b[38;2;107;114;128m\u001b[7;3H Testing testing");
  session._consume("\u001b[m");
  session._consume("\u001b[38;2;107;114;128m\u001b[7;3H Testing testing one two");
  session._consume("\u001b[m");
  session._consume("\u001b[38;2;107;114;128m\u001b[7;3H Testing testing one two three. This is a test");

  // Waiting for a newline would hold everything back until recording stopped,
  // which is what made dictation look like it was not streaming at all.
  assert.ok(updates.length >= 3, "each redraw must reach the page as it happens");

  // And each redraw replaces the line. Keeping every version is what made the
  // transcript repeat the same sentence over and over.
  assert.equal(session.transcript(), "Testing testing one two three. This is a test",
    "a redrawn line must replace the previous text, not be added to it");

  // The echo of a command being typed is not speech.
  session._consume("\u001b[7;3H/sto");
  assert.equal(session.transcript(), "Testing testing one two three. This is a test",
    "a command being typed must never appear in the transcript");

  // A genuine newline settles the segment, and a new one begins after it.
  session._consume("\u001b[7;3H Testing testing one two three. This is a test and this is settled\n");
  session._consume("\u001b[7;3H a second segment");
  assert.match(session.transcript(), /settled a second segment$/,
    "a completed line must be kept and the next line started after it");

  // The model name is printed under the heading when the session opens, and is
  // not something anyone said.
  const fresh = new DictationSession({ alias: "stub" });
  fresh._consume("\u001b[7;3H(nemotron-speech-streaming-en-0.6b)\n");
  assert.equal(fresh.transcript(), "", "the model name must never appear in the transcript");
});

test("dictation: stopping does not repeat what was said", () => {
  const { DictationSession } = require(path.join(ROOT, "src", "dictation.js"));
  const session = new DictationSession({ alias: "stub" });

  // Pretend a recording is running, then speak.
  session.recording = true;
  session._accepting = true;
  session._consume("\u001b[7;3H This is a test dictation");
  session._consume("\u001b[7;3H This is a test dictation that is working");

  // Stopping settles the line. The CLI then repaints it, more than once, which
  // is what made the finished transcript appear two and three times over.
  session.recording = false;
  session._accepting = false;
  session._settle();
  session._consume("\u001b[7;3H This is a test dictation that is working");
  session._consume("\u001b[7;3H This is a test dictation that is working");

  assert.equal(session.transcript(), "This is a test dictation that is working",
    "the finished transcript must contain what was said exactly once");
});

test("dictation: a stranded audio session is reported and cleared", () => {
  const dictation = require(path.join(ROOT, "src", "dictation.js"));
  const { DictationSession } = dictation;

  // Foundry keeps the audio stream against the model, and the daemon outlives
  // Horizon. A session that died without stopping leaves it held, and every
  // later recording fails until something clears it. The user cannot see that
  // and cannot act on it, so it must not surface as a bare failure.
  const session = new DictationSession({ alias: "stub" });
  const errors = [];
  session.on("error", payload => errors.push(payload.message));
  session._signals("error: A streaming session is already active (handle: audio-stream-123).");
  assert.equal(errors.length, 1, "the page must be told what went wrong");
  assert.match(errors[0], /holding a recording session/i,
    "in words the user can act on, not with a daemon handle");

  // Any other CLI error is passed on as it was written, rather than swallowed.
  const other = new DictationSession({ alias: "stub" });
  const seen = [];
  other.on("error", payload => seen.push(payload.message));
  other._signals("\u25a0 error: Model 'x' only supports live-streaming transcription.");
  assert.equal(seen.length, 1, "other failures must reach the page too");
  assert.match(seen[0], /only supports live-streaming/, "and keep the CLI's own wording");

  // Unloading the model does NOT release the stream: it reports success, the
  // model shows as unloaded, and the stream stays held. Only restarting the
  // Foundry service clears it. The helper is kept because it is the right way
  // to give the memory back, but it must not be mistaken for a way to release
  // an audio session.
  let called = null;
  const fakeExec = (cmd, args, opts, cb) => { called = args; cb(null, "", ""); };
  return dictation.releaseStrandedSession("stub-alias", fakeExec).then(() => {
    assert.deepEqual(called, ["model", "unload", "stub-alias"],
      "the helper unloads the model, which frees memory but NOT the audio stream");
  });
});

test("dictation: a failure never becomes transcript text", () => {
  const { DictationSession } = require(path.join(ROOT, "src", "dictation.js"));
  const session = new DictationSession({ alias: "stub" });

  const errors = [];
  session.on("error", payload => errors.push(payload.message));
  session.recording = true;
  session._accepting = true;

  // Exactly what Foundry printed when a session was left open by an earlier
  // recording. Every line of this arrived on the same stream as the transcript
  // and was typed into the user's message.
  session._consume("\u001b[7;3H\u25cf error: IPC error 'op_handler_failed': Error starting audio stream session: Error: System.InvalidOperationException: A streaming session is already active (handle: audio-stream-7821b348).\n");
  session._consume("   at Microsoft.AI.Foundry.Local.AudioStreamingSessionFactory.CreateSession(OnnxLoadedModel, AudioStreamingSettings) + 0x1d4\n");
  session._consume("--- End of stack trace from previous location ---\n");
  session._consume("Hint: Try 'foundry server stop' then 'foundry server start'.\n");

  assert.equal(session.transcript(), "",
    "a stack trace is not something anybody said, and must never reach the message box");
  assert.ok(errors.length, "the failure must be reported instead");
  assert.match(errors[0], /holding a recording session|clearing/i,
    "and said in words the user can act on");

  // A session that failed is not recording, however it looked a moment ago.
  assert.equal(session.recording, false,
    "a live microphone must not be shown for a session that never opened");
});

test("ui: the dictation setting says where the recording happens", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

  // Dictation was previously reachable only by hand-editing config.local.json,
  // which is not a reasonable thing to ask of the people this is built for.
  assert.match(app, /function renderDictationSetup/,
    "dictation must be switchable from Settings, not only from a file");
  assert.match(app, /renderDictationSetup\(panel\)/,
    "and the panel must actually be rendered");

  const panel = app.slice(app.indexOf("function renderDictationSetup"));
  const body = panel.slice(0, panel.indexOf("\n/* ---"));

  // The one thing nobody can work out by using it: the page never opens the
  // microphone, so the browser shows no prompt and no recording dot.
  assert.match(body, /does not record through this browser/i,
    "the panel must say the browser is not doing the recording");
  assert.match(body, /no permission prompt/i,
    "and that no permission will be asked for");

  // And the one thing that will otherwise waste someone's afternoon.
  assert.match(body, /default input device/i,
    "the panel must say Foundry uses the Windows default microphone");
  assert.match(body, /cannot choose for you/i,
    "and admit Horizon cannot change it");

  // A machine without the terminal helper must be told why, not shown a
  // control that cannot work.
  assert.match(body, /if \(!status\.available\)/,
    "an unavailable capability must explain itself instead of offering a switch");
});

test("dictation: switching it on is a one-time decision", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");

  // Asked for once, remembered on disk. Nobody should have to visit Settings
  // every time they want to speak.
  assert.match(server, /saveLocalSettings\(\{ dictation: \{ enabled/,
    "the choice must be written to the user's own settings file");

  // The model is fetched when the choice is made, not when the first recording
  // is attempted: a 700 MB download behind a button press is a stall nobody
  // was warned about.
  assert.match(server, /if \(body\.enabled\) dictationEnsureModel\(\)/,
    "agreeing must start the download");
  assert.match(server, /function dictationEnsureModel/,
    "and there must be something to start");

  // But it is not held in memory from then on. Loading happens on the first
  // recording and is released when idle, which is the whole point of the
  // idle timeout.
  const ensure = server.slice(server.indexOf("function dictationEnsureModel"));
  const body = ensure.slice(0, ensure.indexOf("\nasync function"));
  assert.ok(!/\bfoundry\.loadModel\b|\bensureLoaded\b/.test(body),
    "downloading must not also load the model into memory");

  // The button stays visible when dictation is off. Hiding it means nobody
  // ever finds out the feature exists.
  assert.match(app, /ui\.dictateBtn\.hidden = !state\.dictation\.available/,
    "the button must be hidden only when the machine cannot run it");
  assert.match(app, /Dictation is off\. Switch it on in Settings/,
    "and must say where to switch it on");
  assert.match(app, /if \(!state\.dictation\.enabled\)[\s\S]{0,240}setMode\("settings"\)/,
    "pressing it while off must take the user to the switch");
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
  assert.match(source, /if \(closed && !collapsedOnce\) \{\s*\n\s*collapsedOnce = true;/,
    "the box must collapse once, not on every frame");
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

test("brand: Foundry's own icon is found before the page asks for it", () => {
  const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");

  // Locating the icon walks the install directory and falls back to
  // PowerShell: about a second and a quarter on a cold start, then memoised.
  // Left until the page asks, that cost is paid in front of the user, and the
  // glyph changes under them a second after Settings opens.
  assert.match(server, /foundryIcon\(\)\.catch\(\(\) => \{\}\)/,
    "the icon must be looked up at startup, not on first sight of it");

  // A failure here is not worth a word: the page already falls back to its own
  // glyph, which is the same outcome as Foundry not being installed.
  const startup = server.slice(server.indexOf("foundryIcon().catch"));
  assert.ok(!/foundryIcon\(\)\.catch\(\(\) => \{\}\)\s*\.then/.test(startup),
    "warming the icon must not gate anything else");

  const client = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  // The fallback is still drawn first, so an uninstalled Foundry shows a glyph
  // rather than a gap.
  assert.match(client, /wrap\.append\(icon\(fallbackId/,
    "the fallback glyph must still be drawn before the real one arrives");
});
