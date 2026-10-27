"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "speech.js"), "utf8");
const local = { name: "Local", lang: "en-US", voiceURI: "local", localService: true };
const remote = { name: "Cloud", lang: "en-GB", voiceURI: "cloud", localService: false };

class Target {
  constructor() { this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] ||= new Set()).add(fn); }
  removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
}

class Element extends Target {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.isConnected = true;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { this.dispatchEvent({ type: "click" }); }
}

function harness(options = {}) {
  let list = options.voices || [remote, local];
  const errors = [];
  const spoken = [];
  const timers = new Map();
  let timerId = 0;
  const synth = new Target();
  synth.getVoices = () => list;
  synth.cancel = () => { if (options.cancelEnd) spoken.at(-1)?.onend(); };
  synth.speak = utterance => { spoken.push(utterance); };
  const window = new Target();
  window.speechSynthesis = options.unsupported ? null : synth;
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.localStorage = {
    getItem() { if (options.storageError) throw Error("blocked"); return options.saved || null; },
    setItem(key, value) {
      if (options.storageError) throw Error("blocked");
      window.saved = { key, value };
    },
    removeItem(key) {
      if (options.storageError) throw Error("blocked");
      window.removedKey = key;
    }
  };
  window.addEventListener("horizon-speech-error", event => errors.push(event.detail.message));
  const document = new Target();
  document.createElement = tag => new Element(tag);
  vm.runInNewContext(source, {
    window, document,
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  return {
    api: window.HorizonSpeech, window, document, errors, spoken, synth, timers,
    expire() { for (const fn of [...timers.values()]) fn(); },
    setVoices(value) { list = value; synth.dispatchEvent({ type: "voiceschanged" }); }
  };
}

test("remote-only and unverified voices fail closed after a bounded wait", async () => {
  const h = harness({ voices: [remote, { ...local, localService: undefined }] });
  const speaking = h.api.speak("Private text");
  assert.equal(h.timers.size, 1);
  h.expire();
  assert.equal(await speaking, false);
  assert.equal(h.spoken.length, 0);
  assert.match(h.errors[0], /no verified local/i);
});

test("sets an explicit local voice and language, never the default/cloud voice", async () => {
  const h = harness({ saved: JSON.stringify({ voice: remote.voiceURI }) });
  assert.equal(await h.api.speak("Hello"), true);
  assert.equal(h.spoken[0].voice, local);
  assert.equal(h.spoken[0].lang, "en-US");
});

test("voiceschanged resolves availability and removes its temporary listener", async () => {
  const h = harness({ voices: [] });
  const ready = h.api.available();
  h.setVoices([remote, local]);
  assert.equal(await ready, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.synth.listeners.voiceschanged.size, 1);
});

test("cancellation prevents old utterance callbacks and async loads from continuing", async () => {
  const h = harness({ cancelEnd: true });
  await h.api.speak("a".repeat(900));
  const old = h.spoken[0];
  h.api.stop();
  old.onend();
  assert.equal(h.spoken.length, 1);
  await h.api.speak("New");
  old.onerror({ error: "interrupted" });
  old.onend();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.errors.length, 0);
  h.setVoices([]);
  const pending = h.api.speak("Waiting");
  h.api.stop();
  h.setVoices([local]);
  assert.equal(await pending, false);
  assert.equal(h.spoken.length, 2);
});

test("chunks are bounded and over-limit text is rejected, not silently truncated", async () => {
  const h = harness();
  const text = "a".repeat(12000);
  await h.api.speak(text);
  for (let i = 0; i < h.spoken.length; i++) h.spoken[i].onend();
  assert.equal(h.spoken.length, 30);
  assert.ok(h.spoken.every(item => item.text.length <= 400));
  assert.equal(h.spoken.map(item => item.text).join(""), text);
  assert.equal(await h.api.speak(text + "a"), false);
  assert.match(h.errors[0], /characters/);
});

test("automatic reading is off by default and malformed preferences surface errors", async () => {
  const h = harness();
  assert.equal(await h.api.autoRead("Never autoplay"), false);
  assert.equal(h.spoken.length, 0);
  const bad = harness({ saved: "invalid json" });
  assert.equal(await bad.api.autoRead("No"), false);
  assert.match(bad.errors[0], /could not be loaded/);
});

test("speech errors are visible and disappearing local voices never fall back", async () => {
  const h = harness();
  await h.api.speak("a".repeat(700));
  h.spoken[0].onerror({ error: "not-allowed" });
  assert.match(h.errors[0], /not-allowed/);
  await h.api.speak("b".repeat(700));
  h.setVoices([remote]);
  h.spoken[1].onend();
  assert.equal(h.spoken.length, 2);
  assert.match(h.errors[1], /no longer available/);
});

test("reply buttons transfer ownership, toggle stop, and reflect pending state", async () => {
  const h = harness({ voices: [] });
  const container = new Element("div");
  const first = h.api.attach(container, () => "First");
  const second = h.api.attach(container, () => "Second");
  first.click();
  assert.equal(first.attributes["aria-busy"], "true");
  second.click();
  assert.equal(first.textContent, "Read aloud");
  h.setVoices([local]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.spoken.length, 1);
  assert.equal(second.textContent, "Stop reading");
  second.click();
  assert.equal(second.attributes["aria-pressed"], "false");
});

test("settings use labelled safe DOM, show local voices only, persist opt-in and storage errors", async () => {
  const h = harness({ storageError: true });
  const root = h.api.mountSettings(new Element("main"));
  const body = root.children[2];
  const [field, toggle] = body.children;
  const [label, select] = field.children;
  const checkbox = toggle.children[0];
  assert.equal(label.htmlFor, select.id);
  assert.equal(select.children.length, 2);
  assert.equal(select.children[1].value, "local");
  assert.equal(checkbox.checked, false);
  assert.match(h.errors[0], /loaded/);
  checkbox.checked = true;
  checkbox.dispatchEvent({ type: "change" });
  assert.match(h.errors[1], /saved/);
  assert.equal(await h.api.autoRead("Opted in"), true);
  checkbox.checked = false;
  checkbox.dispatchEvent({ type: "change" });
  assert.equal(await h.api.autoRead("Off"), false);
});

test("saved local preference is respected and settings changes persist the dedicated key", async () => {
  const other = { ...local, voiceURI: "other", name: "<not markup>" };
  const h = harness({ voices: [local, other], saved: JSON.stringify({ voice: "other", autoRead: true }) });
  await h.api.autoRead("Enabled");
  assert.equal(h.spoken[0].voice, other);
  const root = h.api.mountSettings(new Element("main"));
  const select = root.children[2].children[0].children[1];
  assert.equal(select.children[2].textContent, "<not markup> (en-US)");
  select.value = "local";
  select.dispatchEvent({ type: "change" });
  assert.equal(h.window.saved.key, "horizon.speech.preferences");
  assert.equal(JSON.parse(h.window.saved.value).voice, "local");
});

test("hidden tabs and page close cancel reading; unsupported browsers stay unavailable", async () => {
  const h = harness();
  await h.api.speak("a".repeat(800));
  h.document.hidden = true;
  h.document.dispatchEvent({ type: "visibilitychange" });
  h.spoken[0].onend();
  assert.equal(h.spoken.length, 1);
  h.window.dispatchEvent({ type: "pagehide" });
  assert.equal(await harness({ unsupported: true }).api.available(), false);
});

test("unexpected playback failures resolve false and surface an explicit event", async () => {
  const h = harness({ saved: JSON.stringify({ autoRead: true }) });
  h.synth.speak = () => { throw Error("engine failed"); };
  assert.equal(await h.api.autoRead("Automatic"), false);
  assert.match(h.errors[0], /engine failed/);
});

test("reset erases the dedicated key, cancels playback, and refreshes mounted settings", async () => {
  const h = harness({ saved: JSON.stringify({ voice: "local", autoRead: true }) });
  const root = h.api.mountSettings(new Element("main"));
  await h.api.autoRead("a".repeat(900));
  assert.equal(h.api.reset(), true);
  assert.equal(h.window.removedKey, "horizon.speech.preferences");
  h.spoken[0].onend();
  assert.equal(h.spoken.length, 1);
  assert.equal(root.children[2].children[1].children[0].checked, false);
  assert.equal(root.children[2].children[0].children[1].value, "");
  assert.equal(await h.api.autoRead("Must stay off"), false);
});

test("reset storage failure is visible and still disables automatic reading in this tab", async () => {
  const h = harness({ storageError: true });
  assert.equal(h.api.reset(), false);
  assert.match(h.errors[0], /could not be erased/);
  assert.equal(await h.api.autoRead("Must stay off"), false);
});
