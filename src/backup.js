"use strict";

/* ============================================================================
   Backup

   Chats, prompts, memory and saved replies live in the browser's own storage.
   That is private by default -- nothing is written to disk unless asked -- but
   it is also fragile: clearing browser data wipes everything, and switching
   browser or profile leaves it behind.

   So this offers a deliberate, off-by-default copy on disk. Nothing here runs
   unless the user turns it on, and turning it off stops future writes and can
   delete what was written.

   The file is plain JSON on purpose. It should be readable, checkable and
   restorable without this application.
   ========================================================================== */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const FILE_NAME = "horizon-data.json";
const FORMAT = 1;

// A single backup, kept alongside the live file. Enough to survive a bad write
// or a mistaken restore, without turning into a version-control system.
const PREVIOUS_NAME = "horizon-data.previous.json";

function defaultDirectory() {
  return path.join(os.homedir(), "Horizon");
}

function resolveDirectory(config) {
  return config.backup?.directory || defaultDirectory();
}

function filePath(config) {
  return path.join(resolveDirectory(config), FILE_NAME);
}

async function status(config) {
  const file = filePath(config);
  let stats = null;
  try {
    stats = await fsp.stat(file);
  } catch {
    /* not written yet */
  }

  return {
    enabled: Boolean(config.backup?.enabled),
    directory: resolveDirectory(config),
    file,
    exists: Boolean(stats),
    savedAt: stats ? stats.mtime.toISOString() : null,
    bytes: stats ? stats.size : 0
  };
}

// Written to a temporary file first and then renamed, because a half-written
// backup that replaced a good one would be worse than no backup at all.
async function write(config, payload) {
  const directory = resolveDirectory(config);
  const file = path.join(directory, FILE_NAME);
  const temporary = `${file}.writing`;

  await fsp.mkdir(directory, { recursive: true });

  const record = {
    format: FORMAT,
    app: "Horizon",
    savedAt: new Date().toISOString(),
    data: payload
  };

  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  // Keep the last good copy before replacing it.
  if (fs.existsSync(file)) {
    try {
      await fsp.copyFile(file, path.join(directory, PREVIOUS_NAME));
    } catch {
      /* a missing previous copy must not block the current save */
    }
  }

  await fsp.rename(temporary, file);
  return status(config);
}

async function read(config) {
  const file = filePath(config);
  const raw = await fsp.readFile(file, "utf8");
  const record = JSON.parse(raw);

  if (!record || typeof record !== "object" || !record.data) {
    throw new Error("That file does not look like a Horizon backup.");
  }
  if (record.format !== FORMAT) {
    throw new Error(`That backup is version ${record.format}, which this version of Horizon cannot read.`);
  }

  return record;
}

async function remove(config) {
  const directory = resolveDirectory(config);
  for (const name of [FILE_NAME, PREVIOUS_NAME]) {
    try {
      await fsp.unlink(path.join(directory, name));
    } catch {
      /* already gone */
    }
  }
  return status(config);
}

module.exports = { status, write, read, remove, defaultDirectory, FILE_NAME, FORMAT };
