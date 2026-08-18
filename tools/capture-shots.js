// Captures the site's screenshots at exactly the size they are shown, by
// driving a real browser rather than resizing a photograph of one. A window
// grabbed at 2482px and squeezed into a 1440px layout resamples every edge into
// mush; asking the browser for 1440px in the first place does not.
//
// The app is driven for real: real Horizon, real markup, real model output, so
// the timings under each reply and the duration on a reasoning panel are all
// measured rather than invented.
//
//   node tools/capture-shots.js
//   pwsh tools/Compress-Shots.ps1     # PNG -> JPEG, no resizing
//
// Needs Horizon running on :3000, phi-4 and qwen3-0.6b downloaded, and Edge.
//
// Two shots are not captured here and are taken by hand: dictation, which needs
// someone to speak into a microphone, and the shutdown dialog, which is modal.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9222;
const APP = "http://127.0.0.1:3000";
const OUT = path.join(__dirname, "..", "docs", "assets");

// 1440x900 matches the existing assets and the width the page lays out at.
const WIDTH = 1440;
const HEIGHT = 900;

const wait = ms => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

// A very small DevTools client. The protocol is a request/response pairing over
// one socket, so a map of pending ids is the whole of it.
class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const resolver = this.pending.get(message.id);
      if (!resolver) return;
      this.pending.delete(message.id);
      if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
      else resolver.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    }
    return result.result?.value;
  }

  async shot(file) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false
    });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return fs.statSync(file).size;
  }
}

async function connect() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const session = new Session(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  return session;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("starting Edge...");
  // A fresh profile every run, or Edge shows the sync and first-run dialogs
  // belonging to whoever is signed in on this machine -- which is both wrong in
  // a screenshot and a privacy leak, since the account name is rendered.
  const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "horizon-shots-"));
  const edge = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-features=msEdgeIdentityFre,msImplicitSignin,EdgeFre",
    APP
  ], { stdio: "ignore" });

  try {
    // The port is not listening the instant the process starts.
    let session = null;
    for (let attempt = 0; attempt < 30 && !session; attempt++) {
      await wait(500);
      try { session = await connect(); } catch { /* not up yet */ }
    }
    if (!session) throw new Error("Edge did not open a debugging port");

    await session.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
    });

    // The target found on connect may be a first-run page rather than the app,
    // so go there explicitly and wait for it to settle.
    await session.send("Page.navigate", { url: APP });
    await wait(2500);

    const title = await session.evaluate("document.title");
    if (!/horizon/i.test(String(title))) {
      throw new Error(`expected Horizon, got "${title}"`);
    }

    console.log(`connected, ${WIDTH}x${HEIGHT}, page is "${title}"`);

    // Asking the model live is slow but honest: the timings under each reply,
    // the reasoning panel and its duration are all real. Seeding storage would
    // be faster and would put invented numbers on the front page.
    const ask = async (question, settleMs) => {
      await session.evaluate(`(() => {
        const box = document.getElementById("prompt");
        box.value = ${JSON.stringify(question)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("send").click();
        return true;
      })()`);
      // Poll for the reply to finish rather than guessing at a duration: the
      // send button becomes a stop button while a reply is arriving.
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        await wait(1500);
        const busy = await session.evaluate(
          `document.getElementById("send").dataset.mode === "stop"`);
        if (!busy) break;
      }
      await wait(settleMs || 1200);
    };

    const newChat = async () => {
      await session.evaluate(`document.getElementById("new-chat").click(); true`);
      await wait(700);
    };

    const capture = async name => {
      const bytes = await session.shot(path.join(OUT, `${name}.png`));
      console.log(`  ${name}.png  ${Math.round(bytes / 1024)} KB`);
    };

    const useModel = async alias => {
      const current = await session.evaluate(
        `fetch("/api/models").then(r => r.json()).then(d => d.activeAlias)`);
      if (current === alias) return;
      console.log(`  loading ${alias}...`);
      await session.evaluate(`fetch("/api/models/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ${JSON.stringify(JSON.stringify({ alias }))}
      }).then(() => true)`);
      // Loading is not instant and the page has to see the change, so wait for
      // the server to report it rather than guessing at a duration.
      for (let attempt = 0; attempt < 40; attempt++) {
        await wait(3000);
        const now = await session.evaluate(
          `fetch("/api/models").then(r => r.json()).then(d => d.activeAlias)`);
        if (now === alias) break;
      }
      await session.evaluate(`location.reload(); true`);
      await wait(3000);
    };

    // 1. The empty state, before anything has been asked.
    await useModel("phi-4");
    await newChat();
    await capture("horizon-empty");

    // 2. An ordinary reply, from a model that does not publish its reasoning.
    console.log("asking phi-4...");
    await ask("Is 91 a prime number?");
    await capture("horizon-chat");

    // 3. The same question of a model that does, so the two can be compared.
    //    Reloading first, then starting the chat: a reload restores the last
    //    conversation, so a chat started before it is the one discarded.
    console.log("switching to qwen3-0.6b...");
    await useModel("qwen3-0.6b");
    await newChat();

    console.log("asking qwen3-0.6b...");
    await ask("Is 91 a prime number?");

    // The panel closes itself once the answer arrives, and a long reply is
    // clamped behind a "show the whole message" button. Both are right in the
    // application and wrong in a photograph of it, where the working is the
    // entire point.
    const opened = await session.evaluate(`(() => {
      const box = document.querySelector(".thinking");
      if (box) box.open = true;
      for (const button of document.querySelectorAll(".expand-btn")) button.click();
      const thread = document.getElementById("thread");
      if (thread) thread.scrollTop = 0;
      return Boolean(box);
    })()`);
    if (!opened) console.log("  (no reasoning panel -- did the model emit one?)");
    await wait(900);
    await capture("horizon-reasoning");

    // 4. Reading a page: the composer warning, and the badge going amber. Shown
    //    before sending, because the point of the picture is the announcement
    //    rather than the answer.
    console.log("page reading...");
    await useModel("phi-4");
    await newChat();

    // Turned on for the capture and put back afterwards: it is off by default,
    // and a screenshot is not a reason to change how the machine is configured.
    const reader = await session.evaluate(
      `fetch("/api/reader").then(r => r.json()).then(d => d.enabled)`);
    if (!reader) {
      await session.evaluate(`fetch("/api/reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
      }).then(() => true)`);
      await session.evaluate(`location.reload(); true`);
      await wait(3000);
      await newChat();
    }

    await session.evaluate(`(() => {
      const box = document.getElementById("prompt");
      box.value = "Summarise this in five lines: https://en.wikipedia.org/wiki/Air_gap_(networking)";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await wait(1400);
    await capture("horizon-reading");

    if (!reader) {
      await session.evaluate(`fetch("/api/reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false })
      }).then(() => true)`);
      console.log("  (link reading put back to off)");
    }

    console.log("\ncaptured.");
  } finally {
    edge.kill();
  }
}

main().catch(error => {
  console.error("failed:", error.message);
  process.exit(1);
});
