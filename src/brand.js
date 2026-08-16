"use strict";

// Serves Foundry Local's own icon from wherever it is installed on this
// machine, rather than keeping a copy of Microsoft's artwork in this repo.
//
// The distinction matters. Horizon is an independent project that names
// Foundry Local in order to say what it connects to; redistributing the
// product's logo would go further than that and imply an association that
// does not exist. Reading the icon from the local install is what a file
// manager does when it shows an application's icon: the artwork stays
// Microsoft's, stays on this machine, and never enters version control.
//
// If Foundry is not installed, nothing is served and the page falls back to
// Horizon's own crucible glyph.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { execFile } = require("child_process");

// Ordered by preference: the 150px asset is the crispest of the three at the
// size the About page draws it.
const ICON_NAMES = ["Square150x150Logo.png", "StoreLogo.png", "Square44x44Logo.png"];

const PACKAGE_PREFIX = "Microsoft.FoundryLocal";

let cached;

function packageRoots() {
  const roots = [];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) roots.push(path.join(programFiles, "WindowsApps"));
  return roots;
}

// Finds the installed package directory by name. Several versions can be
// present at once, so the newest by modification time wins.
async function findPackageDir() {
  for (const root of packageRoots()) {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue; // WindowsApps is ACL-restricted; listing it may be refused.
    }

    const candidates = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(PACKAGE_PREFIX))
      .map(entry => path.join(root, entry.name));

    if (!candidates.length) continue;

    const stamped = [];
    for (const dir of candidates) {
      try {
        const info = await fsp.stat(dir);
        stamped.push({ dir, at: info.mtimeMs });
      } catch { /* unreadable, skip */ }
    }
    stamped.sort((a, b) => b.at - a.at);
    if (stamped.length) return stamped[0].dir;
  }
  return null;
}

// Falls back to asking Windows directly, which reports the install location
// even when the parent directory cannot be listed.
function findPackageViaPowerShell() {
  return new Promise(resolve => {
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-AppxPackage -Name ${PACKAGE_PREFIX} | Select-Object -First 1).InstallLocation`
    ], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const location = String(stdout || "").trim();
      resolve(location && fs.existsSync(location) ? location : null);
    });
  });
}

async function locateIcon() {
  if (process.platform !== "win32") return null;

  let dir = await findPackageDir();
  if (!dir) dir = await findPackageViaPowerShell();
  if (!dir) return null;

  for (const name of ICON_NAMES) {
    const file = path.join(dir, "assets", name);
    try {
      await fsp.access(file, fs.constants.R_OK);
      return file;
    } catch { /* try the next size */ }
  }
  return null;
}

// Read once per process. The icon only changes when Foundry is reinstalled,
// and a failed lookup is remembered too so a missing install does not cost a
// PowerShell call on every page load.
async function foundryIcon() {
  if (cached !== undefined) return cached;

  const file = await locateIcon();
  if (!file) {
    cached = null;
    return cached;
  }

  try {
    const bytes = await fsp.readFile(file);
    // Confirm it really is a PNG before serving it as one.
    const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
    cached = isPng ? { bytes, source: file } : null;
  } catch {
    cached = null;
  }
  return cached;
}

module.exports = { foundryIcon };
