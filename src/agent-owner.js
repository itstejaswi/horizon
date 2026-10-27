"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

// An OS-held listener prevents simultaneous launches from sharing a scheduler.
// Windows releases the named pipe even when the process is forcibly closed.
async function acquireAgentOwner(directory) {
  fs.mkdirSync(directory, { recursive: true });
  let canonical = fs.realpathSync(directory);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\horizon-agents-${hash}`
    : path.join(os.tmpdir(), `horizon-agents-${hash}.sock`);
  const listener = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    listener.once("error", error => reject(new Error(
      `The Horizon agent data directory is already in use or its ownership listener is unavailable: ${directory} (${error.code}).`
    )));
    listener.listen(address, resolve);
  });
  listener.unref();
  return listener;
}

module.exports = { acquireAgentOwner };
