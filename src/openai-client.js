"use strict";

const http = require("http");
const { isLoopbackHost } = require("./net");

// The OpenAI-compatible HTTP surface that every local runtime exposes. It is
// independent of how a runtime is installed, started or asked to download a
// model, which is why it lives apart from the provider modules.
//
// `label` names the runtime in error text ("Foundry", "Ollama") and `reachName`
// is what the user would recognise as the thing to start when it is down.
function createClient({ label, reachName = label }) {
  function assertLoopback(baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid ${label} base URL: ${baseUrl}`);
    }
    if (!isLoopbackHost(parsed.hostname)) {
      throw new Error(`Refusing to connect to a non-loopback ${label} endpoint: ${baseUrl}`);
    }
    return parsed;
  }

  async function fetchJson(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      }
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`${label} did not respond within ${timeoutMs} ms. The model may still be loading.`);
      }
      throw new Error(`Could not reach ${reachName} at ${url}. The service may have stopped (${error.message}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function listModels(baseUrl, timeoutMs) {
    const result = await fetchJson(`${baseUrl}/models`, { method: "GET" }, timeoutMs);
    if (!result.ok) throw new Error(`${label} returned HTTP ${result.status} for /models.`);
    return Array.isArray(result.payload?.data) ? result.payload.data : [];
  }

  async function chatCompletion(baseUrl, body, timeoutMs) {
    return fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, timeoutMs);
  }

  // Agent completions on a slow CPU can take longer than fetch's fixed
  // five-minute wait for response headers. This plain loopback request has no
  // timeout of its own: the run's signal carries Stop and the run time limit.
  function agentCompletion(baseUrl, body, signal, maxBytes = 262144) {
    const url = new URL(`${baseUrl}/chat/completions`);
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
      return Promise.reject(new Error("Agent inference must use a loopback HTTP endpoint."));
    }
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const request = http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) request.destroy(new Error("Agent model response exceeded 256 KB."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`${label} agent request failed (HTTP ${response.statusCode}): ${raw.slice(0, 1000)}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`${label} returned an unreadable agent response.`));
          }
        });
        response.on("error", reject);
      });
      const abort = () => request.destroy(signal.reason || new Error("Agent request cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      request.on("close", () => signal.removeEventListener("abort", abort));
      request.on("error", reject);
      request.end(payload);
    });
  }

  // Opens a streaming completion. The caller owns the returned controller so it
  // can abort when the browser disconnects mid-reply.
  async function chatCompletionStream(baseUrl, body, signal) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true }),
      signal
    });

    if (!response.ok) {
      let message = `${label} returned HTTP ${response.status}.`;
      try {
        const payload = JSON.parse(await response.text());
        if (payload?.error?.message) message = payload.error.message;
      } catch { /* keep the generic message */ }
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }

    return response;
  }

  // A cheap liveness check for an endpoint we believe in. A runtime may come
  // back on a new port after a restart, so an address that worked a minute ago
  // may now be dead, and reporting readiness against a dead address is worse
  // than an error.
  async function endpointAlive(baseUrl, timeoutMs = 4000) {
    if (!baseUrl) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/models`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    assertLoopback,
    fetchJson,
    listModels,
    chatCompletion,
    agentCompletion,
    chatCompletionStream,
    endpointAlive
  };
}

// Turns a raw SSE byte stream into decoded event payloads.
async function* parseServerSentEvents(response) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch { /* ignore malformed keep-alive frames */ }
      }
    }
  }
}

module.exports = { createClient, parseServerSentEvents };
