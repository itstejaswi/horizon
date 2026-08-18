"use strict";

/* ============================================================================
   Horizon local storage
   Everything here stays in this browser profile on this machine. Nothing is
   uploaded, and nothing is written outside the browser's own storage.
   ========================================================================== */

const NS = "horizon.v1";
const LEGACY_NS = "localmind.v1";

// The app was renamed from LocalMind to Horizon. Anything saved under the old
// namespace is moved across once, so an existing user keeps their chats,
// prompts and memory instead of opening the app to an empty slate.
function migrateLegacyNamespace() {
  try {
    const legacyKeys = Object.keys(localStorage).filter(key => key.startsWith(`${LEGACY_NS}.`));
    if (!legacyKeys.length) return;

    for (const legacyKey of legacyKeys) {
      const key = `${NS}.${legacyKey.slice(LEGACY_NS.length + 1)}`;
      // Never overwrite data already saved under the new name.
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, localStorage.getItem(legacyKey));
      }
      localStorage.removeItem(legacyKey);
    }
  } catch {
    // Storage may be unavailable or full; the app still works without history.
  }
}

migrateLegacyNamespace();

const DEFAULT_PROMPTS = [
  { id: "p-explain", title: "Explain simply", body: "Explain the following in plain language, as if to a bright colleague from another field:\n\n" },
  { id: "p-summarise", title: "Summarise", body: "Summarise the key points below in at most five bullets. Keep it factual.\n\n" },
  { id: "p-improve", title: "Improve this writing", body: "Improve the clarity and flow of the text below without changing its meaning or tone:\n\n" },
  { id: "p-code", title: "Review this code", body: "Review the code below. Point out bugs and edge cases first, then style. Be specific.\n\n" },
  { id: "p-counter", title: "Argue the other side", body: "Give me the strongest honest counter-argument to the position below:\n\n" }
];

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(`${NS}.${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(`${NS}.${key}`, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    // Quota is the realistic failure here, and silently losing a conversation
    // would be worse than saying so.
    const quota = error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
    return {
      ok: false,
      error: quota
        ? "This browser's storage is full. Delete some old chats to save new ones."
        : `Could not save: ${error.message}`
    };
  }
}

const store = {
  onError: null,

  save(key, value) {
    const result = write(key, value);
    if (!result.ok && this.onError) this.onError(result.error);
    // Every write funnels through here, so this is the one place that needs to
    // know a change happened. The listener decides whether to act on it.
    if (result.ok && this.onChange) this.onChange(key);
    return result.ok;
  },

  /* ------------------------------------------------------------- chats -- */

  chats() {
    return read("chats", []);
  },

  chat(id) {
    return this.chats().find(chat => chat.id === id) || null;
  },

  // Not written to storage until it has something in it. An empty chat is an
  // intention, not a record: creating one on every launch, and again every time
  // the plus button is pressed, left a list of "New chat" entries that nobody
  // asked for and that survived erasing everything. It is saved by the first
  // message, in updateChat below.
  createChat(title = "New chat") {
    return { id: newId("c"), title, turns: [], createdAt: Date.now(), updatedAt: Date.now(), unsaved: true };
  },

  updateChat(id, changes) {
    const chats = this.chats();
    const index = chats.findIndex(chat => chat.id === id);

    // First write of a chat that was never saved. It has content now, so it
    // earns its place in the list rather than being dropped.
    if (index === -1) {
      const chat = {
        id,
        title: "New chat",
        turns: [],
        createdAt: Date.now(),
        ...changes,
        updatedAt: Date.now()
      };
      chats.unshift(chat);
      this.save("chats", chats);
      return chat;
    }

    chats[index] = { ...chats[index], ...changes, updatedAt: Date.now() };
    // Most recently used first.
    const [moved] = chats.splice(index, 1);
    chats.unshift(moved);
    this.save("chats", chats);
    return moved;
  },

  deleteChat(id) {
    this.save("chats", this.chats().filter(chat => chat.id !== id));
  },

  clearAllChats() {
    this.save("chats", []);
  },

  /* ----------------------------------------------------------- prompts -- */

  prompts() {
    return read("prompts", DEFAULT_PROMPTS);
  },

  addPrompt(title, body) {
    const prompts = this.prompts();
    prompts.unshift({ id: newId("p"), title, body });
    this.save("prompts", prompts);
  },

  deletePrompt(id) {
    this.save("prompts", this.prompts().filter(prompt => prompt.id !== id));
  },

  resetPrompts() {
    this.save("prompts", DEFAULT_PROMPTS);
  },

  /* ------------------------------------------------------------ memory -- */

  memory() {
    return read("memory", { enabled: true, facts: [] });
  },

  addFact(text) {
    const memory = this.memory();
    memory.facts.unshift({ id: newId("m"), text, addedAt: Date.now() });
    this.save("memory", memory);
  },

  deleteFact(id) {
    const memory = this.memory();
    memory.facts = memory.facts.filter(fact => fact.id !== id);
    this.save("memory", memory);
  },

  setMemoryEnabled(enabled) {
    const memory = this.memory();
    memory.enabled = enabled;
    this.save("memory", memory);
  },

  clearMemory() {
    this.save("memory", { enabled: this.memory().enabled, facts: [] });
  },

  /* ----------------------------------------------------------- library -- */

  library() {
    return read("library", []);
  },

  addToLibrary(item) {
    const library = this.library();
    library.unshift({ id: newId("l"), savedAt: Date.now(), ...item });
    this.save("library", library);
  },

  deleteFromLibrary(id) {
    this.save("library", this.library().filter(item => item.id !== id));
  },

  clearLibrary() {
    this.save("library", []);
  },

  /* -------------------------------------------------------- preferences -- */

  prefs() {
    // Dark is the default: this is a tool people sit in front of for long
    // stretches, and the surface texture was tuned on the dark palette first.
    return read("prefs", { theme: "dark", logLevel: "summary", activeChatId: null });
  },

  setPref(key, value) {
    const prefs = this.prefs();
    // A null or undefined value removes the preference entirely, so callers
    // can clear an override and fall back to the default rather than pinning
    // whatever the default happened to be at the time.
    if (value === null || value === undefined) delete prefs[key];
    else prefs[key] = value;
    this.save("prefs", prefs);
  },

  /* ------------------------------------------------------------- admin -- */

  usageBytes() {
    let total = 0;
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(NS)) total += localStorage.getItem(key).length;
      }
    } catch { /* storage unavailable */ }
    return total;
  },

  eraseEverything() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(NS)) localStorage.removeItem(key);
      }
    } catch { /* storage unavailable */ }
  },

  /* -------------------------------------------------------- portability -- */

  // Everything the user has created or configured, in one object. Chats,
  // prompts, memory, saved replies AND preferences -- a backup that restored
  // your conversations but lost your instructions and theme would not be a
  // backup, it would be a surprise.
  exportAll() {
    return {
      chats: this.chats(),
      prompts: this.prompts(),
      memory: this.memory(),
      library: this.library(),
      prefs: this.prefs()
    };
  },

  // Replace mode wipes first; merge mode keeps what is already here and adds
  // anything new, matched on id so a restore cannot silently duplicate.
  importAll(data, { mode = "replace" } = {}) {
    if (!data || typeof data !== "object") throw new Error("There is nothing to restore in that file.");

    const known = ["chats", "prompts", "memory", "library", "prefs"];
    if (!known.some(key => key in data)) {
      throw new Error("That file does not contain any Horizon data.");
    }

    const counts = {};

    if (mode === "replace") {
      for (const key of known) {
        if (data[key] !== undefined) {
          this.save(key, data[key]);
          counts[key] = Array.isArray(data[key]) ? data[key].length : 1;
        }
      }
      return counts;
    }

    const mergeById = (key, incoming) => {
      if (!Array.isArray(incoming)) return 0;
      const current = read(key, []);
      const seen = new Set(current.map(item => item.id));
      const added = incoming.filter(item => item?.id && !seen.has(item.id));
      if (added.length) this.save(key, current.concat(added));
      return added.length;
    };

    counts.chats = mergeById("chats", data.chats);
    counts.prompts = mergeById("prompts", data.prompts);
    counts.library = mergeById("library", data.library);

    if (data.memory?.facts) {
      const current = this.memory();
      const seen = new Set(current.facts.map(fact => fact.id));
      const added = data.memory.facts.filter(fact => fact?.id && !seen.has(fact.id));
      if (added.length) {
        this.save("memory", { ...current, facts: current.facts.concat(added) });
      }
      counts.memory = added.length;
    }

    // Preferences are single-valued, so merging means keeping what is here and
    // filling in anything absent rather than overwriting a working setup.
    if (data.prefs) {
      const current = this.prefs();
      this.save("prefs", { ...data.prefs, ...current });
      counts.prefs = 1;
    }

    return counts;
  }
};

window.HorizonStore = store;
