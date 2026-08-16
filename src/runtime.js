"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

function statePath(config) {
  return path.join(config.runtime.directory, config.runtime.stateFile);
}

// Written once the server is listening so the Stop and Test scripts never have
// to re-derive the port, endpoint, or model ID.
function writeState(config, state) {
  const file = statePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { ...state, pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

function readState(config) {
  const file = statePath(config);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clearState(config) {
  const file = statePath(config);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best effort on shutdown */
  }
}

// Answers "is another Horizon already serving?" before this process binds a
// port. Without this, launching twice starts a second server on the next free
// port AND overwrites the state file, after which the Stop script targets the
// wrong instance and leaves the real one running.
//
// The recorded PID alone is not trustworthy: the operating system reuses PIDs,
// so a stale file could point at an unrelated process. The definitive test is
// to ask the recorded address whether it is Horizon, which is also cheap
// because it only ever talks to loopback.
function probeInstance(url, timeoutMs = 1500) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (!settled) { settled = true; resolve(value); }
    };

    const request = http.get(`${url}/api/config`, { timeout: timeoutMs }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        return done(false);
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          // Something else could be squatting on the port, so require a
          // response that is recognisably ours.
          done(Boolean(JSON.parse(body)?.app?.name));
        } catch {
          done(false);
        }
      });
    });

    request.on("timeout", () => { request.destroy(); done(false); });
    request.on("error", () => done(false));
  });
}

async function findRunningInstance(config) {
  const existing = readState(config);
  if (!existing?.url) return null;
  if (existing.pid === process.pid) return null;
  return (await probeInstance(existing.url)) ? existing : null;
}

module.exports = { statePath, writeState, readState, clearState, findRunningInstance };
