"use strict";

const { createOllama } = require("./ollama");

const PROVIDERS = ["ollama"];

function createProvider(config) {
  const name = config.provider || "ollama";
  if (name === "ollama") return createOllama(config.ollama);
  throw new Error(`Unknown model provider: ${name}. Use Ollama.`);
}

module.exports = { createProvider, PROVIDERS };
