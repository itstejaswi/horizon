"use strict";

// Browser/Windows voices only. No server speech endpoint is used.
window.HorizonSpeech = (() => {
  const KEY = "horizon.speech.preferences";
  const MAX_TEXT = 12000;
  const CHUNK_SIZE = 400;
  const panels = new Set();
  let preferences;
  let generation = 0;
  let active = null;
  let settingsId = 0;

  function report(message) {
    window.dispatchEvent(new CustomEvent("horizon-speech-error", { detail: { message } }));
  }

  function prefs() {
    if (preferences) return preferences;
    preferences = { voice: "", autoRead: false };
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
          throw new Error("Invalid speech preferences");
        }
        preferences.voice = typeof saved.voice === "string" ? saved.voice : "";
        preferences.autoRead = saved.autoRead === true;
      }
    } catch (error) {
      report(`Read-aloud preferences could not be loaded: ${error.message}`);
    }
    return preferences;
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(prefs()));
    } catch (error) {
      report(`Read-aloud preferences could not be saved; changes apply only to this tab: ${error.message}`);
    }
    refreshPanels();
  }

  function engine() {
    return window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function"
      ? window.speechSynthesis : null;
  }

  function voices() {
    const synth = engine();
    if (!synth) return [];
    try {
      return synth.getVoices().filter(voice => voice.localService === true);
    } catch (error) {
      report(`Local speech voices could not be listed: ${error.message}`);
      return [];
    }
  }

  // Resolves even when a browser never sends voiceschanged.
  async function available() {
    const synth = engine();
    if (!synth) return false;
    if (voices().length) return true;
    return new Promise(resolve => {
      const done = result => {
        clearTimeout(timer);
        if (typeof synth.removeEventListener === "function") {
          synth.removeEventListener("voiceschanged", changed);
        }
        resolve(result);
      };
      const changed = () => { if (voices().length) done(true); };
      const timer = setTimeout(() => done(voices().length > 0), 2000);
      if (typeof synth.addEventListener === "function") {
        synth.addEventListener("voiceschanged", changed);
      }
      changed();
    });
  }

  function buttonState(button, state) {
    if (!button) return;
    const reading = state !== "idle";
    button.textContent = state === "loading" ? "Stop reading (loading…)" : reading ? "Stop reading" : "Read aloud";
    button.setAttribute("aria-label", reading ? "Stop reading" : "Read aloud");
    button.setAttribute("aria-pressed", String(reading));
    button.setAttribute("aria-busy", String(state === "loading"));
  }

  function stop() {
    generation++;
    buttonState(active && active.button, "idle");
    active = null;
    const synth = engine();
    if (synth) {
      try { synth.cancel(); }
      catch (error) { report(`Read aloud could not stop: ${error.message}`); }
    }
  }

  function chunks(text) {
    const result = [];
    let remaining = text.trim();
    while (remaining.length > CHUNK_SIZE) {
      const prefix = remaining.slice(0, CHUNK_SIZE);
      const boundary = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
      const space = prefix.lastIndexOf(" ");
      const end = boundary > CHUNK_SIZE / 2 ? boundary + 1 : space > CHUNK_SIZE / 2 ? space : CHUNK_SIZE;
      result.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    if (remaining) result.push(remaining);
    return result;
  }

  async function start(text, button) {
    stop();
    const id = generation;
    if (typeof text !== "string" || !text.trim()) {
      report("There is no reply text to read aloud.");
      return false;
    }
    if (text.length > MAX_TEXT) {
      report(`Read aloud supports replies up to ${MAX_TEXT.toLocaleString()} characters.`);
      return false;
    }
    active = { button };
    buttonState(button, "loading");
    const ready = await available();
    if (id !== generation) return false;
    if (!ready) {
      stop();
      report("Read aloud is unavailable: no verified local Windows/browser voice is installed. Remote and default voices will not be used.");
      return false;
    }
    const queue = chunks(text);
    let index = 0;
    function next() {
      if (id !== generation) return;
      if (index === queue.length) {
        buttonState(button, "idle");
        active = null;
        return;
      }
      // Re-resolve every chunk: a removed local voice must never become a default.
      const local = voices();
      const voice = local.find(item => item.voiceURI === prefs().voice) || local[0];
      if (!voice) {
        stop();
        report("The local read-aloud voice is no longer available. Reading stopped.");
        return;
      }
      try {
        const utterance = new window.SpeechSynthesisUtterance(queue[index++]);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.onend = next;
        utterance.onerror = event => {
          if (id !== generation) return;
          stop();
          report(`Read aloud failed (${event.error || "unknown speech error"}). Try Read aloud again; the browser may require a click to allow playback.`);
        };
        active.utterance = utterance;
        buttonState(button, "reading");
        engine().speak(utterance);
      } catch (error) {
        stop();
        report(`Read aloud failed: ${error.message}`);
      }
    }
    next();
    return id === generation;
  }

  function safelyStart(text, button) {
    return start(text, button).catch(error => {
      stop();
      report(`Read aloud failed: ${error.message}`);
      return false;
    });
  }

  function speak(text) { return safelyStart(text, null); }

  function autoRead(text) {
    return prefs().autoRead ? speak(text) : Promise.resolve(false);
  }

  function reset() {
    stop();
    preferences = { voice: "", autoRead: false };
    let removed = true;
    try {
      window.localStorage.removeItem(KEY);
    } catch (error) {
      removed = false;
      report(`Read-aloud preferences could not be erased; automatic reading is off in this tab, but saved preferences may remain: ${error.message}`);
    }
    refreshPanels();
    return removed;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function attach(container, getText) {
    const button = node("button", "btn-subtle", "Read aloud");
    button.type = "button";
    buttonState(button, "idle");
    button.addEventListener("click", () => {
      if (active && active.button === button) { stop(); return; }
      try { void safelyStart(getText(), button); }
      catch (error) { report(`Reply text could not be read: ${error.message}`); }
    });
    container.append(button);
    return button;
  }

  function refreshPanels() {
    const local = voices();
    for (const panel of panels) {
      if (!panel.root.isConnected) { panels.delete(panel); continue; }
      panel.select.replaceChildren();
      const automatic = node("option", "", "Automatic (local voice only)");
      automatic.value = "";
      panel.select.append(automatic);
      for (const voice of local) {
        const option = node("option", "", `${voice.name} (${voice.lang})`);
        option.value = voice.voiceURI;
        panel.select.append(option);
      }
      const saved = prefs();
      const found = local.some(voice => voice.voiceURI === saved.voice);
      panel.select.value = found ? saved.voice : "";
      panel.select.disabled = local.length === 0;
      panel.checkbox.checked = saved.autoRead;
      panel.status.textContent = local.length
        ? found || !saved.voice ? "Local-only read aloud is available." : "Saved voice is unavailable; another verified local voice will be used."
        : "Read aloud is unavailable: no verified local voice found. Install a Windows speech voice or use a browser exposing local voices. Remote/default voices are never used.";
    }
  }

  function mountSettings(parent) {
    const root = node("section", "settings-card");
    root.append(node("h3", "settings-card-title", "Read aloud"),
      node("p", "settings-card-sub", "Optional local-only speech supplied by Windows/browser voices. Reply text stays in the browser's local speech engine; no server speech API or microphone is used."));
    const body = node("div", "settings-card-body");
    const field = node("div", "field");
    const label = node("label", "", "Local voice");
    const select = node("select", "select");
    select.id = `horizon-speech-voice-${++settingsId}`;
    label.htmlFor = select.id;
    const status = node("p", "field-hint", "Looking for local voices…");
    status.setAttribute("role", "status");
    status.id = `${select.id}-status`;
    select.setAttribute("aria-describedby", status.id);
    field.append(label, select, status);
    const toggle = node("label", "setup-row");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    toggle.append(checkbox, node("span", "", "Automatically read new replies (off by default)"));
    const hint = node("p", "field-hint", "You can always choose Read aloud on a reply. Automatic reading may require a click first because of browser autoplay rules.");
    const stopButton = node("button", "btn-subtle", "Stop reading");
    stopButton.type = "button";
    stopButton.addEventListener("click", stop);
    select.addEventListener("change", () => { prefs().voice = select.value; stop(); save(); });
    checkbox.addEventListener("change", () => {
      prefs().autoRead = checkbox.checked;
      if (!checkbox.checked) stop();
      save();
    });
    body.append(field, toggle, hint, stopButton);
    root.append(body);
    parent.append(root);
    panels.add({ root, select, checkbox, status });
    refreshPanels();
    void available().then(refreshPanels);
    return root;
  }

  if (engine() && typeof engine().addEventListener === "function") {
    engine().addEventListener("voiceschanged", refreshPanels);
  }
  window.addEventListener("pagehide", stop);
  window.addEventListener("beforeunload", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });

  return { speak, stop, available, attach, mountSettings, autoRead, reset };
})();
