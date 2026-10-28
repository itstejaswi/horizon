// Horizon's OpenClaw bridge. It owns no permissions: each tool forwards the
// model's request to the run's authenticated broker, which applies Horizon's
// grants, exact-call approvals, budget and cancellation. The bearer token
// arrives only through the environment and is never written to config.

const PREFIX = "horizon_";
const MAX_RESULT_CHARS = 16000;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function callBroker(baseUrl, name, args, signal) {
  const token = process.env.HORIZON_BROKER_TOKEN;
  if (!token) throw new Error("Horizon broker credential is missing; this run cannot use Horizon tools.");
  const response = await fetch(`${baseUrl}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, arguments: args }),
    redirect: "error",
    signal
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Horizon broker returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || !record(body) || typeof body.result !== "string") {
    const message = record(body) && record(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : `HTTP ${response.status}`;
    throw new Error(`Horizon tool ${name} failed: ${message}`);
  }
  return body.result.length > MAX_RESULT_CHARS ? body.result.slice(0, MAX_RESULT_CHARS) : body.result;
}

export default {
  id: "horizon-bridge",
  name: "Horizon bridge",
  description: "Forwards granted Horizon tools to Horizon's per-run broker.",
  register(api) {
    const config = record(api.pluginConfig) ? api.pluginConfig : {};
    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)) {
      api.logger?.warn?.("Horizon bridge has no loopback broker URL; no tools registered.");
      return;
    }
    const definitions = Array.isArray(config.tools) ? config.tools : [];
    for (const definition of definitions) {
      const fn = record(definition) && record(definition.function) ? definition.function : null;
      if (!fn || typeof fn.name !== "string" || !record(fn.parameters)) continue;
      const name = fn.name;
      api.registerTool({
        name: PREFIX + name,
        label: `Horizon ${name}`,
        description: typeof fn.description === "string" ? fn.description : name,
        parameters: fn.parameters,
        // The broker accepts one tool call at a time.
        executionMode: "sequential",
        async execute(_toolCallId, params, signal) {
          const text = await callBroker(baseUrl, name, record(params) ? params : {}, signal);
          return { content: [{ type: "text", text }], details: { tool: name } };
        }
      }, { optional: true });
    }
  }
};
