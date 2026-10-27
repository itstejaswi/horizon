"use strict";

const http = require("node:http");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_MODEL_CALLS = 33;
const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_LIST = { data: [{ id: "horizon-local", object: "model", owned_by: "local" }] };

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("Value cannot be serialized as JSON");
  return Buffer.byteLength(json, "utf8");
}

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("not JSON serializable");
    return JSON.parse(encoded);
  } catch (error) {
    throw new TypeError(`${label} must contain only JSON values: ${error.message}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolName(definition) {
  return definition && definition.type === "function" &&
    definition.function && typeof definition.function.name === "string"
    ? definition.function.name
    : null;
}

function normalizeToolName(name) {
  return name.startsWith("horizon_") ? name.slice("horizon_".length) : name;
}

function resolveToolName(name, names) {
  if (names.has(name)) return name;
  const normalized = normalizeToolName(name);
  return normalized !== name && names.has(normalized) ? normalized : null;
}

function validateDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length > 500) {
    throw new TypeError("definitions must be an array of at most 500 OpenAI function tools");
  }
  const cloned = cloneJson(definitions, "definitions");
  const names = new Set();
  const schemas = new Map();
  for (const definition of cloned) {
    const name = toolName(definition);
    if (!name || !/^[a-zA-Z0-9_-]{1,128}$/.test(name) ||
        !isRecord(definition.function.parameters) ||
        definition.function.parameters.type !== "object") {
      throw new TypeError("Each definition must be an OpenAI function tool with an object parameter schema");
    }
    if (names.has(name)) throw new TypeError(`Duplicate tool definition "${name}"`);
    names.add(name);
    schemas.set(name, definition.function.parameters);
  }
  if (jsonBytes({ tools: cloned }) > MAX_RESPONSE_BYTES) {
    throw new TypeError(`definitions exceed the ${MAX_RESPONSE_BYTES}-byte response limit`);
  }
  return { definitions: cloned, names, schemas };
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  let body;
  try {
    body = JSON.stringify(value);
    if (typeof body !== "string") throw new Error("Response cannot be serialized as JSON");
  } catch (error) {
    status = 500;
    body = JSON.stringify({ error: { message: `Unable to serialize response: ${error.message}`, type: "server_error" } });
  }
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    status = 502;
    body = JSON.stringify({ error: { message: `Response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`, type: "response_too_large" } });
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendError(res, status, message, code) {
  sendJson(res, status, { error: { message, type: "broker_error", ...(code ? { code } : {}) } });
}

async function readJson(req) {
  const contentType = req.headers["content-type"] || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  let exceeded = false;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      exceeded = true;
      continue;
    }
    if (!exceeded) chunks.push(chunk);
  }
  if (exceeded) {
    const error = new Error(`Request exceeds the ${MAX_BODY_BYTES}-byte limit`);
    error.status = 413;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
  if (!isRecord(value)) {
    const error = new Error("Request body must be a JSON object");
    error.status = 400;
    throw error;
  }
  return value;
}

function validateChatBody(body, names, schemas) {
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new TypeError("stream must be a boolean when supplied");
  }
  if (body.stream_options !== undefined &&
      (!isRecord(body.stream_options) ||
       (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean"))) {
    throw new TypeError("stream_options must be an object with a boolean include_usage when supplied");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 10_000) {
    throw new TypeError("messages must be a non-empty array");
  }
  const roles = new Set(["system", "developer", "user", "assistant", "tool"]);
  for (const message of body.messages) {
    if (!isRecord(message) || !roles.has(message.role)) {
      throw new TypeError("Each message must be an object with a supported role");
    }
    if (message.role === "assistant") {
      if (!Object.hasOwn(message, "content") && !Array.isArray(message.tool_calls)) {
        throw new TypeError("Assistant messages must include content or tool_calls");
      }
    } else if (!Object.hasOwn(message, "content")) {
      throw new TypeError(`${message.role} messages must include content`);
    }
    if (Object.hasOwn(message, "content") &&
        message.content !== null &&
        typeof message.content !== "string" &&
        !Array.isArray(message.content)) {
      throw new TypeError(`${message.role} message content must be a string, array, or null`);
    }
    if (message.role === "tool" && (typeof message.tool_call_id !== "string" || !message.tool_call_id)) {
      throw new TypeError("Tool messages must include a tool_call_id");
    }
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
        throw new TypeError("tool_calls are supported only as an assistant array");
      }
      for (const call of message.tool_calls) {
        const name = call && call.function && call.function.name;
        const allowedName = typeof name === "string" ? resolveToolName(name, names) : null;
        if (!allowedName) {
          throw new TypeError(`Message references an unavailable tool "${String(name)}"`);
        }
        if (!isRecord(call) || typeof call.id !== "string" || call.type !== "function" ||
            !isRecord(call.function) || typeof call.function.arguments !== "string") {
          throw new TypeError("Assistant tool calls must include an id, function name, and JSON arguments");
        }
        let args;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          throw new TypeError(`Assistant tool call "${call.id}" has invalid JSON arguments`);
        }
        if (!isRecord(args)) throw new TypeError(`Assistant tool call "${call.id}" arguments must be a JSON object`);
      }
    }
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new TypeError("tools must be an array when supplied");
    const seen = new Set();
    for (const supplied of body.tools) {
      const name = toolName(supplied);
      const allowedName = name ? resolveToolName(name, names) : null;
      if (!allowedName) {
        throw new TypeError(`Request includes an unavailable tool "${String(name)}"`);
      }
      const normalized = allowedName;
      if (seen.has(normalized)) throw new TypeError(`Request includes duplicate tool "${normalized}"`);
      if (!isRecord(supplied.function.parameters) ||
          canonicalJson(supplied.function.parameters) !== canonicalJson(schemas.get(normalized))) {
        throw new TypeError(`Request changes the allowed parameter schema for tool "${normalized}"`);
      }
      seen.add(normalized);
    }
  }
}

function validateCompletion(response) {
  if (!isRecord(response) || Object.hasOwn(response, "error") ||
      !Array.isArray(response.choices) || response.choices.length === 0) {
    throw new TypeError("Model returned a malformed completion");
  }
  const indices = new Set();
  for (const [position, choice] of response.choices.entries()) {
    if (!isRecord(choice) || !isRecord(choice.message) || choice.message.role !== "assistant") {
      throw new TypeError("Model returned a malformed completion choice");
    }
    const index = choice.index === undefined ? position : choice.index;
    if (!Number.isInteger(index) || index < 0 || indices.has(index)) {
      throw new TypeError("Model returned an invalid completion choice index");
    }
    indices.add(index);
    const message = choice.message;
    if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
      throw new TypeError("Model returned invalid assistant content");
    }
    if (message.content === undefined && !Array.isArray(message.tool_calls)) {
      throw new TypeError("Model returned no assistant content or tool calls");
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new TypeError("Model returned invalid tool calls");
      for (const call of message.tool_calls) {
        if (!isRecord(call) || typeof call.id !== "string" || !call.id || call.type !== "function" ||
            !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name ||
            typeof call.function.arguments !== "string") {
          throw new TypeError("Model returned a malformed tool call");
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null &&
        typeof choice.finish_reason !== "string") {
      throw new TypeError("Model returned an invalid finish reason");
    }
  }
  if (jsonBytes(response) > MAX_RESPONSE_BYTES) {
    const error = new Error(`Response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`);
    error.code = "response_too_large";
    throw error;
  }
}

function completionEvents(response, includeUsage) {
  const metadata = {
    id: typeof response.id === "string" ? response.id : `chatcmpl-${randomBytes(16).toString("hex")}`,
    object: "chat.completion.chunk",
    created: Number.isInteger(response.created) ? response.created : Math.floor(Date.now() / 1000),
    model: "horizon-local"
  };
  const events = [];
  const chunk = choices => events.push(`data: ${JSON.stringify({ ...metadata, choices })}\n\n`);
  for (const [position, choice] of response.choices.entries()) {
    const index = choice.index === undefined ? position : choice.index;
    const message = choice.message;
    chunk([{ index, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    if (typeof message.content === "string" && message.content) {
      chunk([{ index, delta: { content: message.content }, finish_reason: null }]);
    }
    if (message.tool_calls && message.tool_calls.length) {
      chunk([{
        index,
        delta: {
          tool_calls: message.tool_calls.map((call, toolIndex) => ({
            index: toolIndex,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: call.function.arguments }
          }))
        },
        finish_reason: null
      }]);
    }
    chunk([{
      index,
      delta: {},
      finish_reason: choice.finish_reason || (message.tool_calls?.length ? "tool_calls" : "stop")
    }]);
  }
  if (includeUsage && response.usage !== undefined) {
    events.push(`data: ${JSON.stringify({ ...metadata, choices: [], usage: response.usage })}\n\n`);
  }
  events.push("data: [DONE]\n\n");
  const body = events.join("");
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    const error = new Error(`Streaming response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`);
    error.code = "response_too_large";
    throw error;
  }
  return body;
}

async function createBroker({
  definitions,
  invoke,
  complete,
  signal,
  onModel,
  onFailure,
  maxModelCalls = DEFAULT_MAX_MODEL_CALLS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof invoke !== "function" || typeof complete !== "function") {
    throw new TypeError("invoke and complete must be functions");
  }
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1) {
    throw new TypeError("maxModelCalls must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  if (onModel !== undefined && typeof onModel !== "function") {
    throw new TypeError("onModel must be a function");
  }
  if (onFailure !== undefined && typeof onFailure !== "function") {
    throw new TypeError("onFailure must be a function");
  }
  if (signal && signal.aborted) throw createAbortError("Broker run was cancelled");

  const validated = validateDefinitions(definitions);
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  const localController = new AbortController();
  let baseUrl;
  let modelCalls = 0;
  let toolBusy = false;
  let closed = false;
  let closePromise;
  const abortParent = () => {
    localController.abort(signal.reason || createAbortError("Broker run was cancelled"));
    close();
  };

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    if (!localController.signal.aborted) {
      localController.abort(createAbortError("Broker closed"));
    }
    if (signal) signal.removeEventListener("abort", abortParent);
    for (const socket of sockets) socket.destroy();
    closePromise = new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    return closePromise;
  }

  function authAndOriginOk(req) {
    if (req.headers.host !== new URL(baseUrl).host) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== baseUrl) return false;
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite !== undefined && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
    const authorization = req.headers.authorization || "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return false;
    const supplied = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async function notifyFailure(error) {
    if (!onFailure) return;
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => onFailure(error)),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Failure callback timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function operationSignal(req, res) {
    const controller = new AbortController();
    const abortFromBroker = () => controller.abort(localController.signal.reason || createAbortError("Broker run was cancelled"));
    const abortFromRequest = () => controller.abort(createAbortError("Client disconnected"));
    const abortFromResponse = () => {
      if (!res.writableEnded) abortFromRequest();
    };
    if (localController.signal.aborted) abortFromBroker();
    else localController.signal.addEventListener("abort", abortFromBroker, { once: true });
    req.once("aborted", abortFromRequest);
    res.once("close", abortFromResponse);
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Broker request timed out after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        controller.abort(error);
      }, timeoutMs);
      const rejectAbort = () => reject(controller.signal.reason || createAbortError("Broker request cancelled"));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    function cleanup() {
      clearTimeout(timer);
      localController.signal.removeEventListener("abort", abortFromBroker);
      req.removeListener("aborted", abortFromRequest);
      res.removeListener("close", abortFromResponse);
    }
    return { signal: controller.signal, deadline, cleanup };
  }

  async function runOperation(req, res, operation) {
    const control = operationSignal(req, res);
    const work = Promise.resolve().then(() => operation(control.signal));
    try {
      return await Promise.race([work, control.deadline]);
    } finally {
      control.cleanup();
    }
  }

  async function handle(req, res) {
    if (closed) return sendError(res, 503, "Broker is closed", "broker_closed");
    if (!authAndOriginOk(req)) return sendError(res, 403, "Request is not authorized for this local broker", "forbidden");
    const pathname = new URL(req.url, baseUrl).pathname;

    if (req.method === "GET" && pathname === "/tools") {
      return sendJson(res, 200, { tools: validated.definitions });
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      return sendJson(res, 200, MODEL_LIST);
    }
    if (req.method === "POST" && pathname === "/tools/call") {
      let body;
      try {
        body = await readJson(req);
        if (typeof body.name !== "string" || !validated.names.has(body.name)) {
          const error = new Error(`Tool "${String(body.name)}" is not allowed`);
          error.status = 403;
          error.code = "tool_not_allowed";
          throw error;
        }
        if (!isRecord(body.arguments)) {
          const error = new Error("arguments must be a JSON object");
          error.status = 400;
          error.code = "invalid_arguments";
          throw error;
        }
        if (toolBusy) return sendError(res, 409, "Another tool invocation is awaiting completion", "tool_call_in_progress");
        toolBusy = true;
        let failureNotified = false;
        const notifyOnce = async error => {
          if (failureNotified) return;
          failureNotified = true;
          await notifyFailure(error);
        };
        const operation = runOperation(req, res, async operationSignal => {
          const call = Promise.resolve().then(() => invoke(body.name, body.arguments, operationSignal));
          const handledCall = call.catch(async error => {
            await notifyOnce(error);
            throw error;
          });
          handledCall.then(() => { toolBusy = false; }, () => { toolBusy = false; });
          try {
            const result = await Promise.race([
              handledCall,
              new Promise((resolve, reject) => {
                if (operationSignal.aborted) reject(operationSignal.reason);
                else operationSignal.addEventListener("abort", () => reject(operationSignal.reason), { once: true });
              })
            ]);
            return { result };
          } catch (error) {
            if (operationSignal.aborted) {
              const reason = operationSignal.reason || error;
              if (reason && reason.code === "ETIMEDOUT") await notifyOnce(reason);
              throw reason;
            }
            throw error;
          }
        });
        try {
          return sendJson(res, 200, await operation);
        } catch (error) {
          const status = error.code === "ETIMEDOUT" ? 504 : 500;
          if (!res.destroyed) sendError(res, status, error.message || "Tool invocation failed", error.code);
          return;
        }
      } catch (error) {
        const status = error.status || 400;
        if (status === 403 && error.code === "tool_not_allowed") {
          try {
            await notifyFailure(error);
          } catch (callbackError) {
            error = new AggregateError([error, callbackError], "Tool policy failure callback failed");
          }
        }
        return sendError(res, status, error.message || "Invalid tool call", error.code);
      }
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      let body;
      try {
        body = await readJson(req);
        validateChatBody(body, validated.names, validated.schemas);
      } catch (error) {
        return sendError(res, error.status || 400, error.message || "Invalid model request", error.code);
      }
      if (modelCalls >= maxModelCalls) {
        const error = new Error(`Model call limit of ${maxModelCalls} reached`);
        error.code = "model_call_limit";
        try {
          await notifyFailure(error);
        } catch {
          return sendError(res, 502, "Model call limit reached; failure callback also failed", "failure_callback_failed");
        }
        return sendError(res, 429, `Model call limit of ${maxModelCalls} reached`, "model_call_limit");
      }
      modelCalls += 1;
      try {
        if (onModel) await runOperation(req, res, () => onModel(body));
        const response = await runOperation(req, res, operationSignal => complete({ ...body, stream: false }, operationSignal));
        validateCompletion(response);
        if (body.stream === true) {
          const events = completionEvents(response, body.stream_options?.include_usage === true);
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          });
          return res.end(events);
        }
        const publicResponse = Object.hasOwn(response, "model")
          ? { ...response, model: "horizon-local" }
          : response;
        if (jsonBytes(publicResponse) > MAX_RESPONSE_BYTES) {
          const error = new Error(`Response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`);
          error.code = "response_too_large";
          throw error;
        }
        return sendJson(res, 200, publicResponse);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Model completion failed", { cause: error });
        let callbackFailed = false;
        try {
          await notifyFailure(failure);
        } catch {
          callbackFailed = true;
        }
        const timedOut = failure.code === "ETIMEDOUT";
        if (!res.destroyed) {
          sendError(
            res,
            timedOut ? 504 : 502,
            callbackFailed ? "Model completion failed; failure callback also failed" :
              timedOut ? `Model request timed out after ${timeoutMs}ms` :
                failure.code === "response_too_large" ? `Response exceeds the ${MAX_RESPONSE_BYTES}-byte limit` : "Model completion failed",
            callbackFailed ? "failure_callback_failed" :
              timedOut ? "model_timeout" : failure.code === "response_too_large" ? failure.code : "model_completion_failed"
          );
        }
      }
      return;
    }
    const knownPath = ["/tools", "/tools/call", "/v1/models", "/v1/chat/completions"].includes(pathname);
    return sendError(res, knownPath ? 405 : 404, knownPath ? "Method not allowed" : "Route not found", knownPath ? "method_not_allowed" : "not_found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.destroyed) sendError(res, 500, error.message || "Broker request failed");
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    if (signal && signal.aborted) {
      await close();
      throw createAbortError("Broker run was cancelled");
    }
    if (signal) signal.addEventListener("abort", abortParent, { once: true });
  } catch (error) {
    await close();
    throw error;
  }

  return { baseUrl, token, close };
}

module.exports = { createBroker };
