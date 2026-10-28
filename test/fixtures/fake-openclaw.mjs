// Stands in for `openclaw agent --local --json` in tests. It reads the
// adapter's config the way OpenClaw does, talks to the broker over HTTP and
// prints OpenClaw's JSON shape. The request text selects the behaviour.

import fs from "node:fs";

const args = process.argv.slice(2);
const messageFile = args[args.indexOf("--message-file") + 1];
const request = fs.readFileSync(messageFile, "utf8");
const mode = /MODE:(\w+)/.exec(request)?.[1] || "tool";
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const provider = config.models.providers.horizon;
const bridge = config.plugins.entries["horizon-bridge"].config;
const token = process.env.HORIZON_BROKER_TOKEN;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const tools = bridge.tools.map(item => ({ ...item, function: { ...item.function, name: `horizon_${item.function.name}` } }));

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const report = {
  envKeys: Object.keys(process.env).filter(key => /KEY|TOKEN|PROXY/i.test(key)).sort(),
  configHasToken: JSON.stringify(config).includes(token),
  apiKey: provider.apiKey
};

if (mode === "hang") {
  fs.writeFileSync(`${process.env.OPENCLAW_STATE_DIR}/pid`, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "garbage") {
  process.stdout.write("not json at all");
} else if (mode === "exit") {
  process.stderr.write("boom");
  process.exit(3);
} else {
  const messages = [{ role: "user", content: request }];
  const first = await post(`${provider.baseUrl}/chat/completions`, {
    model: "horizon-local", messages, tools, max_completion_tokens: 77, stream_options: { include_usage: true }
  });
  const call = first.body.choices[0].message.tool_calls?.[0];
  let toolText = null;
  if (call) {
    const result = await post(`${bridge.baseUrl}/tools/call`, {
      name: call.function.name.replace(/^horizon_/, ""), arguments: JSON.parse(call.function.arguments)
    });
    toolText = result.status === 200 ? result.body.result : null;
  }
  // Like a model that papers over a failed tool: always claims success.
  process.stdout.write(JSON.stringify({
    payloads: [{ text: `Finished. tool=${toolText} report=${JSON.stringify(report)}`, mediaUrl: null }],
    meta: { durationMs: 1, transport: "embedded" }
  }));
}
