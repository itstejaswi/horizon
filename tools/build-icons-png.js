"use strict";
// Build-time only. Rasterises public/brand/mark.svg into the PNG sizes Windows
// needs for a taskbar entry and Start tile.
//
//   node tools/build-icons-png.js
//
// Windows will not use an SVG for a taskbar icon, so a PWA install needs real
// PNGs. The previous version of this script drew the mark a second time from
// its own constants, which meant the icons quietly fell behind the SVG every
// time the mark changed -- they were still showing a sparkle-less version long
// after the mark had two. So the SVG is now the only description of the mark,
// and this renders it through the browser already on the machine.
//
// The generated files are committed, so a normal clone needs no build step.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const BRAND = path.join(__dirname, "..", "public", "brand");
const SVG = path.join(BRAND, "mark.svg");

const BROWSER = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(fs.existsSync);

const PORT = 9223;

// 192 and 512 are what a PWA manifest asks for. The maskable variant is drawn
// smaller inside a full-bleed tile, because Android crops it to a circle.
const SIZES = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true }
];

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

// The mark, sized and framed for one output. A maskable icon loses its rounded
// tile and shrinks the glyph, so a circular crop takes only background.
function page(svg, size, maskable) {
  const inner = svg.replace(/<\?xml[\s\S]*?\?>/, "").trim();
  const flat = maskable
    ? inner.replace(/rx="7"/, 'rx="0"')
           .replace(/scale\(0\.74\)/, "scale(0.46)")
    : inner;

  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${size}px;height:${size}px}
</style>
${flat}`;
}

async function main() {
  if (!BROWSER) throw new Error("no Edge or Chrome found to render with");
  const svg = fs.readFileSync(SVG, "utf8");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "horizon-icons-"));
  const browser = spawn(BROWSER, [
    `--remote-debugging-port=${PORT}`,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let attempt = 0; attempt < 30 && !target; attempt++) {
      await wait(400);
      try {
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find(t => t.type === "page");
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

    for (const { file, size, maskable } of SIZES) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: size, height: size, deviceScaleFactor: 1, mobile: false
      });
      await send("Page.navigate", {
        url: "data:text/html;charset=utf-8," + encodeURIComponent(page(svg, size, maskable))
      });
      await wait(450);

      const { data } = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false
      });
      const out = path.join(BRAND, file);
      fs.writeFileSync(out, Buffer.from(data, "base64"));
      console.log(`${file.padEnd(24)} ${size}x${size}  ${fs.statSync(out).size} B`);
    }

    ws.close();
  } finally {
    browser.kill();
  }
}

main().catch(error => {
  console.error("failed:", error.message);
  process.exit(1);
});
