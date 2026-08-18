"use strict";
// Build-time only. Renders .github/assets/banner.svg to the PNG the README
// shows, and .github/assets/social-preview.jpg for the repository's social
// card.
//
//   node tools/build-banner.js
//
// GitHub will not render an SVG in a README, so the PNG has to exist. Rendering
// it from the SVG rather than drawing it twice means the mark cannot fall
// behind again -- which is exactly what happened when the sparkles were added
// and three separate hand-copies of the mark stayed as they were.
//
// The generated files are committed, so a normal clone needs no build step.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ASSETS = path.join(__dirname, "..", ".github", "assets");
const SVG = path.join(ASSETS, "banner.svg");

const BROWSER = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(fs.existsSync);

const PORT = 9226;
const WIDTH = 1280;
const HEIGHT = 320;

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

async function main() {
  if (!BROWSER) throw new Error("no Edge or Chrome found to render with");
  const svg = fs.readFileSync(SVG, "utf8").replace(/<\?xml[\s\S]*?\?>/, "").trim();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-banner-"));
  const browser = spawn(BROWSER, [
    `--remote-debugging-port=${PORT}`,
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let attempt = 0; attempt < 30 && !target; attempt++) {
      await wait(400);
      try {
        target = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find(t => t.type === "page");
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error("browser did not open a debugging port");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const resolver = pending.get(message.id);
      if (!resolver) return;
      pending.delete(message.id);
      if (message.error) resolver.reject(new Error(JSON.stringify(message.error)));
      else resolver.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
    });
    await send("Page.navigate", {
      url: "data:text/html;charset=utf-8," + encodeURIComponent(
        `<!doctype html><meta charset="utf-8">
         <style>html,body{margin:0;padding:0}
         svg{display:block;width:${WIDTH}px;height:${HEIGHT}px}</style>
         ${svg}`)
    });
    // The banner names a font that may not be installed; give the fallback a
    // moment to settle before the shutter.
    await wait(900);

    const { data } = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false
    });
    const out = path.join(ASSETS, "banner.png");
    fs.writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`banner.png  ${WIDTH}x${HEIGHT}  ${fs.statSync(out).size} B`);

    ws.close();
  } finally {
    browser.kill();
  }
}

main().catch(error => {
  console.error("failed:", error.message);
  process.exit(1);
});
