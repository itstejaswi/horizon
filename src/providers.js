"use strict";

const foundry = require("./foundry");
const { createOllama } = require("./ollama");

const PROVIDERS = ["foundry", "ollama"];

// Every provider exposes the same surface: lifecycle (start/stop), model
// management (catalogue/download/remove/load/unload), the OpenAI-compatible
// calls, and a few descriptive fields the server uses for wording and for
// capability checks. Anything provider-specific stays behind this seam.
function foundryProvider() {
  return {
    ...foundry,
    name: "foundry",
    label: "Foundry Local",
    docsUrl: "https://learn.microsoft.com/en-us/azure/foundry-local/",
    loadsOnDemand: false,
    supportsDictation: true,
    restartHint: "foundry server restart",
    loadHint: alias => `foundry model load ${alias}`,
    defaultAlias: "phi-4"
  };
}

function createProvider(config) {
  const name = config.provider || "foundry";
  if (name === "foundry") return foundryProvider();
  if (name === "ollama") return createOllama(config.ollama);
  throw new Error(`Unknown model provider: ${name}. Use one of: ${PROVIDERS.join(", ")}.`);
}

module.exports = { createProvider, PROVIDERS };
