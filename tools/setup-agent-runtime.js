"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function check() {
  require.resolve("@langchain/langgraph");
  require.resolve("@langchain/core");
  require.resolve("zod");
  const { chromium } = require("playwright");
  return fs.existsSync(chromium.executablePath());
}

if (process.argv.includes("--check")) {
  try {
    process.exitCode = check() ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
} else {
  try {
    if (!check()) {
      console.log("Preparing Horizon's isolated browser. This one-time download requires internet access.");
      const manifestPath = require.resolve("playwright/package.json");
      const manifest = require(manifestPath);
      const cli = path.resolve(path.dirname(manifestPath), manifest.bin.playwright);
      const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0 || !check()) throw new Error("Browser setup failed. Run npm run setup:browser and retry.");
    }
    console.log("Horizon's bundled tool runtime is ready. Agent features remain off until enabled.");
  } catch (error) {
    console.error(`Horizon setup did not finish: ${error.message}`);
    console.error("Run npm run setup:browser with internet access, then retry. No features have been enabled.");
    process.exitCode = 1;
  }
}
