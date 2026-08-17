"use strict";

/*
 * Live dictation.
 *
 * Foundry Local does not expose transcription over its HTTP API, so this drives
 * the Foundry CLI instead. The CLI is interactive: given a plain pipe it sees a
 * non-interactive stdin and exits immediately, so it needs a real pseudo
 * terminal. That is the only reason node-pty is here.
 *
 * node-pty is an optional dependency. It ships prebuilt binaries for Windows and
 * macOS but not for Linux, where it would need a compiler. Horizon therefore
 * treats live dictation as a capability that may be absent, in the same way it
 * treats Foundry itself, rather than refusing to start without it.
 *
 * The daemon already contains a session API (CreateSession, AppendAudioChunk,
 * CommitTranscription, GetTranscript) that would let the browser supply audio
 * directly. It is reachable only over a private named pipe today. If it is ever
 * exposed over HTTP, only the internals of this module need to change: the
 * events and methods below are the seam.
 */

const { EventEmitter } = require("events");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// The CLI renders to a terminal and wraps at the right margin. A narrow
// terminal splits words across chunks ("requested" arriving as "requ" then
// "ested"), which corrupts the transcript. A wide terminal keeps each line
// whole, which is why no continuation-joining logic is needed downstream.
const PTY_COLUMNS = 4000;
const PTY_ROWS = 30;

// Lines the CLI prints to decorate its own prompt. None of them are speech.
const CHROME = [  /^[\u2500\u2501\u2014\-]{4,}$/,
  /note:/i,
  /Transcribing model/i,
  /Type \/help/i,
  /Type \/record/i,
  /type \/stop/i,
  /Press space bar/i,
  /^\/(record|stop|exit)\b/,
  // The model name, printed under the heading when the session opens.
  /^\([a-z0-9][a-z0-9._-]*\)$/i,
  /^[\u276f>\u25a0\s]*$/,
  // Failures and their stack traces. These arrive on the same stream as the
  // transcript, and without this they are typed into the user's message: a
  // .NET exception is not something anybody said.  /^[\s\u25a0\u25cf]*error:/i,
  /^\s*at\s+[\w.<>+`]/,
  /^-{3,}\s*End of stack trace/i,
  /^\s*Hint:/i,
  /System\.[A-Za-z]+Exception/,
  /IPC error/i,
  /^\s*\+\s*0x[0-9a-f]+/i
];

// A command is typed a character at a time and echoed back, so the leading edge
// of "/stop" appears on the end of the transcript as it is being sent.
const COMMAND_ECHO = /\s*\/(?:r(?:e(?:c(?:o(?:r(?:d)?)?)?)?)?|s(?:t(?:o(?:p)?)?)?|e(?:x(?:i(?:t)?)?)?)?$/;

function loadPty() {
  try {
    // eslint-disable-next-line global-require
    return { module: require("node-pty"), error: null };
  } catch (error) {
    return { module: null, error: error.message.split("\n")[0] };
  }
}

// Everywhere else Horizon calls the Foundry CLI through execFile, which finds
// it on PATH. A pseudo terminal does not do that lookup on Windows and needs a
// real file to open, so the executable is located once and reused. Nothing is
// hard-coded to one machine: the same lookup the shell would do is performed
// here.
let resolvedCommand;

function resolveCommand() {
  if (resolvedCommand !== undefined) return resolvedCommand;

  const isWindows = process.platform === "win32";
  const finder = isWindows ? "where" : "which";

  try {
    const found = execFileSync(finder, ["foundry"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    // "where" lists every match; prefer a real executable over a shim without
    // an extension, which a terminal cannot start.
    const preferred = isWindows
      ? found.find(entry => /\.(exe|com)$/i.test(entry)) || found[0]
      : found[0];

    // Deliberately not checked with existsSync. Foundry Local installs as a
    // packaged app, and its launcher in WindowsApps is a reparse point that
    // reports as missing even though it runs perfectly well. The lookup above
    // is the shell's own answer and is trusted as such.
    if (preferred) {
      resolvedCommand = preferred;
      return resolvedCommand;
    }
  } catch {
    // Not on PATH, or the lookup itself failed. Fall through to the known
    // install locations below.
  }

  // A last resort for the same packaged install, in case the lookup is not
  // available at all.
  const candidates = isWindows
    ? [path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "foundry.exe")]
    : ["/usr/local/bin/foundry", "/opt/homebrew/bin/foundry"];

  // On Windows the packaged path is taken on trust for the reason above; a
  // wrong guess surfaces as a clear failure to start rather than a silent one.
  resolvedCommand = isWindows
    ? (candidates[0] || null)
    : (candidates.find(entry => entry && fs.existsSync(entry)) || null);
  return resolvedCommand;
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\r/g, "");
}

// A terminal moves the cursor to an absolute position when it is about to draw
// over what is already there. The CLI does exactly this before each update
// while speech is being decoded, so the escape is a reliable statement that the
// text which follows replaces the line rather than continuing it. Matching on
// this is far steadier than guessing from how the words themselves overlap.
const CURSOR_HOME = /\x1b\[\d*(?:;\d*)?[HfG]/;

function isRedraw(chunk) {
  return CURSOR_HOME.test(String(chunk));
}

function isChrome(line) {
  return CHROME.some(pattern => pattern.test(line));
}

/*
 * One dictation session, wrapping one CLI process.
 *
 * Events:
 *   ready                       model loaded, waiting for a recording
 *   recording                   the microphone is open
 *   text  { committed, active } transcript so far, plus the line still changing
 *   stopped                     recording finished
 *   ended { code }              the CLI exited
 *   error { message }           the CLI could not be started or driven
 */
class DictationSession extends EventEmitter {
  constructor(options = {}) {
    super();
    // An EventEmitter throws if an "error" event is emitted with nothing
    // listening. Dictation is optional and must never be able to bring the
    // server down, so a listener is always present.
    this.on("error", () => {});
    this.alias = options.alias;
    this.command = options.command || null;
    this.maxRecordingMs = options.maxRecordingMs || 300000;
    this.idleTimeoutMs = options.idleTimeoutMs || 300000;

    this.term = null;
    this.ready = false;
    this.recording = false;
    this.committed = [];
    this.active = "";
    this.startedAt = null;

    this._recordingTimer = null;
    this._idleTimer = null;
    this._readyTimer = null;
    this._sawPrompt = false;
    // How long the CLI must stay quiet after printing its prompt before the
    // session is treated as ready. Loading the speech model takes seconds and
    // writes as it goes, so silence is the signal that it has finished.
    this.readyQuietMs = options.readyQuietMs || 2500;
    this._pending = "";
    // Speech only counts between /record and /stop. The CLI redraws its last
    // line again after stopping, and treating that as new text made the
    // finished transcript repeat itself.
    this._accepting = true;
    this._failed = false;
  }

  get state() {
    return {
      ready: this.ready,
      recording: this.recording,
      committed: this.committed.slice(),
      active: this.active,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0
    };
  }

  start() {
    if (this.term) return true;

    const pty = loadPty();
    if (!pty.module) {
      this.emit("error", { message: `Live dictation needs node-pty, which is not installed: ${pty.error}` });
      return false;
    }

    const command = this.command || resolveCommand();
    if (!command) {
      this.emit("error", { message: "The Foundry CLI could not be found on this machine." });
      return false;
    }

    try {
      // A real argv array with no shell, matching how the rest of Horizon calls
      // the Foundry CLI. The alias is validated by the caller before it arrives.
      this.term = pty.module.spawn(command, ["transcribe", "-m", this.alias], {
        name: "xterm-256color",
        cols: PTY_COLUMNS,
        rows: PTY_ROWS,
        cwd: process.cwd(),
        env: process.env
      });
    } catch (error) {
      this.emit("error", { message: `Could not start the Foundry CLI: ${error.message}` });
      return false;
    }

    this.term.onData(chunk => this._consume(chunk));
    this.term.onExit(({ exitCode }) => {
      this._clearTimers();
      this.term = null;
      this.ready = false;
      this.recording = false;
      this.emit("ended", { code: exitCode });
    });

    this._touchIdle();
    return true;
  }

  _consume(chunk) {
    // Optional raw capture, for diagnosing how the CLI redraws its output.
    // Off unless asked for, and written only to a path the user chooses.
    if (process.env.HORIZON_DICTATION_TRACE) {
      try {
        fs.appendFileSync(process.env.HORIZON_DICTATION_TRACE,
          JSON.stringify({ t: Date.now(), raw: chunk }) + "\n");
      } catch { /* tracing must never break dictation */ }
    }

    const text = stripAnsi(chunk);

    // An empty chunk carries only colour or cursor movement. It must not
    // disturb the line being held: the CLI sends one before each redraw, and
    // treating it as the end of a line made every redraw look like a new
    // sentence.
    if (!text) return;

    // While speech is being decoded the CLI rewrites its last line in place and
    // sends no newline at all, the way a progress indicator does. Waiting for a
    // newline would hold the entire transcript back until recording stopped,
    // which is what made dictation look as though it were not streaming.
    //
    // Whether an update replaces the line or continues it is taken from the
    // terminal itself: a chunk that repositions the cursor is drawing over what
    // is already there. Keeping every version of a redrawn line is what made
    // the transcript repeat the same sentence over and over.
    const redraw = isRedraw(chunk);
    const parts = text.split("\n");
    const trailing = parts.pop() || "";

    for (const part of parts) {
      this._line(redraw ? part : this._pending + part);
      this._settle();
      this._pending = "";
    }

    if (trailing) {
      this._signals(trailing);
      this._pending = redraw ? trailing : this._pending + trailing;
      this._line(this._pending, true);
    }
  }

  // A finished line is kept, and the next one begins after it. The CLI often
  // redraws a line once more after settling it, so the same text is never
  // recorded twice in a row.
  _settle() {
    if (!this.active) return;
    if (this.committed[this.committed.length - 1] !== this.active) {
      this.committed.push(this.active);
    }
    this.active = "";
  }

  _signals(text) {
    // "Type /record to start recording" is printed as soon as the banner is
    // drawn, long before the speech model has finished loading. Treating that
    // as readiness meant Horizon sent /record within milliseconds of launch,
    // and the CLI failed to open an audio stream because it was not armed yet.
    //
    // Loading finishes when the CLI stops writing, so readiness is taken from
    // the output going quiet rather than from the words appearing. Every chunk
    // pushes the moment back; when nothing has arrived for a short while, the
    // session is genuinely waiting for a command.
    if (!this.ready && /Press space bar|Type \/record/i.test(text)) {
      this._sawPrompt = true;
    }
    if (this._sawPrompt && !this.ready) {
      clearTimeout(this._readyTimer);
      this._readyTimer = setTimeout(() => {
        if (this.ready) return;
        this.ready = true;
        this.emit("ready");
      }, this.readyQuietMs);
      if (typeof this._readyTimer.unref === "function") this._readyTimer.unref();
    }
    if (!this.recording && /Recording\.\.\./i.test(text)) {
      this.recording = true;
      this.startedAt = Date.now();
      this.emit("recording");
    }
    // The CLI reports its own failures on the same stream. Passing them on is
    // better than leaving the page waiting for a session that will not arrive.
    if (/streaming session is already active/i.test(text)) {
      this._fail("Foundry is still holding a recording session from earlier.");
    } else if (/IPC error|System\.[A-Za-z]+Exception/.test(text)) {
      this._fail("The speech model could not start a recording.");    } else if (/^[\s\u25a0\u25cf]*error:/im.test(text)) {
      const line = text.split("\n").find(part => /error:/i.test(part)) || "";      const detail = line.replace(/^[\s\u25a0\u25cf]*error:\s*/i, "").trim();
      if (detail) this._fail(detail);
    }
  }

  // A failure ends the recording. Leaving `recording` set showed a live
  // microphone banner and a running timer for a session that never opened.
  _fail(message) {
    if (this._failed) return;
    this._failed = true;
    this.recording = false;
    this._accepting = false;
    // Nothing said before a failure is worth keeping: the transcript at this
    // point is the error itself.
    this.committed = [];
    this.active = "";
    this._pending = "";
    clearTimeout(this._recordingTimer);
    this.emit("text", { committed: [], active: "" });
    this.emit("error", { message });
  }

  _line(raw, redrawing = false) {
    // The echo of a command being typed is not speech, so it is trimmed from
    // the end before the line is considered.
    const line = raw.replace(/^[\u276f>\u25a0\s]+/, "").replace(COMMAND_ECHO, "").trimEnd();
    this._signals(raw);
    if (!line || isChrome(line)) return;
    // Anything drawn after recording stopped is the CLI repainting what it
    // already said, not something newly spoken.
    if (!this._accepting) return;

    this._touchIdle();

    // A redraw is the same line being rewritten, so it always replaces what is
    // held rather than being added to it. Committing here is what produced a
    // transcript that repeated itself with every update.
    if (redrawing) {
      if (this.active === line) return;
      this.active = line;
      this.emit("text", { committed: this.committed.slice(), active: this.active });
      return;
    }

    // A completed line. It replaces whatever was being shown for it, and is
    // settled by the caller.
    this.active = line;
    this.emit("text", { committed: this.committed.slice(), active: this.active });
  }

  record() {
    if (!this.term || !this.ready || this.recording) return false;
    // Remembered so a session that has to be restarted can resume what was
    // asked for, rather than making the user press record again.
    this.wantedRecording = true;
    this.committed = [];
    this.active = "";
    this._pending = "";
    this._accepting = true;
    this.emit("text", { committed: [], active: "" });
    this.term.write("/record\r");

    // Recording never runs unattended: a forgotten session would hold the
    // microphone open indefinitely.
    clearTimeout(this._recordingTimer);
    this._recordingTimer = setTimeout(() => {
      if (this.recording) this.stop("time-limit");
    }, this.maxRecordingMs);
    if (typeof this._recordingTimer.unref === "function") this._recordingTimer.unref();

    this._touchIdle();
    return true;
  }

  stop(reason = "user") {
    if (!this.term || !this.recording) return false;
    clearTimeout(this._recordingTimer);
    this.term.write("/stop\r");
    this.recording = false;
    // Stop listening before the CLI repaints, so the finished transcript is
    // exactly what was said and nothing is counted twice.
    this._accepting = false;

    // Anything still being decided is the final segment.
    this._settle();
    this.emit("stopped", { reason, transcript: this.transcript() });
    this._touchIdle();
    return true;
  }

  transcript() {
    return this.committed.concat(this.active ? [this.active] : []).join(" ").replace(/\s+/g, " ").trim();
  }

  // An idle session keeps a speech model in memory for no reason, so it closes
  // itself after a period of inactivity.
  _touchIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this.recording) this.close();
    }, this.idleTimeoutMs);
    // The timer must never be the reason the process stays alive: Horizon
    // should exit when it is asked to, not when a dictation timeout expires.
    if (typeof this._idleTimer.unref === "function") this._idleTimer.unref();
  }

  _clearTimers() {
    clearTimeout(this._recordingTimer);
    clearTimeout(this._idleTimer);
    clearTimeout(this._readyTimer);
  }

  close() {
    this._clearTimers();
    if (!this.term) return Promise.resolve();
    const term = this.term;
    const wasRecording = this.recording;
    this.recording = false;
    this.term = null;

    // Resolves once the process is really gone. Callers that need the audio
    // stream released — anything about to unload the model — have to wait for
    // this, because the stream is held until the CLI exits.
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      try {
        term.onExit(finish);
      } catch {
        // Older builds may not expose it; the timeout below covers that.
      }

      try {
        // Stopping and exiting are two separate things to the CLI, and exiting
        // while a recording is live leaves the daemon holding the stream for
        // the next session to trip over.
        if (wasRecording) term.write("/stop\r");
      } catch {
        return finish();
      }

      setTimeout(() => {
        try {
          term.write("/exit\r");
        } catch {
          return finish();
        }
        setTimeout(() => {
          try {
            term.kill();
          } catch {
            // Already exited.
          }
          // Give the daemon a moment to notice the process has gone.
          setTimeout(finish, 700);
        }, 900);
      }, wasRecording ? 800 : 0);
    });
  }
}

/*
 * Releasing a stranded audio session.
 *
 * Foundry keeps a streaming session open against the speech model, and that
 * session belongs to the daemon rather than to Horizon. If the CLI dies without
 * being asked to stop — the machine was shut down, the server was killed, a
 * window was closed — the session stays open, and every later attempt fails
 * with "a streaming session is already active". The daemon outlives Horizon, so
 * restarting Horizon alone does not clear it.
 *
 * Unloading the model releases the session with it, which is the same thing
 * Horizon already does to give memory back.
 */
function releaseStrandedSession(alias, execFileImpl = execFile) {
  return new Promise(resolve => {
    const command = resolveCommand();
    if (!command || !alias) return resolve(false);
    execFileImpl(command, ["model", "unload", alias], { timeout: 30000, windowsHide: true },
      error => resolve(!error));
  });
}

// Whether live dictation can run on this machine at all, so the page can say so
// plainly instead of offering a button that cannot work.
function capability() {
  const pty = loadPty();
  if (!pty.module) {
    return { available: false, reason: `node-pty is not installed: ${pty.error}` };
  }
  if (!resolveCommand()) {
    return { available: false, reason: "The Foundry CLI could not be found on this machine." };
  }
  return { available: true, reason: null };
}

module.exports = {
  DictationSession,
  capability,
  resolveCommand,
  releaseStrandedSession,
  stripAnsi,
  isChrome,
  PTY_COLUMNS
};
