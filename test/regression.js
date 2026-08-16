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
