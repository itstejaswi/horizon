"use strict";

/* ============================================================================
   Desktop integration

   Creating a shortcut and starting at sign-in are the two things that turn
   Horizon from "a thing you run" into "a thing that is there". Both are
   per-user: they write into the user's own Start Menu and Desktop folders,
   so neither needs administrator rights and neither triggers UAC.

   Nothing here happens on its own. The user ticks a box in Setup, and can
   untick it again, which removes the file.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SHORTCUT_NAME = "Horizon.lnk";

function isWindows() {
  return process.platform === "win32";
}

// Arguments are passed through the environment rather than interpolated into
// the script text, so no path can alter the command being run.
function runPowerShell(script, env = {}, timeoutMs = 15000) {
  return new Promise(resolve => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({
        ok: !error,
        output: `${stdout || ""}${stderr || ""}`.trim()
      }));
  });
}

// Desktop and Startup are not always where they look. OneDrive's Known Folder
// Move redirects Desktop into the synced folder, so the real location has to
// be asked for rather than assembled from the home directory.
let folderCache = null;
async function knownFolders() {
  if (folderCache) return folderCache;
  if (!isWindows()) return (folderCache = { desktop: null, startup: null });

  const result = await runPowerShell(
    "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Startup')"
  );
  const [desktop, startup] = result.output.split(/\r?\n/).map(line => line.trim());

  folderCache = {
    desktop: desktop && fs.existsSync(desktop) ? desktop : null,
    startup: startup && fs.existsSync(startup) ? startup : null
  };
  return folderCache;
}

function launcherPath() {
  return path.join(path.join(__dirname, ".."), "Start Horizon.bat");
}

function iconPath() {
  return path.join(path.join(__dirname, ".."), "public", "brand", "horizon.ico");
}

async function shortcutPaths() {
  const folders = await knownFolders();
  return {
    desktop: folders.desktop ? path.join(folders.desktop, SHORTCUT_NAME) : null,
    startup: folders.startup ? path.join(folders.startup, SHORTCUT_NAME) : null
  };
}

function exists(file) {
  return Boolean(file) && fs.existsSync(file);
}

async function status() {
  const paths = await shortcutPaths();
  const launcher = launcherPath();

  return {
    supported: isWindows() && Boolean(paths.desktop || paths.startup),
    platform: process.platform,
    launcher,
    launcherExists: fs.existsSync(launcher),
    startAtLogon: exists(paths.startup),
    desktopShortcut: exists(paths.desktop),
    paths
  };
}

// WindowStyle 7 is "minimised": the console the launcher needs still exists,
// but it does not take over the screen at sign-in.
//
// IconLocation matters more than it looks. The shortcut targets a .bat, so
// without this Windows shows the generic command-prompt icon -- which is not
// our brand, and makes the app look like a loose script.
const CREATE_SHORTCUT = [
  "$shell = New-Object -ComObject WScript.Shell;",
  "$link = $shell.CreateShortcut($env:HZ_LINK);",
  "$link.TargetPath = $env:HZ_TARGET;",
  "$link.WorkingDirectory = $env:HZ_WORKDIR;",
  "$link.Description = 'Horizon - local AI chat';",
  "$link.WindowStyle = 7;",
  "if (Test-Path $env:HZ_ICON) { $link.IconLocation = $env:HZ_ICON + ',0' };",
  "$link.Save()"
].join(" ");

async function createShortcut(linkPath) {
  const launcher = launcherPath();
  if (!fs.existsSync(launcher)) {
    throw new Error("The launcher 'Start Horizon.bat' could not be found.");
  }

  const result = await runPowerShell(CREATE_SHORTCUT, {
    HZ_LINK: linkPath,
    HZ_TARGET: launcher,
    HZ_WORKDIR: path.dirname(launcher),
    HZ_ICON: iconPath()
  });

  if (!result.ok || !fs.existsSync(linkPath)) {
    throw new Error(result.output || "The shortcut could not be created.");
  }
}

function removeShortcut(linkPath) {
  try {
    if (linkPath && fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
  } catch (error) {
    throw new Error(`The shortcut could not be removed: ${error.message}`);
  }
}

// Applies only the options that were actually sent, so the caller can change
// one setting without having to restate the other.
async function apply(options = {}) {
  if (!isWindows()) {
    throw new Error("Shortcuts are only supported on Windows.");
  }

  const paths = await shortcutPaths();
  const jobs = [
    ["startAtLogon", paths.startup, "the Startup folder"],
    ["desktopShortcut", paths.desktop, "the Desktop"]
  ];

  for (const [key, linkPath, where] of jobs) {
    if (typeof options[key] !== "boolean") continue;
    if (!linkPath) throw new Error(`${where} could not be located on this machine.`);
    if (options[key]) await createShortcut(linkPath);
    else removeShortcut(linkPath);
  }

  return status();
}

module.exports = { status, apply, isWindows };
