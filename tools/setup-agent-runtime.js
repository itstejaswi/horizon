"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function bundled() {
  require.resolve("node-pty");
  const { chromium } = require("playwright");
  return fs.existsSync(chromium.executablePath());
}

// Browser tools fall back to the installed Microsoft Edge (see
// browserLaunchOptions in src/agent-tools.js), so an installed Edge means no
// download is needed. Only standard per-machine and per-user locations count.
function edge() {
  const env = process.env || {};
  return [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA]
    .filter(Boolean)
    .map(root => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
    .some(file => fs.existsSync(file));
}

function check() {
  return bundled() || edge();
}

if (process.argv.includes("--check")) {
  try {
    process.exitCode = check() ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
} else {
  try {
    if (!bundled()) {
      if (edge()) {
        console.log("Using the installed Microsoft Edge for Horizon's isolated browser; no download needed.");
      } else {
        console.log("Preparing Horizon's isolated browser. This one-time download requires internet access.");
        const manifestPath = require.resolve("playwright/package.json");
        const manifest = require(manifestPath);
        const cli = path.resolve(path.dirname(manifestPath), manifest.bin.playwright);
        const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0 || !check()) throw new Error("Browser setup failed. Run npm run setup:browser and retry.");
      }
    }
    console.log("Horizon's bundled tool runtime is ready. Agent features remain off until enabled.");
  } catch (error) {
    console.error(`Horizon setup did not finish: ${error.message}`);
    console.error("Run npm run setup:browser with internet access, then retry. No features have been enabled.");
    process.exitCode = 1;
  }
}
