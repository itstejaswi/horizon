"use strict";

const db = window.HorizonStore;
const $ = id => document.getElementById(id);

const ui = {
  thread: $("thread"), empty: $("empty"), prompt: $("prompt"), send: $("send"),
  sendIcon: $("send-icon"), note: $("note"),
  banner: $("banner"), bannerText: $("banner-text"),
  chatTitle: $("chat-title"), chatTitleText: $("chat-title-text"),
  threadHead: $("thread-head"), threadMeta: $("thread-meta"),
  newChat: $("new-chat"), promptLibrary: $("prompt-library"),
  drawer: $("drawer"), drawerTitle: $("drawer-title"), drawerBody: $("drawer-body"),
  drawerClose: $("drawer-close"), scrim: $("scrim"),
  pickerBtn: $("picker-btn"), pickerMenu: $("picker-menu"),
  composer: $("composer"), attachments: $("attachments"),
  urlWarning: $("url-warning"), urlWarningText: $("url-warning-text"),
  attachBtn: $("attach-btn"), attachInput: $("attach-input"),
  pickerLabel: $("picker-label"), pickerDot: $("picker-dot"),
  airgapBadge: $("airgap-badge"), airgapText: $("airgap-text"), airgapGlyph: $("airgap-glyph")
};

const state = {
  chat: null,
  defaults: null,
  // Model identity is retained in details; assistant turns use the Horizon name.
  assistantLabel: "Model",
  busy: false,
  controller: null,
  drawer: null,
  models: [],
  // Whether the model list has actually been fetched. Distinct from an empty
  // list: "none downloaded" and "not asked yet" must not read the same.
  modelsKnown: false,
  activeAlias: null,
  wire: [],
  wireCount: 0,
  endpoint: null,
  modelReady: false,
  settings: { systemPrompt: "", temperature: 0.7 },
  // Files staged for the next message. Never uploaded anywhere: the text is
  // read in the browser and folded into the message itself.
  attachments: [],
  limits: null,
  // Remembered so the air-gap badge can say that Horizon reached out, after
  // the amber has faded. A signal nobody saw is not a signal.
  lastReachedOut: null,
  toolPrivacy: null,
};

const LOG_CAP = 20;
const BODY_CAP = 4000;

db.onError = message => setNote(message, "error");

/* ============================================================== helpers === */

function setNote(text, tone) {
  ui.note.textContent = text;
  ui.note.className = `foot-note${tone ? ` is-${tone}` : ""}`;
}

function showBanner(text, tone) {
  ui.bannerText.textContent = text;
  ui.banner.dataset.tone = tone || "warn";
  ui.banner.hidden = false;
}

function hideBanner() { ui.banner.hidden = true; }

function icon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (className) svg.setAttribute("class", className);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* ============================================================ app height == */

// The browser can report the dynamic viewport before its own chrome has
// settled, so on first load the shell can be taller than the window it sits
// in -- measured at 978px inside a 950px window, which pushes the composer
// off the bottom until something forces a resize.
//
// So the height is measured rather than trusted. clientHeight excludes any
// scrollbar and is the honest number.
function syncAppHeight() {
  const height = document.documentElement.clientHeight;
  if (height > 0) document.documentElement.style.setProperty("--app-height", `${height}px`);
}

syncAppHeight();
addEventListener("resize", syncAppHeight);
addEventListener("orientationchange", syncAppHeight);
// Fires when the on-screen keyboard or a browser bar changes the usable area
// without a classic resize event.
if (window.visualViewport) {
  visualViewport.addEventListener("resize", syncAppHeight);
}
// Two extra passes: one after layout settles, one after web fonts land, both
// of which can shift the reported viewport slightly.
requestAnimationFrame(syncAppHeight);
addEventListener("load", syncAppHeight);
if (document.fonts?.ready) document.fonts.ready.then(syncAppHeight);

/* ================================================================ backup === */

// Everything the user creates lives in the browser. That is private, but it is
// also fragile: clearing browser data wipes it, and another browser cannot see
// it. So the user may opt into a copy on disk, which this keeps up to date.
//
// Writes are debounced. Every keystroke in the settings panel would otherwise
// rewrite the whole file.
const backupState = { enabled: false, timer: null, saving: false, lastError: null };

async function refreshBackupState() {
  try {
    const status = await (await fetch("/api/backup")).json();
    backupState.enabled = Boolean(status.enabled);
    return status;
  } catch {
    backupState.enabled = false;
    return null;
  }
}

function scheduleBackup() {
  if (!backupState.enabled) return;
  clearTimeout(backupState.timer);
  backupState.timer = setTimeout(saveBackup, 1500);
}

async function saveBackup() {
  if (!backupState.enabled || backupState.saving) return;
  backupState.saving = true;
  try {
    const response = await fetch("/api/backup/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: db.exportAll() })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "The copy on disk could not be written.");
    }
    backupState.lastError = null;
  } catch (error) {
    // Said once rather than on every attempt, so a failing disk does not bury
    // the conversation under identical warnings.
    if (backupState.lastError !== error.message) {
      backupState.lastError = error.message;
      setNote(error.message, "warn");
    }
  } finally {
    backupState.saving = false;
  }
}

// Called at startup when the browser has nothing but a copy exists on disk --
// a new browser, a new profile, or cleared browsing data.
async function offerRestore() {
  if (!backupState.enabled) return false;

  const isEmpty = !db.chats().length && !db.library().length && !db.memory().facts.length;
  if (!isEmpty) return false;

  let record;
  try {
    const response = await fetch("/api/backup/data");
    if (!response.ok) return false;
    record = await response.json();
  } catch {
    return false;
  }

  if (!record?.data) return false;

  const when = record.savedAt ? new Date(record.savedAt).toLocaleString() : "earlier";
  const counts = record.data.chats?.length || 0;
  if (!window.confirm(
    `Horizon found a saved copy of your data from ${when} (${counts} conversation${counts === 1 ? "" : "s"}).\n\n` +
    "This browser has none. Restore it?")) {
    return false;
  }

  db.importAll(record.data, { mode: "replace" });
  return true;
}

/* ============================================================ url warning == */

// A model cannot open a link. It reads the words in the URL and writes
// plausible prose around them, which is convincing and frequently wrong --
// tested with an invented Reuters URL, and it produced a detailed summary of
// an event that never happened.
//
// Blocking would be wrong: pasting a link as context is legitimate. So the
// composer says plainly what will happen, once, and stays out of the way.
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i;

// Reflects the setting rather than assuming it, so the composer can say what
// will actually happen with a pasted link.
const readerState = { enabled: false, maxChars: 12000 };

async function refreshReaderState() {
  try {
    const status = await (await fetch("/api/reader")).json();
    readerState.enabled = Boolean(status.enabled);
    readerState.maxChars = status.maxChars || readerState.maxChars;
  } catch {
    readerState.enabled = false;
  }
}

function updateUrlWarning() {
  const hasUrl = URL_PATTERN.test(ui.prompt.value);
  ui.urlWarning.hidden = !hasUrl;
  // Two different messages, because the two situations are different: one is
  // a warning about guessing, the other is a statement of what will happen.
  ui.urlWarning.dataset.mode = readerState.enabled ? "read" : "warn";
  ui.urlWarningText.textContent = readerState.enabled
    ? "Horizon will read this page and give the text to the model. The page stays on this computer."
    : "The model can't open links. It guesses from the address, so details may be invented. Paste the text or attach the page instead.";
}

// Pulls out every link in a message, so a note with two references reads both.
function findUrls(text) {
  const matches = String(text).match(/\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi) || [];
  // The match is case-insensitive, so the scheme test has to be too. Without
  // this, "HTTps://example.com" fails the check and gets a second scheme glued
  // in front of it, producing an address that resolves to nothing recognisable
  // and an error about a certificate for somewhere else entirely.
  return [...new Set(matches.map(url => (/^https?:\/\//i.test(url) ? url : `https://${url}`)))].slice(0, 3);
}

// Fetched text is wrapped and labelled so the model can tell the page apart
// from the question, and told plainly that it did not write it.
async function readLinkedPages(message) {
  if (!readerState.enabled) return { text: message, pages: [] };

  const urls = findUrls(message);
  if (!urls.length) return { text: message, pages: [] };

  const pages = [];
  const blocks = [];

  for (const url of urls) {
    let hostname = "";
    try { hostname = new URL(url).hostname; } catch { /* shown as a page instead */ }
    setNote(`Reading ${hostname || url}...`);
    markReachingOut(hostname);
    try {
      const response = await fetch("/api/reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const page = await response.json();
      if (!response.ok) throw new Error(page.error || "That page could not be read.");

      pages.push({ url: page.url, title: page.title, characters: page.characters, truncated: page.truncated });
      blocks.push(
        `--- Page: ${page.title || page.url}\n--- Address: ${page.url}\n${page.text}`
      );
    } catch (error) {
      // A failed read must not lose the message. The model is told the page
      // could not be read, which is far better than letting it guess.
      //
      // What it is told is deliberately plain. The underlying error can be a
      // certificate or DNS dump naming hosts that have nothing to do with the
      // request, and handing that to a model produces an answer about the
      // wrong thing entirely. The reason is kept for the page chip, where the
      // user can see it; the model is simply told the page is not available.
      pages.push({ url, failed: true, reason: error.message });
      blocks.push(`--- Page: ${url}\n--- Could not be read. Do not guess at what it says.`);
      setNote(error.message, "warn");
    } finally {
      clearReachingOut();
    }
  }

  const preamble = "The following page text was fetched for you. Use only what it says. " +
    "If it does not answer the question, say so rather than guessing.";

  return { text: `${preamble}\n\n${blocks.join("\n\n")}\n\n${message}`, pages };
}

/* ================================================================ theme === */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  db.setPref("theme", theme);
  for (const button of document.querySelectorAll("[data-theme-set]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeSet === theme));
  }
}

for (const button of document.querySelectorAll("[data-theme-set]")) {
  button.addEventListener("click", () => applyTheme(button.dataset.themeSet));
}

/* ============================================================== air gap === */

// Two different things share this badge.
//
// At rest it reports whether a network exists at all, read passively from the
// browser's own signal. Actively probing the internet to prove there is no
// internet would defeat the purpose.
//
// While a page is being fetched it becomes an activity light. "Runs locally"
// is a claim anyone can verify, but a fetch is a real event happening now and
// should be visible rather than only afterwards in the Traffic panel.
let reachOutTimer = null;

function refreshAirGap() {
  if (ui.airgapBadge.dataset.state === "reaching") return;

  const online = navigator.onLine;
  const externalTools = state.toolPrivacy?.externalToolsEnabled || state.toolPrivacy?.externalToolsUsed;
  ui.airgapBadge.dataset.state = online ? "online" : "isolated";

  // The wording leads with what Horizon guarantees - that it runs on this
  // machine - rather than reporting the network as though it were a feature.
  ui.airgapText.textContent = online ? (externalTools ? "External tools" : "Connected local") : "Network unavailable";
  // A badge that only lights up while something is happening is no use to
  // anyone who looked away. Once Horizon has reached out, the badge keeps
  // saying so, and pressing it shows exactly what was fetched and when.
  const lastReach = state.lastReachedOut;
  if (lastReach) {
    ui.airgapBadge.dataset.reached = "true";
    ui.airgapBadge.title = `${lastReach.host ? `Last reached ${lastReach.host}` : "Last reached a page"} at ${lastReach.at}. Inference stays local. Agent activity is recorded separately under Agents.`;
  } else {
    delete ui.airgapBadge.dataset.reached;
    ui.airgapBadge.title = online
      ? (externalTools
          ? "Inference is local, but enabled or previously used agent tools can access the network. Agents has their activity history; Traffic covers chat requests only."
          : "Inference connects to the local server. Link reading and enabled external tools can use the network. Traffic covers chat requests, not a system-wide network audit.")
      : "The browser reports no network connection. Local tools still work; this signal is not a system-wide network audit.";
  }

  const use = ui.airgapGlyph && ui.airgapGlyph.querySelector("use");
  if (use) use.setAttribute("href", online ? "#i-plug-on" : "#i-globe-off");
  if (state.drawer === "connection") renderDrawer();
}

// The badge makes a claim, so it has to be possible to check it. Pressing it
// opens the request log, which is the evidence: every exchange Horizon has had,
// and the address each one went to. A promise with no way to verify it is
// worth very little.
function openTrafficLog() {
  setMode("settings");
  settingsSection = "ollama";
  renderSettings();
  const log = document.getElementById("wire-log") || $("settings-body");
  if (log && log.scrollIntoView) log.scrollIntoView({ block: "end", behavior: "smooth" });
}

// Called around a page fetch. The host is named, because "something reached
// out" is alarming and "reading example.com" is a fact.
//
// Deliberately not called the model reaching out: the model has no network
// access of its own. Horizon fetches the page and hands over the text.
function markReachingOut(hostname) {
  clearTimeout(reachOutTimer);
  reachOutTimer = null;

  ui.airgapBadge.dataset.state = "reaching";
  // The address is already in the message the user just sent, so repeating it
  // here says nothing new. What matters is the change of state: this is no
  // longer local.
  ui.airgapText.textContent = "Connecting to internet";
  // Remembered, so the badge can still say this happened once the amber has
  // faded. Someone who was reading the reply rather than watching the footer
  // should still be able to find out.
  state.lastReachedOut = {
    host: hostname || null,
    at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };
  ui.airgapBadge.title = hostname
    ? `Horizon is fetching ${hostname} so the model can read it. The page text stays on this machine. Press to see the request.`
    : "Horizon is fetching a page so the model can read it. The page text stays on this machine. Press to see the request.";

  const use = ui.airgapGlyph && ui.airgapGlyph.querySelector("use");
  if (use) use.setAttribute("href", "#i-globe");
  if (state.drawer === "connection") renderDrawer();
}

// Held after the fetch finishes, because this is the only signal that anything
// left the machine and a flicker is worth nothing. Ten seconds is long enough
// to be noticed by someone who was reading rather than watching the footer, and
// the badge stays pressable throughout: the request log is the lasting record.
function clearReachingOut() {
  clearTimeout(reachOutTimer);
  reachOutTimer = setTimeout(() => {
    reachOutTimer = null;
    if (ui.airgapBadge.dataset.state === "reaching") {
      ui.airgapBadge.dataset.state = "";
      refreshAirGap();
    }
  }, 10000);
}

window.addEventListener("online", refreshAirGap);
window.addEventListener("offline", refreshAirGap);

/* =============================================================== traffic == */

function logLevel() { return db.prefs().logLevel || "summary"; }

// Payloads can be very large. Nothing is retained beyond the configured level,
// and full bodies are truncated, so the page cannot accumulate megabytes.
function logWire(direction, title, payload, bytes) {
  const level = logLevel();
  if (level === "off") return;

  const entry = { direction, title, at: Date.now(), bytes };

  if (level === "full") {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    entry.body = text.length > BODY_CAP
      ? `${text.slice(0, BODY_CAP)}\n\n... truncated, ${formatBytes(text.length - BODY_CAP)} more not shown.`
      : text;
  }

  state.wire.unshift(entry);
  if (state.wire.length > LOG_CAP) state.wire.length = LOG_CAP;
  state.wireCount += 1;

  if (state.drawer === "traffic") renderDrawer();
}

/* ================================================================ render == */

// Emphasis, written into a fragment rather than through innerHTML: everything
// here arrives from a model, and a model can be talked into emitting markup.
// Building nodes by hand means a stray tag is text, not structure.
//
// Deliberately small. Models reach for **bold** constantly and for little else
// in ordinary prose, and an unrendered ** is worse than no formatting at all.
function appendInline(parent, text) {
  // Bold is matched freely. Single asterisks are only emphasis when they hug
  // the words they mark: "3 * 4 * 5" is arithmetic, not italics, and a chat
  // window sees more arithmetic than it sees emphasis.
  const pattern = /\*\*([^*]+)\*\*|(?<![*\w])\*(\S[^*\n]*\S|\S)\*(?!\w)/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parent.append(document.createTextNode(text.slice(last, match.index)));
    }
    if (match[1] !== undefined) {
      parent.append(el("strong", null, match[1]));
    } else {
      parent.append(el("em", null, match[2]));
    }
    last = pattern.lastIndex;
  }

  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderInto(container, text) {
  const value = String(text);

  // The streaming reveal calls this on every animation frame, so the common
  // case -- prose with no markup at all -- takes a cheap path that leaves the
  // DOM alone rather than tearing it down and rebuilding it sixty times a
  // second. "#" and "-" are cheap to test and rule out headings and rules.
  if (!/[`*#]/.test(value) && !value.includes("---")) {
    if (container.childNodes.length === 1 && container.firstChild.nodeType === 3) {
      if (container.firstChild.nodeValue !== value) container.firstChild.nodeValue = value;
    } else {
      container.textContent = value;
    }
    return;
  }

  container.textContent = "";
  const segments = value.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith("```")) {
      const inner = segment.slice(3, -3).replace(/^[^\n]*\n/, "");
      const pre = el("pre");
      const code = el("code");
      code.textContent = inner;
      pre.append(code);
      container.append(pre);
    } else if (segment.startsWith("`") && segment.endsWith("`") && segment.length > 2) {
      container.append(el("code", null, segment.slice(1, -1)));
    } else {
      // Headings and rules are line-level, so they are read outside code, where
      // a leading "#" is a comment and a row of dashes is very often just that.
      appendBlocks(container, segment);
    }
  }
}

// Models structure long answers with "### Step 1" and "---" whether or not
// anyone asked them to. Left alone these print as literal hashes and rows of
// dashes, which is worse than no structure at all.
function appendBlocks(container, text) {
  const lines = text.split("\n");
  let run = [];

  const flush = () => {
    if (!run.length) return;
    appendInline(container, run.join("\n"));
    run = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    // Three or more dashes on a line of their own. A shorter run, or one with
    // words beside it, is punctuation rather than a divider.
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

    if (heading) {
      flush();
      // Capped at h4: these sit inside a message, so a heading must not
      // outweigh the page around it.
      const level = Math.min(heading[1].length + 2, 4);
      const node = el(`h${level}`, "md-h");
      appendInline(node, heading[2].trim());
      container.append(node);
    } else if (rule) {
      flush();
      container.append(el("hr", "md-rule"));
    } else {
      run.push(line);
    }
  }

  flush();
}

// A tag can be cut in half by the reveal, which advances a few characters at a
// time. Held back, the fragment costs a frame or two; printed, it shows "<thi"
// in the bubble and then takes it away again.
function withoutPartialTag(text, tag) {
  for (let n = tag.length - 1; n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return text.slice(0, -n);
  }
  return text;
}

// Only trims while more text is still coming: an answer that genuinely ends in
// "<" keeps it once the reply is complete.
function splitThinking(text, partial = false) {
  const hide = part => (partial ? withoutPartialTag(text, part) : text);

  const open = text.indexOf("<think>");
  if (open === -1) return { thinking: "", answer: hide("<think>") };

  const close = text.indexOf("</think>");
  const body = text.slice(open + 7);
  if (close === -1) {
    return {
      thinking: partial ? withoutPartialTag(body, "</think>") : body,
      answer: ""
    };
  }
  return { thinking: text.slice(open + 7, close), answer: (text.slice(0, open) + text.slice(close + 8)).trim() };
}

// "Working it out" while it is happening, "Thought for 8s" once it is over: the
// present tense is a lie the moment the reasoning stops, and on a small model
// the time it took is worth knowing.
//
// Takes null while the reasoning is still arriving. A number means finished,
// including zero: a fast model can open and close its reasoning inside one
// chunk, and "0.0s" is a truer answer than claiming it is still thinking.
function thinkingLabel(ms) {
  if (ms === null || ms === undefined) return "Working it out";
  const seconds = ms / 1000;
  if (seconds < 60) return `Thought for ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `Thought for ${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function createTurn(role, label) {
  if (ui.empty.isConnected) ui.empty.remove();
  // The first turn of a conversation is what brings the title into view.
  ui.threadHead.hidden = false;

  const turn = el("div", `turn ${role}`);
  const avatar = el("div", "avatar");
  avatar.append(icon(role === "user" ? "i-person" : "i-model-on"));

  const main = el("div", "turn-main");
  const meta = el("div", "turn-meta", role === "assistant" ? "Horizon" : label);
  const bubble = el("div", "bubble");
  main.append(meta, bubble);

  turn.append(avatar, main);
  ui.thread.append(turn);
  return { turn, bubble, main };
}

// Collapses very long messages so a single pasted document cannot bury the
// rest of the conversation.
function clampIfLong(bubble, main) {
  if (bubble.scrollHeight <= 300) return;
  bubble.classList.add("is-clamped");

  const button = el("button", "expand-btn", "Show the whole message");
  button.type = "button";
  button.addEventListener("click", () => {
    const clamped = bubble.classList.toggle("is-clamped");
    button.textContent = clamped ? "Show the whole message" : "Show less";
  });
  main.insertBefore(button, main.querySelector(".turn-tools"));
}

function addTools(turn, main, getText) {
  const tools = el("div", "turn-tools");
  const copy = el("button", "btn-subtle");
  copy.type = "button";
  copy.append(icon("i-copy", "btn-subtle-icon"), document.createTextNode("Copy"));
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      copy.textContent = "";
      copy.append(icon("i-check", "btn-subtle-icon"), document.createTextNode("Copied"));
      setTimeout(() => {
        copy.textContent = "";
        copy.append(icon("i-copy", "btn-subtle-icon"), document.createTextNode("Copy"));
      }, 1600);
    } catch { setNote("Copying is blocked by the browser.", "warn"); }
  });

  const save = el("button", "btn-subtle");
  save.type = "button";
  save.append(icon("i-bookmark", "btn-subtle-icon"), document.createTextNode("Save"));
  save.addEventListener("click", () => {
    db.addToLibrary({ text: getText(), model: state.assistantLabel, chatTitle: state.chat?.title || "" });
    setNote("Saved to your library.");
    save.textContent = "";
    save.append(icon("i-check", "btn-subtle-icon"), document.createTextNode("Saved"));
  });

  tools.append(copy, save);
  if (turn.classList.contains("assistant")) {
    window.HorizonSpeech?.attach(tools, getText);
  }
  main.append(tools);
}

function renderChat() {
  ui.thread.textContent = "";
  const turns = state.chat?.turns || [];

  // The banner and head are persistent nodes, so they must be re-attached
  // after the wipe, in that order, above every turn.
  ui.thread.append(ui.banner, ui.threadHead);
  ui.threadHead.hidden = !turns.length;
  ui.chatTitleText.textContent = state.chat?.title || "New chat";

  if (!turns.length) {
    ui.thread.append(ui.empty);
    return;
  }

  updateThreadMeta();

  for (const turn of turns) {
    const label = turn.role === "user" ? "You" : (turn.model || state.assistantLabel);
    const node = createTurn(turn.role, label);
    const { thinking, answer } = splitThinking(turn.content);

    if (thinking) {
      const details = el("details", "thinking");
      const summary = el("summary");
      // A replayed turn has finished by definition, so an absent duration means
      // it was recorded before durations were kept -- not that it is still
      // thinking. Zero is used, which reads as "no time worth reporting".
      summary.append(icon("i-orbit", "thinking-glyph"),
        document.createTextNode(thinkingLabel(turn.thoughtMs ?? 0)));
      const body = el("div", null, thinking);
      details.append(summary, body);
      node.bubble.append(details);
    }

    // Fall back to the raw content only when there was no thinking block at
    // all. An unterminated block yields an empty answer, and reprinting the
    // raw text there would dump the <think> markup back into the bubble.
    //
    // A user turn shows what they typed: the page text and the reader's
    // preamble were for the model, and replaying them here would bury the
    // conversation under the pages it read.
    const shown = turn.typed || (thinking ? answer : (answer || turn.content));
    const answerNode = el("span");
    renderInto(answerNode, shown);
    node.bubble.append(answerNode);
    addTools(node.turn, node.main, () => shown);
    clampIfLong(node.bubble, node.main);
  }

  ui.thread.scrollTop = ui.thread.scrollHeight;
}

/* ================================================================ chats === */

function loadChat(id) {
  if (state.busy) return setNote("Stop the current reply before changing conversations.", "warn");
  const chat = db.chat(id);
  if (!chat) return;
  state.chat = chat;
  db.setPref("activeChatId", id);
  renderChat();
  if (state.drawer === "chats") renderDrawer();
}

function startNewChat() {
  if (state.busy) return setNote("Stop the current reply before starting another conversation.", "warn");
  window.HorizonSpeech?.stop();
  state.chat = db.createChat();
  db.setPref("activeChatId", state.chat.id);
  renderChat();
  ui.prompt.focus();
  if (state.drawer === "chats") renderDrawer();
}

function persistTurns() {
  if (!state.chat) return;

  // The first user message makes a far better title than "New chat".
  const patch = { turns: state.chat.turns, toolApprovals: state.chat.toolApprovals };
  if (state.chat.title === "New chat") {
    const first = state.chat.turns.find(turn => turn.role === "user");
    // "typed" is what the person actually wrote. Without it the title comes
    // from the reader's preamble, so every page-reading chat was called
    // "The following page text was fetched for you. Use".
    if (first) {
      const source = first.typed || first.content;
      patch.title = source.slice(0, 48).replace(/\s+/g, " ").trim();
    }
  }

  const updated = db.updateChat(state.chat.id, patch);
  if (updated) {
    state.chat = updated;
    ui.chatTitleText.textContent = updated.title;
    updateThreadMeta();
    if (state.drawer === "chats") renderDrawer();
  }
}

// Kept in one place so the live send path and a full re-render agree.
function updateThreadMeta() {
  const replies = (state.chat?.turns || []).filter(turn => turn.role === "assistant").length;
  ui.threadMeta.textContent = replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "";
}

ui.newChat.addEventListener("click", startNewChat);

ui.chatTitle.addEventListener("click", () => {
  if (!state.chat) return;
  const title = window.prompt("Name this chat", state.chat.title);
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) return;
  state.chat = db.updateChat(state.chat.id, { title: trimmed });
  ui.chatTitleText.textContent = trimmed;
  if (state.drawer === "chats") renderDrawer();
});

/* =============================================================== drawer === */

const DRAWERS = {
  chats: "History",
  prompts: "Prompts",
  memory: "Memory",
  library: "Library",
  connection: "Connection"
};
// A drawer is a panel over the conversation, so opening one returns to the
// conversation first. Opening History from Settings used to leave the Settings
// page behind the panel, so closing it landed you somewhere you had left.
function openDrawer(name) {
  if (state.drawer === name) return closeDrawer();
  if (state.mode !== "chat") setMode("chat");
  state.drawer = name;
  ui.drawer.hidden = false;
  ui.scrim.hidden = false;
  ui.drawerTitle.textContent = DRAWERS[name];
  setRailState();
  renderDrawer();
}

function closeDrawer() {
  state.drawer = null;
  ui.drawer.hidden = true;
  ui.scrim.hidden = true;
  setRailState();
}

// Fluent uses the Filled style for selected navigation and Regular otherwise.
function setRailState() {
  for (const button of document.querySelectorAll("[data-drawer]")) {
    const selected = button.dataset.drawer === state.drawer;
    button.setAttribute("aria-pressed", String(selected));
    const use = button.querySelector("svg use");
    const base = button.dataset.icon;
    if (use && base) use.setAttribute("href", selected ? `#${base}-on` : `#${base}`);
  }
}

for (const button of document.querySelectorAll("[data-drawer]")) {
  button.addEventListener("click", () => openDrawer(button.dataset.drawer));
}
$("help-btn").addEventListener("click", () => {
  // Toggles, so the same button returns you to the conversation.
  setMode(state.mode === "about" ? "chat" : "about");
});
$("settings-btn").addEventListener("click", () => {
  setMode(state.mode === "settings" ? "chat" : "settings");
});
ui.drawerClose.addEventListener("click", closeDrawer);
ui.scrim.addEventListener("click", closeDrawer);

function emptyMessage(iconName, text) {
  const wrap = el("div", "drawer-empty");
  wrap.append(icon(iconName), el("div", null, text));
  return wrap;
}

function renderDrawer() {
  const body = ui.drawerBody;
  body.textContent = "";

  const render = {
    chats: renderChatsDrawer,
    prompts: renderPromptsDrawer,
    memory: renderMemoryDrawer,
    library: renderLibraryDrawer,
    connection: renderConnectionDrawer
  }[state.drawer];

  if (render) render(body);
}

/* --- chats ---------------------------------------------------------------- */

function renderChatsDrawer(body) {
  const chats = db.chats();

  if (!chats.length) {
    body.append(emptyMessage("i-chat", "No chats yet. Start one from the plus button."));
    return;
  }

  const list = el("div", "list");
  for (const chat of chats) {
    const item = el("div", "list-item");
    item.dataset.active = String(chat.id === state.chat?.id);

    const text = el("div", "list-text");
    text.append(
      el("div", "list-title", chat.title),
      el("div", "list-sub", `${chat.turns.length} message${chat.turns.length === 1 ? "" : "s"} \u00B7 ${relativeTime(chat.updatedAt)}`)
    );

    const actions = el("div", "list-actions");
    const remove = el("button", "mini-btn is-danger");
    remove.type = "button";
    remove.title = "Delete this chat";
    remove.append(icon("i-trash"));
    remove.addEventListener("click", event => {
      event.stopPropagation();
      db.deleteChat(chat.id);
      if (state.chat?.id === chat.id) {
        const next = db.chats()[0];
        if (next) loadChat(next.id); else startNewChat();
      }
      renderDrawer();
    });
    actions.append(remove);

    item.append(icon("i-chat", "list-icon"), text, actions);
    item.addEventListener("click", () => loadChat(chat.id));
    list.append(item);
  }
  body.append(list);

  const foot = el("div", "drawer-foot");
  foot.append(el("span", "panel-note", `${chats.length} saved on this machine`));
  const clearAll = el("button", "btn-subtle is-danger");
  clearAll.type = "button";
  clearAll.append(icon("i-trash", "btn-subtle-icon"), document.createTextNode("Delete all"));
  clearAll.addEventListener("click", () => {
    if (!window.confirm("Delete every saved chat? This cannot be undone.")) return;
    db.clearAllChats();
    startNewChat();
    renderDrawer();
  });
  foot.append(clearAll);
  body.append(foot);
}

/* --- prompts -------------------------------------------------------------- */

function renderPromptsDrawer(body) {
  const note = el("p", "panel-note", "Reusable openings. Selecting one puts it in the message box, ready for you to finish.");
  body.append(note);

  const list = el("div", "list");
  for (const prompt of db.prompts()) {
    const item = el("div", "list-item");
    const text = el("div", "list-text");
    text.append(el("div", "list-title", prompt.title), el("div", "list-sub", prompt.body.slice(0, 60)));

    const actions = el("div", "list-actions");
    const remove = el("button", "mini-btn is-danger");
    remove.type = "button";
    remove.title = "Delete";
    remove.append(icon("i-trash"));
    remove.addEventListener("click", event => {
      event.stopPropagation();
      db.deletePrompt(prompt.id);
      renderDrawer();
    });
    actions.append(remove);

    item.append(icon("i-bookmark", "list-icon"), text, actions);
    item.addEventListener("click", () => {
      ui.prompt.value = prompt.body;
      autoGrow();
      ui.prompt.focus();
      ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
      closeDrawer();
    });
    list.append(item);
  }
  body.append(list);

  const add = el("div", "field");
  const label = el("label");
  label.append(icon("i-plus", "field-icon"), document.createTextNode("Add a prompt"));
  const titleInput = el("input", "text-input");
  titleInput.placeholder = "Name";
  const bodyInput = el("textarea");
  bodyInput.rows = 3;
  bodyInput.placeholder = "The text to insert...";
  const save = el("button", "btn-primary", "Save prompt");
  save.type = "button";
  save.addEventListener("click", () => {
    if (!titleInput.value.trim() || !bodyInput.value.trim()) return;
    db.addPrompt(titleInput.value.trim(), bodyInput.value);
    renderDrawer();
  });
  add.append(label, titleInput, bodyInput, save);
  body.append(add);
}

/* --- memory --------------------------------------------------------------- */

function renderMemoryDrawer(body) {
  const memory = db.memory();

  body.append(el("p", "panel-note",
    "Facts you want remembered across every chat. They are added to the model's instructions each time you send a message."));

  const row = el("div", "switch");
  row.append(el("span", "list-title", "Use memory"));
  const toggle = el("button", "switch-track");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(memory.enabled));
  toggle.addEventListener("click", () => {
    db.setMemoryEnabled(!db.memory().enabled);
    renderDrawer();
  });
  row.append(toggle);
  body.append(row);

  if (!memory.facts.length) {
    body.append(emptyMessage("i-brain", "Nothing remembered yet."));
  } else {
    const list = el("div", "list");
    for (const fact of memory.facts) {
      const item = el("div", "list-item");
      const text = el("div", "list-text");
      text.append(el("div", "list-title", fact.text));

      const actions = el("div", "list-actions");
      const remove = el("button", "mini-btn is-danger");
      remove.type = "button";
      remove.title = "Forget";
      remove.append(icon("i-trash"));
      remove.addEventListener("click", () => { db.deleteFact(fact.id); renderDrawer(); });
      actions.append(remove);

      item.append(icon("i-brain", "list-icon"), text, actions);
      list.append(item);
    }
    body.append(list);
  }

  const add = el("div", "field");
  const label = el("label");
  label.append(icon("i-plus", "field-icon"), document.createTextNode("Remember something"));
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = "I prefer concise answers with examples.";
  const save = el("button", "btn-primary", "Remember");
  save.type = "button";
  save.addEventListener("click", () => {
    if (!input.value.trim()) return;
    db.addFact(input.value.trim());
    renderDrawer();
  });
  add.append(label, input, save);
  body.append(add);

  if (memory.facts.length) {
    const foot = el("div", "drawer-foot");
    foot.append(el("span", "panel-note", `${memory.facts.length} remembered`));
    const clear = el("button", "btn-subtle is-danger");
    clear.type = "button";
    clear.append(icon("i-trash", "btn-subtle-icon"), document.createTextNode("Forget all"));
    clear.addEventListener("click", () => {
      if (!window.confirm("Forget everything in memory?")) return;
      db.clearMemory();
      renderDrawer();
    });
    foot.append(clear);
    body.append(foot);
  }
}

/* --- library -------------------------------------------------------------- */

function renderLibraryDrawer(body) {
  const items = db.library();

  if (!items.length) {
    // The empty state has to teach the feature, because the Save button lives
    // under a message rather than in here.
    const empty = el("div", "drawer-empty");
    empty.append(icon("i-library"));
    empty.append(el("div", null, "Nothing saved yet."));
    const how = el("div", "drawer-empty-how");
    how.append(
      document.createTextNode("Hover any answer and choose "),
      icon("i-bookmark", "inline-glyph"),
      el("strong", null, "Save"),
      document.createTextNode(" to keep it here.")
    );
    empty.append(how);
    body.append(empty);
    return;
  }

  body.append(el("p", "panel-note", "Replies you chose to keep. Use Save under any answer."));

  const list = el("div", "list");
  for (const item of items) {
    const row = el("div", "list-item");
    const text = el("div", "list-text");
    text.append(
      el("div", "list-title", item.text.slice(0, 60)),
      el("div", "list-sub", `${item.model || "model"} \u00B7 ${relativeTime(item.savedAt)}`)
    );

    const actions = el("div", "list-actions");
    const copy = el("button", "mini-btn");
    copy.type = "button";
    copy.title = "Copy";
    copy.append(icon("i-copy"));
    copy.addEventListener("click", async event => {
      event.stopPropagation();
      try { await navigator.clipboard.writeText(item.text); setNote("Copied."); } catch { /* blocked */ }
    });
    const remove = el("button", "mini-btn is-danger");
    remove.type = "button";
    remove.title = "Delete";
    remove.append(icon("i-trash"));
    remove.addEventListener("click", event => {
      event.stopPropagation();
      db.deleteFromLibrary(item.id);
      renderDrawer();
    });
    actions.append(copy, remove);

    row.append(icon("i-library", "list-icon"), text, actions);
    list.append(row);
  }
  body.append(list);

  const foot = el("div", "drawer-foot");
  foot.append(el("span", "panel-note", `${items.length} saved`));
  const clear = el("button", "btn-subtle is-danger");
  clear.type = "button";
  clear.append(icon("i-trash", "btn-subtle-icon"), document.createTextNode("Clear"));
  clear.addEventListener("click", () => {
    if (!window.confirm("Delete everything in your library?")) return;
    db.clearLibrary();
    renderDrawer();
  });
  foot.append(clear);
  body.append(foot);
}

/* --- about and privacy ---------------------------------------------------- */

// Horizon, Ollama and the selected model are separate parts of the local
// setup. This describes what each does without conflating their guarantees.
function renderAbout() {
  const body = $("about-body");
  body.textContent = "";

  const pane = el("div", "about-pane");
  body.append(pane);

  pane.append(el("h2", "about-lede",
    "Horizon orchestrates models and tools on your own computer."));
  pane.append(el("p", "about-sub",
    "Three separate pieces are involved, and they make different promises. Here is what each one does, what we can promise, and what we cannot."));

  const grid = el("div", "about-grid");
  pane.append(grid);

  const layer = (title, tone, lines, link) => {
    const card = el("div", "help-card");
    if (tone) card.dataset.tone = tone;

    const head = el("div", "help-card-head");
    head.append(el("span", "help-card-title", title));
    card.append(head);

    for (const line of lines) card.append(el("p", "help-line", line));

    if (link) {
      const anchor = el("a", "doc-link", link.text);
      anchor.href = link.href;
      anchor.target = "_blank";
      anchor.rel = "noreferrer noopener";
      anchor.append(icon("i-up", "doc-link-icon"));
      card.append(anchor);
    }
    grid.append(card);
  };

  layer("Horizon", "good", [
    "This independent application has no telemetry, analytics or author-operated cloud service.",
    `Model inference uses ${runtimeLabel()} on this machine. Optional link reading and agent tools can access the network; their destinations depend on what you enable.`,
    "Chats, prompts and memory stay in this browser unless you enable a disk copy. Agent definitions, permissions, schedules and run history are stored separately on disk."
  ]);

  layer("Ollama", null, [
    "Ollama runs the selected model through a loopback endpoint. Horizon does not control the runtime's own policies.",
    "Downloading models accesses the network. Local inference does not require cloud inference or an API key."
  ], { text: "Ollama documentation", href: "https://docs.ollama.com/" });

  layer("The model", null, [
    "A third party's work, running locally. It has no network access of its own; Horizon may execute permitted tools on its behalf in Agent mode.",
    "It answers from training, your messages and supplied tool results. Without fetched page content it may guess from an address and state that guess as fact.",
    "Each model carries its own licence and terms; check them before use."
  ]);

  const covenant = el("div", "help-card is-wide");
  covenant.dataset.tone = "warn";
  covenant.append(el("span", "help-card-title", "If you connect a model to live data"));
  covenant.append(el("p", "help-line",
    "Horizon can fetch a page you paste and hand the text to your model. That is your choice to make, and these are the trade-offs:"));

  const risks = el("ul", "help-list");
  for (const risk of [
    "The request leaves this computer. The site sees your address, as it would from any browser.",
    "Fetched text is processed by your local model. Authorised browser actions, commands or MCP tools can send data elsewhere; Horizon does not send it to its author.",
    "Anything fetched is untrusted text. A page can contain instructions aimed at the model.",
    "Private and local addresses are always blocked, so a pasted link cannot reach devices on your network."
  ]) {
    risks.append(el("li", null, risk));
  }
  covenant.append(risks);
  grid.append(covenant);

  /* --- who made what ---------------------------------------------------- */

  // Keep the project and the runtime attribution distinct.
  const credits = el("div", "about-credits");

  const mine = el("div", "about-credit");
  const mineHead = el("div", "about-credit-head");
  mineHead.append(horizonMark(), el("h3", "about-credit-title", "About Horizon"));
  mine.append(mineHead);
  mine.append(el("p", "about-credit-body",
    "Horizon is an independent, local-first personal project for local AI models, optional tools and automations. It requires no Horizon account or paid inference API. External capabilities are off by default and have separate permissions. It is not a Microsoft product."));

  // The author's page, named as a link rather than as prose, because someone
  // reading the credits is the one person likely to want it. It opens in the
  // browser like any other link; Horizon sends nothing.
  const authorUrl = state.app?.contactUrl;
  const byline = el("p", "about-credit-body");
  byline.append(document.createTextNode("Designed and built by "));
  if (authorUrl) {
    const link = el("a", "about-credit-link");
    link.href = authorUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = state.app?.author || "Tejaswi";
    byline.append(link);
  } else {
    byline.append(document.createTextNode(state.app?.author || "Tejaswi"));
  }
  byline.append(document.createTextNode("."));
  mine.append(byline);

  const theirs = el("div", "about-credit");
  const theirsHead = el("div", "about-credit-head");
  const theirsTitle = el("h3", "about-credit-title");
  const theirsLink = el("a", "about-credit-link", "Ollama");
  theirsLink.href = "https://docs.ollama.com/";
  theirsLink.target = "_blank";
  theirsLink.rel = "noopener noreferrer";
  theirsTitle.append(theirsLink);
  const ollamaMark = el("span", "about-brand-mark");
  ollamaMark.append(icon("i-model"));
  theirsHead.append(ollamaMark, theirsTitle);
  theirs.append(theirsHead);
  theirs.append(el("p", "about-credit-body",
    "Ollama provides the local runtime for AI models. Horizon connects to the Ollama service and helps manage local models; the two projects are independent."));
  theirs.append(el("p", "about-credit-note",
    "Ollama is named here to identify the software Horizon connects to. Horizon is an independent project and is not affiliated with Ollama."));

  credits.append(mine, theirs);
  pane.append(credits);

  /* --- feedback --------------------------------------------------------- */

  // Horizon sends nothing on its own, so the thumbs do not report anything.
  // They open the author's contact page in your browser, with your choice
  // carried in the address so you do not have to explain which one you meant.
  const contactUrl = state.app?.contactUrl;
  if (contactUrl) {
    const feedback = el("div", "about-feedback");
    feedback.append(el("span", "about-feedback-ask", "Is Horizon working well for you?"));

    const buttons = el("div", "about-feedback-actions");
    for (const [tone, glyph, label] of [
      ["up", "i-thumb-up", "Yes"],
      ["down", "i-thumb-down", "Not really"]
    ]) {
      const button = el("button", "btn-subtle");
      button.type = "button";
      button.dataset.tone = tone;
      button.append(icon(glyph, "btn-subtle-icon"), document.createTextNode(label));
      button.addEventListener("click", () => {
        const url = new URL(contactUrl);
        url.searchParams.set("about", "horizon");
        url.searchParams.set("feedback", tone);
        window.open(url.toString(), "_blank", "noopener");
      });
      buttons.append(button);
    }
    feedback.append(buttons);
    feedback.append(el("p", "about-feedback-note",
      "This opens a page in your browser. Horizon does not send your feedback, or anything else, on its own."));
    pane.append(feedback);
  }

  pane.append(el("p", "about-foot",
    "Horizon \u00B7 an independent local orchestrator for models, tools and workflows \u00B7 designed by Tejaswi"));
}

function horizonMark() {
  const wrap = el("span", "about-brand-mark");
  wrap.dataset.brand = "horizon";
  wrap.append(icon("i-mark-xs"));
  return wrap;
}

/* --- connection ----------------------------------------------------------- */

/* --- Ollama control ------------------------------------------------------- */

function runtimeLabel() {
  return "Ollama";
}

async function renderOllamaCard(card) {
  let data;
  try {
    data = await (await fetch("/api/ollama")).json();
  } catch {
    card.textContent = "";
    card.append(el("p", "panel-note", "The local server is not responding."));
    return;
  }

  card.textContent = "";

  const head = el("div", "svc-head");
  const dot = el("span", "svc-dot");
  dot.dataset.state = !data.installed ? "missing" : data.running ? "on" : "off";

  const title = el("div", "svc-title");
  title.append(
    el("span", null, runtimeLabel()),
    el("span", "svc-state", !data.installed ? "Not installed" : data.running ? "Running" : "Stopped")
  );
  head.append(dot, title);
  card.append(head);

  if (!data.installed) {
    card.append(el("p", "panel-note", data.message));

    const steps = el("ol", "setup-steps");
    for (const [text, code] of [
      ["Install Ollama", "winget install Ollama.Ollama"],
      ["Close and reopen this window", null],
      ["Download a model", "ollama pull qwen3:1.7b"]
    ]) {
      const step = el("li");
      step.append(el("span", null, text));
      if (code) step.append(el("code", "setup-code", code));
      steps.append(step);
    }
    card.append(steps);

    const link = el("a", "doc-link", `${runtimeLabel()} documentation`);
    link.href = "https://docs.ollama.com/";
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.append(icon("i-up", "doc-link-icon"));
    card.append(link);
    return;
  }

  const facts = el("div", "svc-facts");
  if (data.version) facts.append(el("div", "svc-fact", `Version ${data.version}`));
  if (data.running && data.uptime) facts.append(el("div", "svc-fact", `Up ${data.uptime}`));
  if (data.running && data.pid) facts.append(el("div", "svc-fact", `PID ${data.pid}`));
  if (data.endpoint) facts.append(el("div", "svc-fact mono", data.endpoint));
  if (facts.childElementCount) card.append(facts);

  if (data.running && !data.modelId) {
    card.append(el("p", "panel-note", "Running, but no model is loaded yet. Choose one from the model picker in the top bar."));
  }

  const actions = el("div", "svc-actions");

  const act = async (label, path, busyLabel) => {
    const button = el("button", label === "Start" ? "btn-primary" : "btn-subtle", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
      button.textContent = busyLabel;
      setNote(`${busyLabel} ${runtimeLabel()}...`);
      try {
        const response = await fetch(path, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "That did not work.");
        setNote(`${runtimeLabel()} ${label === "Stop" ? "stopped" : "is running"}.`);
        await Promise.all([refreshModels(), refreshStatus()]);
        renderDrawer();
      } catch (error) {
        setNote(error.message, "error");
        renderDrawer();
      }
    });
    actions.append(button);
  };

  if (data.running) {
    await act("Restart", "/api/ollama/restart", "Restarting");
    await act("Stop", "/api/ollama/stop", "Stopping");
  } else {
    await act("Start", "/api/ollama/start", "Starting");
  }

  card.append(actions);
}

async function renderConnectionDrawer(body) {
  const online = navigator.onLine;

  // Ollama control comes first: when nothing is connected, this is the
  // panel that lets you do something about it.
  const ollamaCard = el("div", "card");
  ollamaCard.append(el("p", "panel-note", `Checking ${runtimeLabel()}...`));
  body.append(ollamaCard);
  renderOllamaCard(ollamaCard);

  const heading = el("h3", "panel-heading");
  heading.append(icon("i-plug", "heading-icon"), document.createTextNode("Every hop in the chain"));
  body.append(heading);

  const hops = el("ol", "hops");
  body.append(hops);
  const note = el("p", "panel-note", "Checking...");
  body.append(note);

  try {
    const data = await (await fetch("/api/diagnostics")).json();
    hops.textContent = "";

    for (const hop of data.hops) {
      const item = el("li", "hop");
      item.dataset.state = hop.state;

      const hopBody = el("div", "hop-body");
      const label = el("div", "hop-label", hop.label);
      if (hop.latencyMs !== undefined) label.append(el("span", "hop-latency", `${hop.latencyMs} ms`));

      hopBody.append(label, el("div", "hop-detail", hop.detail || ""), el("div", "hop-note", hop.note || ""));
      item.append(el("span", "hop-dot"), hopBody);
      hops.append(item);
    }

    note.textContent = data.allLoopback
      ? "Every inference hop is on loopback. Agent tools and link reading are separate and may use the network."
      : "Warning: a hop in this chain is not on loopback.";
  } catch {
    note.textContent = "The local server is not responding, so the chain cannot be checked.";
  }

  // Privacy summary, one line, with the detail folded away.
  const privacy = el("details", "disclose");
  const summary = el("summary");
  summary.append(
    icon("i-shield", "disclose-icon"),
    el("span", null, online ? "Local inference; optional external tools" : "Browser reports no network"),
    icon("i-chevron", "disclose-chevron")
  );
  const detail = el("div", "disclose-body");
  detail.append(
    el("p", "panel-note", online
      ? "Model inference uses loopback. Link reading, browser tools, configured commands and MCP servers may access the network. Traffic covers chat requests; Agents records tool calls, not every subprocess network request."
      : "Local inference and local file workflows can operate offline. Browser connectivity is only a signal, not proof that every subprocess is disconnected."),
    el("p", "panel-note", `No telemetry, no analytics. Horizon does not control ${runtimeLabel()} or the model itself.`)
  );
  const link = el("a", "doc-link", `${runtimeLabel()} documentation`);
  link.href = "https://docs.ollama.com/";
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.append(icon("i-up", "doc-link-icon"));
  detail.append(link);
  privacy.append(summary, detail);
  body.append(privacy);
}

/* --- traffic -------------------------------------------------------------- */

// Traffic moved out of the rail and into the Ollama section: it describes
// what Horizon sends to the service, so it belongs beside it. Recording stays
// off unless asked for, and nothing ever leaves this computer.
function renderTrafficSettings(panel) {
  const card = settingsCard(panel, "Request log",
    `What Horizon sends to ${runtimeLabel()} and gets back. Kept in memory only, never written to disk.`);

  const level = logLevel();

  const field = el("div", "field");
  const label = el("label");
  label.append(icon("i-pulse", "field-icon"), document.createTextNode("Recording"));

  const select = el("select", "select");
  for (const [value, text] of [
    ["off", "Off"],
    ["summary", "Summary"],
    ["full", "Full"]
  ]) {
    const option = el("option", null, text);
    option.value = value;
    if (value === level) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => {
    db.setPref("logLevel", select.value);
    renderSettings();
  });

  const hint = el("p", "field-hint", {
    off: "Nothing kept.",
    summary: "Sizes and timings only.",
    full: `Bodies kept, capped at ${formatBytes(BODY_CAP)}, last ${LOG_CAP}.`
  }[level]);

  field.append(label, select, hint);
  card.append(field);

  const toolbar = el("div", "panel-toolbar");
  toolbar.append(el("span", "panel-note",
    state.wireCount ? `${state.wireCount} exchange${state.wireCount === 1 ? "" : "s"}` : "Nothing yet"));
  const clear = el("button", "btn-subtle");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => { state.wire = []; state.wireCount = 0; renderSettings(); });
  toolbar.append(clear);
  card.append(toolbar);

  if (level === "off") return;

  const traffic = el("div", "traffic");
  for (const entry of state.wire) {
    const wire = el("details", "wire");
    wire.dataset.dir = entry.direction;

    const summary = el("summary");
    summary.append(
      icon(entry.direction === "out" ? "i-up" : entry.direction === "err" ? "i-dismiss" : "i-down", "wire-icon"),
      el("span", "wire-title", entry.title),
      el("span", "wire-time", `${entry.bytes ? formatBytes(entry.bytes) + " \u00B7 " : ""}${new Date(entry.at).toLocaleTimeString()}`)
    );
    wire.append(summary);

    if (entry.body) wire.append(el("pre", null, entry.body));
    else wire.append(el("pre", null, "Body not recorded at this level."));

    traffic.append(wire);
  }
  card.append(traffic);
}

/* --- settings sections ---------------------------------------------------- */

// Settings follows the Fluent pattern: a list of sections down the left, one
// panel of cards on the right. Only the chosen section renders, so no section
// is ever more than a short scroll.
const SETTINGS_SECTIONS = [
  { id: "behaviour", name: "Behaviour", icon: "i-spark",
    blurb: "How the model answers you, and what it is allowed to reach for." },
  { id: "models", name: "Models", icon: "i-model",
    blurb: "Download, load and remove models. Everything here runs on this computer." },
  { id: "storage", name: "Storage", icon: "i-library",
    blurb: "Where your chats, prompts and memory are kept, and how to remove them." },
  { id: "ollama", name: "Ollama", icon: "i-plug",
    blurb: "The local service that runs models and manages their downloads." },
  { id: "horizon", name: "Horizon", icon: "i-mark-xs",
    blurb: "How Horizon starts, and where it lives on this computer." }
];

let settingsSection = "behaviour";

// Every section renderer calls this to open a card, then appends its controls
// to whatever comes back.
/* --- saved confirmation --------------------------------------------------- */

// Most settings save the moment you change them, with no Save button. That is
// the right behaviour, but silence leaves you wondering whether it took. This
// is the smallest honest answer: a brief "Saved" beside the control that
// changed, announced to screen readers, then gone.
//
// Deliberately not a toast. A toast for a slider you are still dragging would
// be worse than saying nothing at all.
//
// Two timers, kept apart on purpose: one waits for typing to stop before
// claiming anything was saved, the other clears the message afterwards. Share
// a single map between them and the clear fires against the debounce, so the
// message is removed before it is ever shown.
const savedFadeTimers = new WeakMap();
const savedDebounceTimers = new WeakMap();

function markSaved(field, label = "Saved") {
  if (!field) return;

  let flag = field.querySelector(":scope > .saved-flag");
  if (!flag) {
    flag = el("span", "saved-flag");
    flag.setAttribute("role", "status");
    flag.setAttribute("aria-live", "polite");
    field.append(flag);
  }

  flag.textContent = label;
  flag.dataset.on = "true";

  clearTimeout(savedFadeTimers.get(flag));
  savedFadeTimers.set(flag, setTimeout(() => { flag.dataset.on = "false"; }, 1600));
}

// Settings that save on every keystroke should not claim to have saved on
// every keystroke. This waits for a pause first.
function debounceSaved(field, delay = 500) {
  clearTimeout(savedDebounceTimers.get(field));
  savedDebounceTimers.set(field, setTimeout(() => markSaved(field), delay));
}

function settingsCard(parent, title, blurb) {
  const card = el("section", "settings-card");
  card.append(el("h3", "settings-card-title", title));
  if (blurb) card.append(el("p", "settings-card-sub", blurb));
  const content = el("div", "settings-card-body");
  card.append(content);
  parent.append(card);
  return content;
}

/* --- desktop setup -------------------------------------------------------- */

// Nothing here happens without the user asking. Each box writes a shortcut
// into the user's own folders, which needs no administrator rights, and
// unticking it deletes the file again.
function renderDesktopSetup(body) {
  const section = settingsCard(body, "This machine",
    "Shortcuts and start-up. Windows only.");

  const loading = el("p", "field-hint busy-dots", "Checking");
  section.append(loading);

  fetch("/api/setup")
    .then(response => response.json())
    .then(setup => {
      loading.remove();

      if (!setup.supported) {
        section.append(el("p", "field-hint",
          "Shortcuts can only be created on Windows. Start Horizon however you normally would."));
        return;
      }

      if (!setup.launcherExists) {
        section.append(el("p", "field-hint",
          "The launcher 'Start Horizon.bat' is missing from the Horizon folder, so shortcuts cannot be created."));
        return;
      }

      const toggle = (key, title, hint) => {
        const row = el("label", "setup-row");
        const input = el("input");
        input.type = "checkbox";
        input.checked = Boolean(setup[key]);

        const text = el("span", "setup-text");
        text.append(el("span", "setup-name", title), el("span", "setup-hint", hint));
        row.append(input, text);

        input.addEventListener("change", async () => {
          const wanted = input.checked;
          input.disabled = true;
          try {
            const response = await fetch("/api/setup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ [key]: wanted })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "That did not work.");

            // Trust the server's reading of the disk over the click, so a
            // half-finished change never looks like it succeeded.
            input.checked = Boolean(result[key]);
            setNote(input.checked ? `${title} is on.` : `${title} is off.`);
          } catch (error) {
            input.checked = !wanted;
            setNote(error.message, "error");
          } finally {
            input.disabled = false;
          }
        });

        section.append(row);
      };

      toggle("startAtLogon", "Start when I sign in",
        "Opens Horizon minimised at sign-in. No administrator rights needed.");
      toggle("desktopShortcut", "Desktop shortcut",
        "Adds a Horizon shortcut to your desktop.");

      const install = el("div", "setup-row is-static");
      const text = el("span", "setup-text");
      text.append(
        el("span", "setup-name", "Install as an app"),
        el("span", "setup-hint",
          "This one is done from the browser, not from here: open its menu, choose Apps, then Install Horizon. It then has its own window, icon and taskbar entry.")
      );
      install.append(icon("i-up", "setup-glyph"), text);
      section.append(install);

      const note = el("p", "field-hint",
        "Horizon itself uses very little memory. A model is what takes space, and it is only loaded when you ask for one.");
      section.append(note);
    })
    .catch(() => {
      loading.remove();
      section.append(el("p", "field-hint", "The setup options could not be read."));
    });
}

/* --- reading linked pages ------------------------------------------------- */

// Link reading can leave this machine, so the panel is blunt about
// what it does and what it costs, and it stays off until asked for.
function renderReaderSetup(body) {
  const section = settingsCard(body, "Reading links",
    "Fetches public web pages over the network. Agent tools have separate controls.");

  const row = el("label", "setup-row");
  const input = el("input");
  input.type = "checkbox";
  input.checked = readerState.enabled;

  const text = el("span", "setup-text");
  text.append(
    el("span", "setup-name", "Let Horizon read pages you paste"),
    el("span", "setup-hint",
      "Without this, a model asked about a link guesses from the address and can invent the answer. With it, Horizon fetches the page and gives the model the real text.")
  );
  row.append(input, text);
  section.append(row);

  const detail = el("div", "backup-detail");
  section.append(detail);

  const paint = () => {
    detail.textContent = "";
    if (!readerState.enabled) return;

    const warn = el("p", "field-hint is-warn");
    warn.append(icon("i-warn", "inline-glyph"), document.createTextNode(
      " This is the only part of Horizon that leaves your computer. The site sees your address, as it would from any browser. The page itself stays here and goes only to your local model."));
    detail.append(warn);
    detail.append(el("p", "field-hint",
      "Private and local addresses are always blocked. Pages needing a sign-in, and those built by JavaScript, will not read."));
  };
  paint();

  input.addEventListener("change", async () => {
    const wanted = input.checked;
    input.disabled = true;
    try {
      const response = await fetch("/api/reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: wanted })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "That did not work.");

      readerState.enabled = Boolean(result.enabled);
      input.checked = readerState.enabled;
      updateUrlWarning();
      paint();
      setNote(readerState.enabled
        ? "Horizon will read pages you paste."
        : "Horizon will no longer read pages.");
    } catch (error) {
      input.checked = !wanted;
      setNote(error.message, "error");
    } finally {
      input.disabled = false;
    }
  });
}

/* --- keeping a copy on disk ----------------------------------------------- */

// Off by default. Writing conversations to disk is a bigger commitment than
// keeping them in the browser, so it is the user's decision, and the panel is
// blunt about what happens if they leave it off.
function renderBackupSetup(body) {
  const section = settingsCard(body, "Keeping a copy",
    "Chats and memory live in this browser unless you keep a copy on disk.");

  const loading = el("p", "field-hint busy-dots", "Checking");
  section.append(loading);

  fetch("/api/backup")
    .then(response => response.json())
    .then(status => {
      loading.remove();

      const row = el("label", "setup-row");
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(status.enabled);

      const text = el("span", "setup-text");
      text.append(
        el("span", "setup-name", "Keep a copy on this computer"),
        el("span", "setup-hint",
          "Saves your chats, prompts, memory, saved replies and preferences to a file, and restores them if this browser is ever cleared.")
      );
      row.append(input, text);
      section.append(row);

      const detail = el("div", "backup-detail");
      section.append(detail);

      const paint = state => {
        detail.textContent = "";

        if (!state.enabled) {
          // The warning is the whole point of the panel being here.
          const warn = el("p", "field-hint is-warn");
          warn.append(icon("i-warn", "inline-glyph"), document.createTextNode(
            " Chats, prompts, memory and saved replies are kept in this browser only. Clearing browsing data will lose them. Agents have separate on-disk storage."));
          detail.append(warn);
          return;
        }

        const where = el("div", "backup-path");
        where.append(el("span", "backup-path-label", "File"), el("code", null, state.file));
        detail.append(where);

        detail.append(el("p", "field-hint",
          state.exists
            ? `Last saved ${new Date(state.savedAt).toLocaleString()} \u00B7 ${formatBytes(state.bytes)}`
            : "Nothing saved yet. It will be written the next time something changes."));

        const actions = el("div", "backup-actions");

        const now = el("button", "btn-subtle", "Save now");
        now.type = "button";
        now.addEventListener("click", async () => {
          now.disabled = true;
          now.textContent = "Saving";
          await saveBackup();
          const fresh = await (await fetch("/api/backup")).json();
          paint(fresh);
          setNote("Saved to disk.");
        });
        actions.append(now);

        const restore = el("button", "btn-subtle");
        restore.type = "button";
        restore.textContent = "Restore from file";
        restore.disabled = !state.exists;
        restore.addEventListener("click", async () => {
          if (!window.confirm(
            "Replace everything in this browser with the saved copy?\n\n" +
            "Your current chats, prompts and memory here will be overwritten.")) return;
          try {
            const record = await (await fetch("/api/backup/data")).json();
            db.importAll(record.data, { mode: "replace" });
            setNote("Restored. Reloading.");
            setTimeout(() => window.location.reload(), 700);
          } catch (error) {
            setNote(error.message, "error");
          }
        });
        actions.append(restore);

        detail.append(actions);
      };

      paint(status);

      input.addEventListener("change", async () => {
        const wanted = input.checked;
        input.disabled = true;
        try {
          const response = await fetch("/api/backup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: wanted })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "That did not work.");

          input.checked = Boolean(result.enabled);
          backupState.enabled = Boolean(result.enabled);

          // Turning it on writes immediately, so the file exists straight away
          // rather than waiting for the next edit.
          if (result.enabled) {
            await saveBackup();
            paint(await (await fetch("/api/backup")).json());
            setNote("Your data is now kept on disk too.");
          } else {
            paint(result);
            setNote("Horizon will stop writing to disk. The existing file is left alone.");
          }
        } catch (error) {
          input.checked = !wanted;
          setNote(error.message, "error");
        } finally {
          input.disabled = false;
        }
      });
    })
    .catch(() => {
      loading.remove();
      section.append(el("p", "field-hint", "The backup options could not be read."));
    });
}

// Settings became too tall for a 380px drawer: four sections of controls meant
// constant scrolling in a narrow column. It is now a full-width page, laid out
// in columns, so everything is reachable without scrolling on a normal screen.
function renderSettings() {
  const body = $("settings-body");
  body.textContent = "";

  const layout = el("div", "settings-layout");
  body.append(layout);

  /* --- the section list --- */
  const nav = el("nav", "settings-nav");
  nav.setAttribute("aria-label", "Settings sections");
  layout.append(nav);

  for (const section of SETTINGS_SECTIONS) {
    const button = el("button", "settings-nav-btn");
    button.type = "button";
    button.setAttribute("aria-current", String(section.id === settingsSection));
    button.append(icon(section.icon, "settings-nav-icon"), el("span", null, section.name));
    button.addEventListener("click", () => {
      settingsSection = section.id;
      renderSettings();
    });
    nav.append(button);
  }

  /* --- the panel for whichever section is chosen --- */
  const panel = el("div", "settings-panel");
  layout.append(panel);

  const chosen = SETTINGS_SECTIONS.find(s => s.id === settingsSection);
  panel.append(el("h2", "settings-heading", chosen.name));
  panel.append(el("p", "settings-blurb", chosen.blurb));

  if (settingsSection === "behaviour") renderBehaviourSettings(panel);
  else if (settingsSection === "models") renderModelsSettings(panel);
  else if (settingsSection === "storage") renderStorageSettings(panel);
  else if (settingsSection === "ollama") renderOllamaSection(panel);
  else renderHorizonSettings(panel);
}

/* --- models --------------------------------------------------------------- */

// Model management is a Settings task, rendered into a plain container.
function renderModelsSettings(panel) {
  const host = el("div", "settings-host");
  panel.append(host);
  renderModelManager(host);
}

/* --- Ollama --------------------------------------------------------------- */

function renderOllamaSection(panel) {
  renderOllamaSettings(panel);

  // Service diagnostics and the request log both describe the running service,
  // so they sit under it rather than in a rail drawer of their own.
  const service = el("div", "settings-host");
  panel.append(service);
  renderService(service);

  renderTrafficSettings(panel);
}

/* --- behaviour ------------------------------------------------------------ */

function renderBehaviourSettings(panel) {
  const card = settingsCard(panel, "How the model answers");

  const promptField = el("div", "field");
  const promptLabel = el("label");
  promptLabel.append(icon("i-book", "field-icon"), document.createTextNode("Instructions for the model"));
  const promptInput = el("textarea");
  promptInput.rows = 5;
  promptInput.value = state.settings.systemPrompt;
  promptInput.addEventListener("input", () => {
    state.settings.systemPrompt = promptInput.value;
    db.setPref("systemPrompt", promptInput.value);
    debounceSaved(promptField);
  });
  promptField.append(promptLabel, promptInput,
    el("p", "field-hint", "Sets its character. Applies to your next message."));
  card.append(promptField);

  const tempField = el("div", "field");
  const tempLabel = el("label");
  const pill = el("span", "value-pill", Number(state.settings.temperature).toFixed(1));
  tempLabel.append(icon("i-scales", "field-icon"), document.createTextNode("Creativity "), pill);
  const range = el("input");
  range.type = "range";
  range.min = "0"; range.max = "2"; range.step = "0.1";
  range.value = state.settings.temperature;
  range.addEventListener("input", () => {
    state.settings.temperature = Number(range.value);
    pill.textContent = Number(range.value).toFixed(1);
    db.setPref("temperature", Number(range.value));
    debounceSaved(tempField);
  });
  const scale = el("div", "scale");
  scale.append(el("span", null, "Focused"), el("span", null, "Balanced"), el("span", null, "Inventive"));
  tempField.append(tempLabel, range, scale);
  card.append(tempField);

  const reset = el("button", "btn-subtle");
  reset.type = "button";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    state.settings.systemPrompt = state.defaults.systemPrompt;
    state.settings.temperature = state.defaults.temperature;
    // Clear the overrides rather than saving the defaults, so a later change
    // to the server's defaults is picked up.
    db.setPref("systemPrompt", null);
    db.setPref("temperature", null);
    renderSettings();
    // renderSettings rebuilds the panel, so the confirmation has to be put on
    // the freshly drawn field rather than the one that was just discarded.
    const field = document.querySelector(".settings-panel .field");
    if (field) markSaved(field, "Reset to defaults");
  });
  card.append(reset);

  // Reading links is a behaviour of the model, not a storage concern.
  renderReaderSetup(panel);

  if (window.HorizonSpeech) {
    const speech = settingsCard(panel, "Read replies aloud",
      "Uses locally available system voices. No cloud-voice fallback.");
    window.HorizonSpeech.mountSettings(speech);
  }
}

/* --- storage -------------------------------------------------------------- */

function renderStorageSettings(panel) {
  renderBackupSetup(panel);

  const card = settingsCard(panel, "Erase browser data",
    `Chats, prompts, memory and saved replies currently use ${formatBytes(db.usageBytes())} in this browser.`);

  const erase = el("button", "btn-subtle is-danger");
  erase.type = "button";
  erase.append(icon("i-trash", "btn-subtle-icon"), document.createTextNode("Erase browser data"));
  erase.addEventListener("click", () => {
    if (!window.confirm("Erase every chat, prompt, memory and saved reply from this browser?")) return;
    db.eraseEverything();
    window.HorizonSpeech?.reset();
    window.location.reload();
  });
  card.append(erase);
  card.append(el("p", "field-hint", "Agent definitions, schedules, permissions and run history are stored separately. Use Erase agent data in Agents to remove them."));
}

/* --- horizon itself ------------------------------------------------------- */

function renderHorizonSettings(panel) {
  renderDesktopSetup(panel);
}

/* ========================================================= model picker === */

function setModelState(stateName, label) {
  ui.pickerDot.dataset.state = stateName;
  ui.pickerLabel.textContent = label;
}

async function refreshModels() {
  try {
    const data = await (await fetch("/api/models")).json();
    state.models = data.models || [];
    state.activeAlias = data.activeAlias;
    state.assistantLabel = data.active || state.assistantLabel;
    // An empty list means nothing is downloaded; an unasked question means
    // nothing is known yet. Saying "no models" before looking would be a guess.
    state.modelsKnown = true;
  } catch { /* status check will report it */ }
}

function renderPickerMenu() {
  ui.pickerMenu.textContent = "";
  ui.pickerMenu.append(el("div", "picker-head", "Models available offline on this machine"));

  if (!state.models.length) {
    // A dead end is not an answer. Nothing is on this machine yet, so the menu
    // says so and points at the one place that can change it.
    const empty = el("div", "drawer-empty");
    empty.append(
      el("p", null, "No offline models available."),
      el("p", null, "Models are downloaded once, then run without a network.")
    );
    const go = el("button", "btn-subtle");
    go.type = "button";
    go.append(icon("i-model", "btn-subtle-icon"), document.createTextNode("Browse models"));
    go.addEventListener("click", () => {
      closePicker();
      setMode("settings");
      settingsSection = "models";
      renderSettings();
    });
    empty.append(go);
    ui.pickerMenu.append(empty);
    return;
  }

  for (const model of state.models) {
    const active = model.alias === state.activeAlias;
    const item = el("button", "picker-item");
    item.type = "button";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(active));

    const iconWrap = el("span", "picker-item-icon");
    iconWrap.append(icon("i-model"));

    const text = el("span", "picker-item-text");
    text.append(
      el("span", "picker-item-name", model.alias),
      el("span", "picker-item-meta",
        `${formatModelSize(model.sizeMb)}${model.loaded && !active ? " \u00B7 in memory" : ""}`)
    );

    item.append(iconWrap, text);
    if (active) item.append(icon("i-check", "picker-check"));

    if (!active) {
      item.addEventListener("click", async () => {
        closePicker();
        setModelState("pending", `Loading ${model.alias}...`);
        setNote(`Switching to ${model.alias}. Large models take a moment.`);
        try {
          const response = await fetch("/api/models/activate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alias: model.alias })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not switch model.");
          state.activeAlias = result.activeAlias;
          state.assistantLabel = result.active;
          state.models = result.models || state.models;
          setNote(`Now using ${model.alias}.`);
          await refreshStatus();
          await refreshModels();
          if (!ui.pickerMenu.hidden) renderPickerMenu();
        } catch (error) {
          setNote(error.message, "error");
          await refreshStatus();
        }
      });
    }

    ui.pickerMenu.append(item);
  }
}

function openPicker() {
  renderPickerMenu();
  ui.pickerMenu.hidden = false;
  ui.pickerBtn.setAttribute("aria-expanded", "true");
}

function closePicker() {
  ui.pickerMenu.hidden = true;
  ui.pickerBtn.setAttribute("aria-expanded", "false");
}

ui.pickerBtn.addEventListener("click", () => {
  if (ui.pickerMenu.hidden) openPicker(); else closePicker();
});

document.addEventListener("click", event => {
  if (!event.target.closest(".model-picker")) closePicker();
});

/* =============================================================== status === */

window.addEventListener("horizon-agents-changed", () => refreshStatus());
$("chat-tools-settings").addEventListener("click", () => {
  const dialog = el("dialog", "tool-preferences");
  dialog.append(el("h2", null, "This conversation's approvals"));
  dialog.append(el("p", "field-hint",
    "Only enabled tools and existing folder grants apply. These choices never grant new access. Writes, commands, MCP calls, arbitrary clicks and form fills always ask."));
  for (const [key, label] of [["fileReads", "Read files within granted folders"], ["publicBrowsing", "Read public pages and search"]]) {
    const row = el("label", "field");
    row.append(el("span", null, label));
    const select = el("select", "agent-input");
    select.setAttribute("aria-label", label);
    for (const [value, text] of [["allow", "Allow for this conversation"], ["ask", "Ask each time"]]) {
      const option = el("option", null, text);
      option.value = value;
      select.append(option);
    }
    select.value = state.chat.toolApprovals?.[key] || "allow";
    select.disabled = state.busy;
    select.addEventListener("change", () => {
      state.chat.toolApprovals = { ...state.chat.toolApprovals, [key]: select.value };
      if (!state.chat.unsaved) db.updateChat(state.chat.id, { toolApprovals: state.chat.toolApprovals });
    });
    row.append(select);
    dialog.append(row);
  }
  const done = el("button", "btn-primary", "Done");
  done.addEventListener("click", () => dialog.close());
  const grants = el("button", "btn-subtle", "Review tool and folder grants");
  grants.addEventListener("click", () => { dialog.close(); $("agents-btn").click(); });
  dialog.append(done, grants);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
});

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    state.toolPrivacy = data.privacy || null;
    refreshAirGap();
    $("chat-tools-settings").textContent = data.conversationTools ? "Tools available" : "Tools off";
    if (data.model) state.assistantLabel = data.model;

    // /api/status is the single source of truth for which model is active.
    // The picker used to keep its own copy, which drifted after a switch and
    // left the tick on one model while the button named another.
    if (data.alias && data.alias !== state.activeAlias) {
      state.activeAlias = data.alias;
      if (!ui.pickerMenu.hidden) renderPickerMenu();
    }

    state.modelReady = Boolean(data.ready);
    ui.prompt.placeholder = "Send a message";

    if (data.ready) {
      setModelState("ready", data.alias || data.model);
      hideBanner();
    } else if (state.modelsKnown && state.models.length === 0) {
      // Nothing downloaded is not the same as something broken. "Not ready"
      // reads as a fault and leaves people looking for what went wrong, when
      // the answer is simply that no model has been chosen yet.
      setModelState("warn", "No offline models");
      ui.prompt.placeholder = "Send a message";
      showBanner("No models on this computer yet. Settings \u2192 Models lets you pull a model by name and manage downloaded models.", "warn");
    } else {
      setModelState("warn", data.alias || "Not ready");
      showBanner(data.error || "The model is not loaded yet.", "warn");
    }
  } catch {
    state.modelReady = false;
    setModelState("error", "Offline");
    ui.prompt.placeholder = "Send a message";
    showBanner("The local server is not responding. Check the window that started it.", "error");
  }
}

/* ================================================================= send === */

/* ======================================================== Ollama workspace = */

// A full-width workspace for managing Ollama models and service settings.
const wsState = { models: [], filters: { search: "" }, busy: new Set(), progressNodes: new Map(), pollTimer: null };

// A large model can take many minutes. Polling the server's live progress is
// the difference between "it is working" and "it has hung".
function startProgressPolling() {
  if (wsState.pollTimer) return;

  const tick = async () => {
    if (!wsState.busy.size) {
      clearInterval(wsState.pollTimer);
      wsState.pollTimer = null;
      return;
    }
    try {
      const { downloads } = await (await fetch("/api/ollama/progress")).json();
      for (const [alias, nodes] of wsState.progressNodes) {
        const entry = downloads[alias];
        if (!entry || !nodes.bar.isConnected) continue;

        // Progress may arrive in coarse jumps, so elapsed time helps show that
        // a large model is still moving during quiet stretches.
        const elapsed = formatDuration(entry.elapsedMs);

        if (entry.percent > 0) {
          nodes.bar.classList.remove("is-waiting");
          nodes.bar.style.width = `${entry.percent}%`;
          nodes.label.textContent = entry.sizeMb
            ? `${entry.percent}% of ${formatModelSize(entry.sizeMb)} \u00B7 ${elapsed}`
            : `${entry.percent}% \u00B7 ${elapsed}`;
        } else {
          nodes.label.textContent = entry.sizeMb
            ? `Downloading ${formatModelSize(entry.sizeMb)} \u00B7 ${elapsed}`
            : `Preparing\u2026 ${elapsed}`;
        }
      }
    } catch {
      // A missed poll is not worth surfacing; the next one will catch up.
    }
  };

  wsState.pollTimer = setInterval(tick, 1000);
  tick();
}

// About is a document to read, not a side panel, so it takes the whole
// content area like Orchestration does rather than squeezing beside the chat.
function setMode(mode) {
  state.mode = mode;
  // A drawer is a panel over the current view, so changing view closes it.
  // Leaving it open left two rail buttons lit at once and the chosen view
  // hidden behind a panel the user then had to dismiss by hand.
  if (state.drawer) closeDrawer();
  const chat = document.querySelector(".main:not(.workspace)");
  const about = $("about");
  const settings = $("settings");
  const isChat = mode === "chat";
  const isAbout = mode === "about";
  const isSettings = mode === "settings";

  chat.hidden = !isChat;
  about.hidden = !isAbout;
  settings.hidden = !isSettings;
  $("chat-tools").hidden = !isChat;
  ui.newChat.hidden = !isChat;

  // One header serves every mode, so its middle and trailing controls swap
  // with the mode rather than each pane carrying a header of its own.
  $("chat-picker").hidden = !isChat;
  // Empty in chat, where the mark and the name are enough: anyone who has
  // installed this already knows what it is, and the empty state says so again
  // in larger type. The other modes use it as a label, which is worth having.
  $("brand-sub").textContent = isChat
    ? ""
    : isAbout ? "About Horizon and your privacy"
    : "Settings \u00B7 stored on this computer";

  // Scoped to the rail: "data-mode" is also used by the composer's link warning
  // and by the send button for their own states, and an unscoped query would
  // rewrite their icons to "#undefined".
  for (const button of document.querySelectorAll(".rail-btn[data-mode]")) {
    const selected = button.dataset.mode === mode;
    button.setAttribute("aria-pressed", String(selected));
    const use = button.querySelector("svg use");
    if (use) use.setAttribute("href", selected ? `#${button.dataset.icon}-on` : `#${button.dataset.icon}`);
  }

  // Settings has its own toggle rather than "data-mode", so clicking it a
  // second time returns to chat. About stays in the header.
  $("settings-btn").setAttribute("aria-pressed", String(isSettings));
  $("settings-btn").querySelector("svg use")
    .setAttribute("href", isSettings ? "#i-settings-on" : "#i-settings");
  $("help-btn").setAttribute("aria-pressed", String(isAbout));

  if (isAbout) {
    if (state.drawer) closeDrawer();
    renderAbout();
  }
  if (isSettings) {
    if (state.drawer) closeDrawer();
    renderSettings();
  }
}

for (const button of document.querySelectorAll(".rail-btn[data-mode]")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

function wsBusy(node, message) {
  node.textContent = "";
  const wrap = el("div", "ws-empty");
  wrap.append(el("span", "busy-dots", message));
  node.append(wrap);
}

// The Orchestration workspace is gone; models, service health and traffic all
// live in Settings now. This refreshes the screen after model actions.
async function renderWorkspace() {
  if (state.mode !== "settings") return;
  renderSettings();
}

/* --- Ollama models -------------------------------------------------------- */

function formatModelSize(mb) {
  if (!Number.isFinite(mb)) return "-";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

async function loadModels() {
  const response = await fetch("/api/models");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not read Ollama models.");
  wsState.models = (data.models || []).sort((a, b) => {
    return (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0) || a.alias.localeCompare(b.alias);
  });
  wsState.activeAlias = data.activeAlias;
}

async function renderModelManager(body) {
  body.textContent = "";
  const pane = el("div", "ws-pane");
  body.append(pane);

  const filters = el("div", "ws-filters");

  const search = el("input", "text-input ws-search");
  search.type = "search";
  search.placeholder = "Search models";
  search.value = wsState.filters.search;
  search.addEventListener("input", () => {
    wsState.filters.search = search.value;
    paintRows();
  });
  filters.append(search);

  const pullRow = el("div", "ws-filters");
  const pullInput = el("input", "text-input ws-search");
  pullInput.type = "text";
  pullInput.placeholder = "Pull any Ollama model by name, e.g. qwen3:1.7b";
  pullInput.setAttribute("aria-label", "Ollama model name to pull");
  const pullButton = el("button", "btn-primary", "Pull");
  pullButton.type = "button";
  const pull = () => {
    const name = pullInput.value.trim();
    if (!name) return;
    pullInput.value = "";
    if (!wsState.models.some(model => model.alias === name)) {
      wsState.models.unshift({ alias: name, loaded: false, sizeMb: null });
    }
    runModelAction(name, "download", `Pulling ${name}`);
  };
  pullButton.addEventListener("click", pull);
  pullInput.addEventListener("keydown", event => { if (event.key === "Enter") pull(); });
  pullRow.append(pullInput, pullButton);
  filters.append(pullRow);

  pane.append(filters);

  const count = el("p", "ws-count");
  pane.append(count);

  const table = el("div", "mtable");
  pane.append(table);

  if (!wsState.models.length) {
    wsBusy(table, "Reading Ollama models");
    try {
      await loadModels();
    } catch (error) {
      table.textContent = "";
      const failed = el("div", "ws-empty");
      failed.append(icon("i-warn"), el("div", null, error.message));
      table.append(failed);
      return;
    }
  }

  function paintRows() {
    table.textContent = "";
    const term = wsState.filters.search.trim().toLowerCase();
    const rows = wsState.models.filter(model => !term || model.alias.toLowerCase().includes(term));

    count.textContent = `${rows.length} of ${wsState.models.length} models`;

    const head = el("div", "mrow is-head");
    head.append(
      el("div", null, "Name"),
      el("div", null, "Size"),
      el("div", null, "Tools"),
      el("div", null, "Status"),
      el("div", null, "")
    );
    table.append(head);

    if (!rows.length) {
      const empty = el("div", "ws-empty");
      empty.append(icon("i-model"), el("div", null,
        wsState.models.length ? "No model names match this search." : "No local models yet. Use the pull box above to add one."));
      table.append(empty);
      return;
    }

    for (const model of rows) {
      // "In use" means both selected and actually resident in memory.
      const active = model.alias === wsState.activeAlias && model.loaded;
      const row = el("div", "mrow");
      row.dataset.active = String(active);

      const name = el("div", "mname");
      const text = el("div", "mname-text");
      text.append(el("div", "mname-alias", model.alias));
      name.append(text);

      const size = el("div", "msize", formatModelSize(model.sizeMb));

      // A filled dot means the model supports tool calling.
      const tools = el("div", "mcell");
      if (typeof model.supportsTools === "boolean") {
        const toolDot = el("span", "mdot", model.supportsTools ? "\u25CF" : "\u25CB");
        toolDot.dataset.on = String(model.supportsTools);
        toolDot.title = model.supportsTools ? "Supports tool calling" : "No tool calling";
        tools.append(toolDot);
      } else {
        tools.textContent = "Unknown";
      }

      const status = el("div", "mcell", active ? "In use" : model.loaded ? "In memory" : "Available");

      const actions = el("div", "mactions");
      const key = model.alias;
      const busy = wsState.busy.has(key);

      if (busy) {
        const cell = el("div", "mprogress");
        const track = el("div", "mprogress-track");
        const bar = el("div", "mprogress-bar");
        // Until the first percentage arrives there is nothing honest to show,
        // so the bar sweeps to say "working" without implying a position.
        bar.classList.add("is-waiting");
        track.append(bar);
        const label = el("span", "mprogress-label", "Preparing\u2026");
        cell.append(track, label);
        actions.append(cell);
        // Filled in by the poller below, which runs while any download is live.
        wsState.progressNodes.set(key, { bar, label });
      } else {
        if (!active) {
          const use = el("button", "btn-subtle");
          use.type = "button";
          use.textContent = "Use";
          use.addEventListener("click", () => runModelAction(key, "activate", `Loading ${key}`));
          actions.append(use);

          const remove = el("button", "btn-subtle is-danger");
          remove.type = "button";
          remove.append(icon("i-trash", "btn-subtle-icon"));
          remove.title = `Delete ${key} from disk`;
          remove.addEventListener("click", () => {
            if (!window.confirm(`Delete ${key} from this machine? The files can be downloaded again later.`)) return;
            runModelAction(key, "remove", `Removing ${key}`);
          });
          actions.append(remove);
        }
      }

      row.append(name, size, tools, status, actions);
      table.append(row);
    }
  }

  paintRows();
  wsState.paintRows = paintRows;
}

async function runModelAction(alias, action, message) {
  wsState.busy.add(alias);
  if (wsState.paintRows) wsState.paintRows();
  setNote(message);
  if (action === "download") startProgressPolling();

  const path = action === "activate" ? "/api/models/activate" : `/api/ollama/${action}`;

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "That did not work.");

    setNote(action === "download" ? `${alias} downloaded.` : action === "remove" ? `${alias} removed.` : `Now using ${alias}.`);
    wsState.models = [];
    await Promise.all([refreshStatus(), refreshModels()]);
  } catch (error) {
    setNote(error.message, "error");
  } finally {
    wsState.busy.delete(alias);
    wsState.progressNodes.delete(alias);
    await renderWorkspace();
  }
}

/* --- service -------------------------------------------------------------- */

async function renderService(body) {
  body.textContent = "";
  const pane = el("div", "ws-pane");
  body.append(pane);
  wsBusy(pane, "Checking the service");

  let data;
  try {
    data = await (await fetch("/api/ollama")).json();
  } catch {
    pane.textContent = "";
    pane.append(el("p", "panel-note", "The local server is not responding."));
    return;
  }

  pane.textContent = "";

  if (!data.installed) {
    const card = el("div", "ws-card");
    card.append(el("div", "ws-card-title", `${runtimeLabel()} is not installed`));
    card.append(el("p", "panel-note", data.message));

    const steps = el("ol", "setup-steps");
    for (const [text, code] of [
      ["Install Ollama", "winget install Ollama.Ollama"],
      ["Close and reopen Horizon", null]
    ]) {
      const step = el("li");
      step.append(el("span", null, text));
      if (code) step.append(el("code", "setup-code", code));
      steps.append(step);
    }
    card.append(steps);

    const link = el("a", "doc-link", `${runtimeLabel()} documentation`);
    link.href = "https://docs.ollama.com/";
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.append(icon("i-up", "doc-link-icon"));
    card.append(link);
    pane.append(card);
    return;
  }

  const grid = el("div", "ws-grid");

  // A small helper, since every card below is the same list of key/value rows.
  const fact = (card, key, value, options = {}) => {
    const row = el("div", "ws-fact-row");
    const val = el("span", "ws-fact-val", value);
    if (options.mono) val.classList.add("is-mono");
    if (options.tone) val.dataset.tone = options.tone;
    row.append(el("span", "ws-fact-key", key), val);
    card.append(row);
    return row;
  };

  const status = el("div", "ws-card");
  status.append(el("div", "ws-card-title", data.running ? "Service running" : "Service stopped"));
  fact(status, "Version", data.version || "unknown");
  fact(status, "State", data.state || (data.running ? "running" : "stopped"));
  fact(status, "Endpoint", data.endpoint || "not connected", { mono: true });
  fact(status, "Uptime", data.uptime || "-");
  fact(status, "Started", data.startedAt ? new Date(data.startedAt).toLocaleString() : "-");
  fact(status, "Process", data.pid ? String(data.pid) : "-", { mono: true });

  const actions = el("div", "svc-actions");
  const act = (label, path, busyLabel, primary) => {
    const button = el("button", primary ? "btn-primary" : "btn-subtle", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
      button.textContent = busyLabel;
      try {
        const response = await fetch(path, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "That did not work.");
        setNote(`${runtimeLabel()} ${label === "Stop" ? "stopped" : "is running"}.`);
        wsState.models = [];
        await Promise.all([refreshStatus(), refreshModels()]);
      } catch (error) {
        setNote(error.message, "error");
      }
      await renderWorkspace();
    });
    actions.append(button);
  };

  if (data.running) {
    act("Restart", "/api/ollama/restart", "Restarting");
    act("Stop", "/api/ollama/stop", "Stopping");
  } else {
    act("Start", "/api/ollama/start", "Starting", true);
  }
  status.append(actions);
  grid.append(status);

  const model = el("div", "ws-card");
  model.append(el("div", "ws-card-title", "Active model"));

  let live = {};
  try { live = await (await fetch("/api/status")).json(); } catch { /* status is best-effort here */ }

  fact(model, "Alias", data.modelAlias || "-");
  fact(model, "Variant", data.modelId || "none selected", { mono: true });
  fact(model, "Memory",
    live.ready ? "Loaded" : live.needsLoad ? "Downloaded, not loaded" : "Not available",
    { tone: live.ready ? "good" : "warn" });
  // Only models this Horizon loaded are released on exit; anything else was
  // already resident and is left alone.
  fact(model, "Loaded by Horizon", data.loadedByUs?.length ? data.loadedByUs.join(", ") : "none");
  model.append(el("p", "panel-note",
    "A loaded model stays in memory until it is unloaded or the service stops."));
  grid.append(model);

  // What this is costing the machine. Without this the only way to find out is
  // Task Manager, which is exactly the gap Horizon exists to close.
  const cost = el("div", "ws-card");
  cost.append(el("div", "ws-card-title", "What this is using"));

  const daemonMb = data.resources?.daemonMemoryMb;
  fact(cost, `${runtimeLabel()} service`, daemonMb ? formatMegabytes(daemonMb) : "unknown",
    { tone: daemonMb && daemonMb > 8192 ? "warn" : null });
  fact(cost, "Horizon itself", data.horizon ? formatMegabytes(data.horizon.memoryMb) : "-");
  if (data.host) {
    const usedPct = Math.round((1 - data.host.freeMemMb / data.host.totalMemMb) * 100);
    fact(cost, "Memory free",
      `${formatMegabytes(data.host.freeMemMb)} of ${formatMegabytes(data.host.totalMemMb)} (${usedPct}% used)`,
      { tone: usedPct > 85 ? "warn" : null });
  }
  if (data.cache) {
    fact(cost, "Models on disk",
      `${data.cache.modelCount} \u00B7 ${formatMegabytes(data.cache.totalMb)}`);
    fact(cost, "In memory now", `${data.cache.loadedCount} of ${data.cache.modelCount}`);
    if (data.cache.directory) {
      fact(cost, "Cache folder", data.cache.directory, { mono: true });
    }
  }
  grid.append(cost);

  // Enough detail to answer "will this model even run here?" and to paste into
  // a bug report without hunting through system settings.
  if (data.host) {
    const host = el("div", "ws-card");
    host.append(el("div", "ws-card-title", "This machine"));
    fact(host, "Processor", data.host.cpuModel || "unknown");
    fact(host, "Cores", `${data.host.cpus}`);
    fact(host, "Architecture", data.host.arch);
    fact(host, "System", data.host.platform);
    fact(host, "Node.js", data.host.node, { mono: true });
    fact(host, "Horizon port", data.horizon ? String(data.horizon.port) : "-", { mono: true });
    grid.append(host);
  }

  pane.append(grid);
}

function formatMegabytes(mb) {
  if (mb === null || mb === undefined) return "-";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/* --- Ollama settings ------------------------------------------------------ */

function renderOllamaSettings(parent) {
  const section = settingsCard(parent, "Ollama configuration",
    "Ollama server options are configured through environment variables, not from Horizon.");
  section.append(el("p", "field-hint",
    "For example, OLLAMA_HOST sets the server address, OLLAMA_MODELS sets the model storage location, and OLLAMA_KEEP_ALIVE controls how long models stay loaded."));
  const link = el("a", "doc-link", "Ollama server configuration");
  link.href = "https://docs.ollama.com/faq";
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.append(icon("i-up", "doc-link-icon"));
  section.append(link);
}

/* ------------------------------------------------------------- safe exit -- */

// A loaded model stays resident in the Ollama service after the page closes,
// so exiting through this path releases it.
let exiting = false;

function openExitDialog() { $("exit-scrim").hidden = false; $("exit-confirm").focus(); }
function closeExitDialog() { $("exit-scrim").hidden = true; }

async function safeExit() {
  const confirm = $("exit-confirm");
  confirm.disabled = true;
  confirm.textContent = "Shutting down...";
  exiting = true;

  try {
    await fetch("/api/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopService: false })
    });
  } catch { /* the server may close before replying; that is expected */ }

  const exitMessage = "Horizon shutdown requested. Models loaded by Horizon will be released; the Ollama service is left running.";
  $("exit-body").textContent = exitMessage;
  $("exit-cancel").hidden = true;
  confirm.textContent = "Close this tab";
  confirm.disabled = false;

  // window.close() only works on a tab that script opened. Horizon's tab comes
  // from the launcher, so most browsers refuse it silently - the button would
  // look broken. Try it, then say plainly what to do if nothing happened,
  // rather than leaving the reader clicking a dead control.
  //
  // No browser sniffing: Chrome, Edge, Firefox and an installed PWA all behave
  // differently here, so the check is simply whether this page is still on
  // screen afterwards. Whatever the browser decided, the outcome is what is
  // tested.
  const installed = window.matchMedia?.("(display-mode: standalone)")?.matches;
  confirm.onclick = () => {
    window.close();
    setTimeout(() => {
      if (document.hidden) return;
      confirm.hidden = true;
      const tail = installed
        ? "You can close this window now."
        : "Your browser will not let a page close a tab it did not open, so please close this one yourself.";
      $("exit-body").textContent = `${exitMessage} ${tail}`;
    }, 250);
  };
}

$("exit-btn").addEventListener("click", openExitDialog);
$("exit-cancel").addEventListener("click", closeExitDialog);
$("exit-confirm").addEventListener("click", safeExit);
$("exit-scrim").addEventListener("click", event => {
  if (event.target === $("exit-scrim")) closeExitDialog();
});

// Warn if the tab is closed without releasing the model.
window.addEventListener("beforeunload", event => {
  if (exiting || !state.modelReady) return;
  event.preventDefault();
  event.returnValue = "A model is still loaded in memory. Use Shut down to release it.";
  return event.returnValue;
});

function setBusy(busy) {
  state.busy = busy;
  ui.newChat.disabled = busy;
  ui.thread.setAttribute("aria-busy", String(busy));
  ui.sendIcon.textContent = "";
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", busy ? "#i-stop" : "#i-send");
  ui.sendIcon.append(use);
  ui.send.dataset.mode = busy ? "stop" : "send";
  ui.send.title = busy ? "Stop generating" : "Send";
}

function stopGenerating() {
  if (state.controller) state.controller.abort();
}

/* ============================================================ attachments == */

// Text files only, for now. They are read in the browser and prepended to the
// message, so nothing is uploaded anywhere and no model support is required.
// Images are a separate problem: a text-only model does not refuse them, it
// describes the base64 string instead, which would be a silent wrong answer.

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

// A binary file read as text is mostly replacement characters and control
// codes. Catching that is better than sending the model a page of mojibake.
function looksBinary(text) {
  const sample = text.slice(0, 2000);
  if (!sample) return false;
  let odd = 0;
  for (const char of sample) {
    const code = char.codePointAt(0);
    if (char === "\uFFFD" || (code < 9) || (code > 13 && code < 32)) odd++;
  }
  return odd / sample.length > 0.05;
}

function renderAttachments() {
  const list = ui.attachments;
  list.textContent = "";
  list.hidden = !state.attachments.length;
  if (!state.attachments.length) return;

  for (const file of state.attachments) {
    const chip = el("div", "attachment");
    chip.append(icon("i-book", "attachment-icon"));

    const text = el("div", "attachment-text");
    text.append(el("span", "attachment-name", file.name));
    text.append(el("span", "attachment-meta",
      file.truncated
        ? `${formatBytes(file.originalChars)} \u00B7 only the first ${formatBytes(file.chars)} will be sent`
        : formatBytes(file.chars)));
    chip.append(text);
    if (file.truncated) chip.dataset.warn = "true";

    const remove = el("button", "attachment-remove");
    remove.type = "button";
    remove.title = `Remove ${file.name}`;
    remove.append(icon("i-dismiss"));
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter(item => item !== file);
      renderAttachments();
    });
    chip.append(remove);
    list.append(chip);
  }
}

async function addFiles(files) {
  // The server truncates each message at maxMessageChars. Rather than let that
  // happen silently, the cut is made here and said out loud on the chip.
  const limit = Math.floor((state.limits?.maxMessageChars || 20000) * 0.9);

  for (const file of files) {
    if (state.attachments.length >= 5) {
      setNote("Five files at a time is the limit.", "warn");
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      setNote(`${file.name} is too large. The limit is ${formatBytes(MAX_FILE_BYTES)}.`, "error");
      continue;
    }

    try {
      const raw = await readTextFile(file);
      if (looksBinary(raw)) {
        setNote(`${file.name} does not look like a text file, so it was not attached.`, "error");
        continue;
      }

      const truncated = raw.length > limit;
      state.attachments.push({
        name: file.name,
        content: truncated ? raw.slice(0, limit) : raw,
        chars: truncated ? limit : raw.length,
        originalChars: raw.length,
        truncated
      });

      if (truncated) {
        setNote(`${file.name} is long, so only the first part will be sent.`, "warn");
      }
    } catch (error) {
      setNote(error.message, "error");
    }
  }

  renderAttachments();
}

// Attached text is wrapped in fences and labelled, so the model can tell the
// file apart from the question being asked about it.
function composeWithAttachments(message) {
  if (!state.attachments.length) return message;

  const blocks = state.attachments.map(file =>
    `--- ${file.name} ---\n${file.content}`
  );
  return `${blocks.join("\n\n")}\n\n${message}`;
}

ui.attachBtn.addEventListener("click", () => ui.attachInput.click());
ui.attachInput.addEventListener("change", async () => {
  await addFiles([...ui.attachInput.files]);
  ui.attachInput.value = "";
});

// Dropping a file anywhere on the composer is the obvious gesture, so support
// it rather than making people find the button.
ui.composer.addEventListener("dragover", event => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  ui.composer.dataset.dropping = "true";
});
ui.composer.addEventListener("dragleave", () => { delete ui.composer.dataset.dropping; });
ui.composer.addEventListener("drop", async event => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  delete ui.composer.dataset.dropping;
  await addFiles([...event.dataTransfer.files]);
});

function buildSystemPrompt() {
  const parts = [state.settings.systemPrompt || state.defaults.systemPrompt];
  const memory = db.memory();
  if (memory.enabled && memory.facts.length) {
    parts.push("Things to remember about the person you are helping:");
    for (const fact of memory.facts) parts.push(`- ${fact.text}`);
  }
  return parts.join("\n");
}

let pinnedToBottom = true;
ui.thread.addEventListener("scroll", () => {
  pinnedToBottom = ui.thread.scrollHeight - ui.thread.scrollTop - ui.thread.clientHeight < 60;
}, { passive: true });

function scrollIfPinned() {
  if (pinnedToBottom) ui.thread.scrollTo({ top: ui.thread.scrollHeight, behavior: "instant" });
}

async function submit() {
  if (state.busy) return stopGenerating();
  window.HorizonSpeech?.stop();

  const typed = ui.prompt.value.trim();
  // A file on its own is a reasonable message; the default question is what
  // most people would have typed anyway.
  if (!typed && !state.attachments.length) return;
  if (!state.chat) startNewChat();

  const question = typed || "Summarise the attached file.";
  const withFiles = composeWithAttachments(question);
  const attached = state.attachments.map(file => ({ name: file.name, chars: file.chars }));

  // Fetching happens before the turn is created, so a slow page does not leave
  // an empty bubble sitting there.
  const { text: value, pages } = await readLinkedPages(withFiles);

  // The model is given the page text and the reader's preamble; the person is
  // not. Keeping what they typed means the bubble, the title and the copy
  // button show the question rather than the wrapper around it.
  state.chat.turns.push({ role: "user", content: value, typed: question });
  const userTurn = createTurn("user", "You");

  // The bubble shows what the person wrote plus a note of what came with it.
  // Pasting the whole file or page back at them would bury the conversation.
  renderInto(userTurn.bubble, question);
  if (attached.length || pages.length) {
    const note = el("div", "bubble-files");
    for (const file of attached) {
      const chip = el("span", "bubble-file");
      chip.append(icon("i-book", "bubble-file-icon"), document.createTextNode(file.name));
      note.append(chip);
    }
    for (const page of pages) {
      const chip = el("span", "bubble-file");
      if (page.failed) chip.dataset.failed = "true";
      chip.title = page.failed ? page.reason : `${page.characters} characters read`;
      chip.append(
        icon("i-globe", "bubble-file-icon"),
        document.createTextNode(page.failed
          ? `couldn't read ${new URL(page.url).hostname}`
          : new URL(page.url).hostname)
      );
      note.append(chip);
    }
    userTurn.bubble.append(note);
  }

  addTools(userTurn.turn, userTurn.main, () => value);
  clampIfLong(userTurn.bubble, userTurn.main);
  persistTurns();

  state.attachments = [];
  renderAttachments();

  ui.prompt.value = "";
  autoGrow();
  updateUrlWarning();
  pinnedToBottom = true;
  scrollIfPinned();

  const reply = createTurn("assistant", state.assistantLabel);

  // Until the first token arrives there is nothing to show but a caret, and on
  // this hardware that wait is several seconds. A visible "thinking" state is
  // the difference between "it is working" and "did that even send?".
  const waiting = el("div", "waiting");
  const activity = window.HorizonActivity.create("thinking");
  waiting.append(activity.element);
  reply.bubble.append(waiting);

  const caret = el("span", "caret");
  reply.bubble.append(caret);
  const replyResize = new ResizeObserver(() => scrollIfPinned());
  replyResize.observe(reply.main);
  scrollIfPinned();

  setBusy(true);
  setNote("Generating...");

  const started = performance.now();
  let firstTokenAt = null;
  let full = "";
  let thinkingBox = null;
  let thinkingLabelNode = null;
  let thoughtStartedAt = null;
  // Null until the reasoning closes, so an unfinished one is never mistaken for
  // one that finished instantly.
  let thoughtMs = null;
  let answerBox = null;

  // The local model streams small chunks to keep the reply responsive.
  // Painting on arrival therefore lurches: a burst of text, then a visible
  // pause, which reads as mechanical typing rather than a flowing answer.
  //
  // So arrival and display are decoupled. Text is buffered as it lands, and a
  // frame loop reveals it a few characters at a time. The reveal rate is
  // proportional to how much is waiting, so it speeds up on a fast model and
  // eases off on a slow one, and always drains rather than falling behind.
  let revealed = 0;
  let streamDone = false;
  let frame = null;

  const paint = () => {
    const visible = full.slice(0, revealed);
    const { thinking, answer } = splitThinking(visible, !streamDone || revealed < full.length);

    if (thinking) {
      if (!thinkingBox) {
        thinkingBox = el("details", "thinking");
        thinkingBox.open = false;
        const summary = el("summary");
        thinkingLabelNode = document.createTextNode("Working it out");
        summary.append(icon("i-orbit", "thinking-glyph"), thinkingLabelNode);
        thinkingBox.append(summary, el("div"));
        reply.bubble.insertBefore(thinkingBox, reply.bubble.firstChild);
      }
      thinkingBox.lastChild.textContent = thinking;

      // The close tag is the honest end of the reasoning. Waiting for the
      // answer's first character instead would leave the orbit spinning
      // through the gap between the two.
      const closed = visible.includes("</think>");
      activity.set(closed ? "answering" : "thinking");
      thinkingLabelNode.textContent = thinkingLabel(closed ? thoughtMs : null);
      // The orbit turns while the reasoning is still arriving, and stops when
      // it is done: motion means work in progress, nothing else.
      thinkingBox.classList.toggle("is-live", !closed);

    }

    if (!answerBox) {
      answerBox = el("span");
      reply.bubble.insertBefore(answerBox, caret);
    }
    if (answer) activity.set("answering");
    renderInto(answerBox, answer);
    scrollIfPinned();
  };

  // A whole frame's worth of arrival is about 8 characters at 11 tok/s, so
  // draining over ~12 frames keeps something moving in every single frame
  // without ever getting far enough behind to feel laggy.
  const tick = () => {
    const waiting = full.length - revealed;

    if (waiting > 0) {
      const step = streamDone
        ? Math.max(4, Math.ceil(waiting / 6))   // finish promptly once it is all in
        : Math.max(1, Math.ceil(waiting / 12));
      revealed = Math.min(full.length, revealed + step);
      paint();
    }

    if (!streamDone || revealed < full.length) frame = requestAnimationFrame(tick);
    else frame = null;
  };

  const startReveal = () => {
    if (frame === null) frame = requestAnimationFrame(tick);
  };

  // Used when the answer must be complete right now: on finish, stop or error.
  const flush = () => {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    streamDone = true;
    revealed = full.length;
    paint();
  };

  // A long wait must not look like a dead one, so the label counts up once it
  // has been going for a few seconds.
  const waitingSince = performance.now();
  const waitingTimer = setInterval(() => {
    if (!waiting.isConnected) return clearInterval(waitingTimer);
    const seconds = Math.round((performance.now() - waitingSince) / 1000);
    if (seconds >= 3) {
      waiting.dataset.elapsed = `${seconds}s`;
    }
  }, 1000);

  const stopWaiting = () => {
    clearInterval(waitingTimer);
    if (waiting.isConnected) waiting.remove();
  };

  state.controller = new AbortController();

  const requestBody = {
    messages: [{ role: "system", content: buildSystemPrompt() }].concat(
      state.chat.turns.map(turn => ({ role: turn.role, content: turn.content }))
    ),
    temperature: state.settings.temperature
  };

  const requestText = JSON.stringify(requestBody);
  logWire("out", `Request \u00B7 ${requestBody.messages.length} msg`, requestBody, requestText.length);

  let toolControl = null;
  try {
    toolControl = await window.HorizonChatTools.prepare(state.controller.signal);
    requestBody.clientRunId = toolControl.id;
    requestBody.conversationId = state.chat.id;
    requestBody.approvalPreferences = state.chat.toolApprovals;
    toolControl.pending = true;
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: toolControl.headers,
      signal: state.controller.signal,
      body: JSON.stringify(requestBody)
    });

    const contentType = response.headers.get("Content-Type") || "";

    if (!contentType.includes("text/event-stream")) {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
      if (data.run) {
        const result = await toolControl.follow(data.run, reply.main, state.controller.signal, (status, phase) => {
          activity.set(phase || "failed", status);
          setNote(status);
        });
        full = result.reply;
        stopWaiting();
        flush();
        return finish({ ...data, ...result });
      }
      toolControl.finish();
      full = data.reply;
      paint();
      return finish(data);
    }

    toolControl.finish();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let summary = null;

    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = JSON.parse(line.slice(5));
          if (payload.error) throw new Error(payload.error);
          if (payload.delta) {
            if (firstTokenAt === null) {
              firstTokenAt = performance.now();
              activity.set("answering");
              setNote(`First words in ${((firstTokenAt - started) / 1000).toFixed(1)}s...`);
            }
            full += payload.delta;

            // Timed against arrival rather than the reveal, which lags on
            // purpose: this is how long the model thought, not how long the
            // animation took to catch up.
            if (thoughtStartedAt === null && full.includes("<think>")) {
              thoughtStartedAt = performance.now();
            }
            if (thoughtMs === null && thoughtStartedAt !== null && full.includes("</think>")) {
              thoughtMs = performance.now() - thoughtStartedAt;
            }
            startReveal();
          }
          if (payload.done) summary = payload;
        }
      }
    }

    streamDone = true;
    flush();
    finish(summary || {});
  } catch (error) {
    if (error.name === "AbortError") {
      flush();
      caret.remove();
      if (full) {
        state.chat.turns.push({ role: "assistant", content: full, model: state.assistantLabel });
        persistTurns();
      }
      setNote("Stopped.", "warn");
      logWire("err", "Stopped", { characters: full.length }, full.length);
    } else {
      flush();
      caret.remove();
      reply.bubble.classList.add("is-error");
      renderInto(reply.bubble, error.message);
      setNote("Something went wrong. The message above explains what to check.", "error");
      logWire("err", "Failed", { error: error.message });
    }
    refreshStatus();
  } finally {
    replyResize.disconnect();
    scrollIfPinned();
    // Belt and braces: whatever happened, the waiting state must not survive.
    stopWaiting();
    thinkingBox?.classList.remove("is-live");
    if (toolControl?.pending) {
      try { await toolControl.cancel(); }
      catch (error) { setNote(`Could not confirm tool cancellation: ${error.message}`, "error"); }
    }
    toolControl?.finish();
    state.controller = null;
    setBusy(false);
    ui.prompt.focus();
  }

  function finish(summary) {
    caret.remove();
    const { answer } = splitThinking(full);

    state.chat.turns.push({
      role: "assistant",
      content: full,
      model: summary.model || state.assistantLabel,
      ...(summary.agentRunId ? { agentRunId: summary.agentRunId } : {}),
      // Kept so a reloaded chat still says how long it thought, rather than
      // Kept so a reloaded chat still says how long it thought, rather than
      // falling back to the present tense for reasoning that finished days ago.
      // Tested against null, not truthiness: a fast model can finish inside one
      // chunk, and dropping that zero would leave the panel working for ever.
      ...(thoughtMs === null ? {} : { thoughtMs: Math.round(thoughtMs) })
    });
    persistTurns();
    addTools(reply.turn, reply.main, () => answer || full);
    clampIfLong(reply.bubble, reply.main);
    window.HorizonSpeech?.autoRead(answer || full);

    const seconds = (performance.now() - started) / 1000;
    const parts = [];

    if (summary.usage?.completion_tokens) {
      parts.push(`${summary.usage.completion_tokens} tokens at ${(summary.usage.completion_tokens / seconds).toFixed(1)}/s`);
    }
    if (firstTokenAt !== null) parts.push(`first words in ${((firstTokenAt - started) / 1000).toFixed(1)}s`);
    if (summary.finishReason === "length") parts.push("cut off at the length limit");
    if (summary.truncated) parts.push("older messages dropped to fit the history limit");

    setNote(parts.join(" \u00B7 ") || "Done.",
      summary.truncated || summary.finishReason === "length" ? "warn" : null);

    logWire("in", `Reply \u00B7 ${summary.model || state.assistantLabel}`, {
      reply: full,
      usage: summary.usage || null,
      model: summary.model,
      finishReason: summary.finishReason,
      elapsedSeconds: Number(seconds.toFixed(2))
    }, full.length);

    refreshStatus();
  }
}

window.addEventListener("horizon-tool-error", event => setNote(event.detail.message, "error"));
window.addEventListener("horizon-speech-error", event => setNote(event.detail.message, "error"));

/* ============================================================= composer === */

function autoGrow() {
  ui.prompt.style.height = "auto";
  ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 200)}px`;
}

ui.prompt.addEventListener("input", () => {
  autoGrow();
  updateUrlWarning();
});
ui.prompt.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
});
ui.send.addEventListener("click", submit);
ui.promptLibrary.addEventListener("click", () => openDrawer("prompts"));

ui.thread.addEventListener("click", event => {
  const starter = event.target.closest(".starter");
  if (!starter) return;
  ui.prompt.value = starter.dataset.prompt;
  autoGrow();
  submit();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (state.busy) stopGenerating();
    else if (!ui.pickerMenu.hidden) closePicker();
    else if (state.drawer) closeDrawer();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
});

// The air-gap badge is a claim about where your data goes, so pressing it
// shows the evidence rather than repeating the claim.
ui.airgapBadge.addEventListener("click", openTrafficLog);

/* ================================================================== boot === */

(async function boot() {
  // Before anything reads the store: if a copy exists on disk and this browser
  // is empty, offer to bring it back. Otherwise a cleared cache or a new
  // browser looks like the data was simply lost.
  await refreshBackupState();
  await refreshReaderState();
  await offerRestore();

  // Any change to chats, prompts, memory, library or preferences updates the
  // copy on disk. Registered after the restore so restoring does not trigger
  // a write of what was just read.
  db.onChange = scheduleBackup;

  const prefs = db.prefs();
  applyTheme(prefs.theme || "dark");

  try {
    const data = await (await fetch("/api/config")).json();
    state.app = data.app;
    state.defaults = data.defaults;
    state.endpoint = data.endpoint;
    state.limits = data.limits;
    document.title = data.app.displayName;
  } catch {
    state.defaults = { systemPrompt: "You are a helpful, concise local assistant.", temperature: 0.7, historyLimit: 30 };
    setNote("Could not load settings from the local server.", "error");
  }

  // The server supplies the defaults; anything the user has changed since then
  // overrides them, so their instructions and creativity survive a reload.
  state.settings.systemPrompt = prefs.systemPrompt ?? state.defaults.systemPrompt;
  state.settings.temperature = prefs.temperature ?? state.defaults.temperature;

  const existing = prefs.activeChatId ? db.chat(prefs.activeChatId) : null;
  const latest = existing || db.chats()[0];
  if (latest) { state.chat = latest; db.setPref("activeChatId", latest.id); }
  else state.chat = db.createChat();

  renderChat();
  refreshAirGap();
  await refreshModels();
  await refreshStatus();
  ui.prompt.focus();

  setInterval(() => {
    refreshStatus();
    if (state.drawer === "connection") renderDrawer();
  }, 20000);
})();
