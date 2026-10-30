# Troubleshooting

Start here. Run the health check to inspect Horizon, Ollama and model availability.
This checkout's Ollama-only changes are source-only and have not yet been
runtime-validated; perform acceptance in an isolated approved environment.

```powershell
.\scripts\Test-Horizon.ps1
```

## "Windows protected your PC" when starting

Windows tags files that came from the internet and warns before running them. It is not saying anything is wrong with Horizon.

The cleanest fix is to clone the repository rather than download a ZIP, because cloned files carry no tag:

```powershell
git clone <repository-url>
```

If you already have a ZIP, clear the tag once after extracting:

```powershell
cd path\to\horizon
Get-ChildItem -Recurse | Unblock-File
```

You can also click **More info** then **Run anyway** on the warning itself, but unblocking is tidier because it stops the prompt recurring.

## "Script execution is disabled on this system"

Windows blocks unsigned scripts by default. Allow them for the current window only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

This lasts until you close the window. Do not make a permanent change unless your organisation permits it.

## Ollama is not installed or the `ollama` command is not recognized

Install Ollama from [ollama.com/download](https://ollama.com/download), then
close and reopen PowerShell so Windows refreshes `PATH`. Verify:

```powershell
ollama --version
```

## "'node' was not found"

Install Node.js 20 or later from an approved source, then reopen PowerShell. Verify:

```powershell
node --version
```

## The port keeps changing

That is intentional, and nothing is broken.

Ollama normally listens on `http://127.0.0.1:11434`; Horizon's web server uses
its own configured port and may choose a free port when configured to do so.

Always use the address printed by `Start-Horizon.ps1`. To keep it constant, set a fixed port in `config.json`:

```json
"web": { "port": 3000 }
```

## "Port N is in use and no free port was found"

Something else is occupying your pinned port. Either let the system choose one for you by setting `"port": 0` in `config.json`, or pick a different one for a single run:

```powershell
.\scripts\Start-Horizon.ps1 -WebPort 3100
```

To see what is holding the port:

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
```

## Ollama is unavailable

Check that Ollama is installed and responding at its configured loopback URL.
The default is `http://127.0.0.1:11434`; `HORIZON_OLLAMA_URL` overrides it.
If the service is not running, start it from the Ollama application or run the
Horizon launcher when `ollama.autoStart` is enabled. Check:

```powershell
ollama --version
ollama list
```

Do not point Horizon at a non-loopback inference service.

## "No model matches the selected ID"

The configured model may not have been pulled yet. The default is
`qwen3:1.7b`; list installed models and pull the selected one:

```powershell
ollama list
ollama pull qwen3:1.7b
```

Set `model.alias` in `config.local.json` to select another model, or use
`HORIZON_MODEL_ID` for a per-process override. This replaces the retired
`FOUNDRY_MODEL_ID` setting.

## The page says "Model not ready"

The web server may be healthy while Ollama or the selected model is not. Check
the exact error under the input box and compare `ollama list` with
`model.alias`/`HORIZON_MODEL_ID`. The page rechecks service health automatically.

## The page says "Local server unavailable"

The Node.js server has stopped. Look at the PowerShell window that started it — if it has closed or shows an error, run `Start-Horizon.ps1` again.

## Conversation tools and read aloud

### Normal prompts are not using tools

Check **Agents → Settings**: execution, a feature flag, and **Let ordinary chat prompts use tools** must all be on, and at least one conversation tool must be allowed. The composer should show **Tools available**. Grant actual folders and configure fixed command/MCP IDs before asking the model to use them; it cannot invent executable configurations. No saved agent is required.

If a model cannot follow the structured action protocol, choose another model or the native protocol for a model that supports function calls. Errors are explicit. Side effects wait for approval inside the conversation; read-only file access uses your scoped grant. **Stop** cancels the run. Reloaded chats retain replies, while detailed execution history remains in **Agents → Activity**. Long histories/attachments may exceed the conversation limit; shorten them or start a new chat.

### Planned runs are slow, rejected or only partially verified

**Agents → Settings → Plan and verify native tasks** adds local inference before native-engine model-driven agents or conversations execute. It is off by default; turn it off to retain the lightweight loop. Fixed workflows are unaffected. A malformed initial plan can be repaired once before tools run; an invalid plan is rejected before execution. Planning does not grant tools or replace approval.

Planning is **experimental and model-dependent**. Some cached small models misformat valid tasks, supply invalid write arguments, put check parameters into tool arguments, or ask unnecessary clarification. The engine stops and reports problems rather than relaxing checks. Review the error or clarification, try a more capable compatible model, or use a fixed workflow with known tool arguments for predictable execution. A successful run with one model does not guarantee reliability across models or tasks.

Planned mode always uses JSON regardless of the agent's protocol. A single enclosing JSON code fence wrapping the whole response is accepted and recorded as a `format` event; full validation still applies. Prose around fences and malformed data remain rejected. Plans are straight-line sequences with known arguments, optionally using prior structured-result references such as `{"$result":{"step":0,"pointer":"/sha256"}}`; a check may also reference its own action's result. It does not adaptively branch, replan after execution begins, or retry inference. Every actual call, including checks, write readbacks and retries, uses the `maxSteps` budget. Increase that limit if required checks/readbacks do not fit; a transient read-only retry is allowed only with spare capacity after reserving all remaining planned calls.

For planned writes, allow both `file_write` and `file_read` for the target under an approved root. The engine requires permitted readback for SHA-256 verification, so a write plan without that access is rejected before any step executes. Optional checks must use permitted `file_read`, `file_list` or `file_search` calls and valid JSON-pointer `equals`/`contains` predicates on fresh read results.

Inspect the saved plan and evidence in the run card or inline tool activity. A successful tool without a configured outcome check is **not** a verified outcome. Passed checks cover only their predicates or write readback, not the entire user request; partial verification does not mean every step passed a check. Always inspect the run status and individual failures. Only explicitly transient read-only failures may retry once. Side effects are not replayed and interrupted runs do not auto-resume; inspect existing effects before manually starting another run.

### OpenClaw is unavailable

OpenClaw is not installed, launched, or used as a runtime dependency. Horizon
owns its LangGraph harness and uses Ollama for local inference; only selected
source patterns informed its design.

### Read aloud is unavailable or silent

Use the reply's **Read aloud** button or **Settings → Behaviour → Read aloud**. Only voices explicitly marked local by the browser are eligible. Install a Windows speech voice and use a browser that exposes it; a cloud-only voice is deliberately not a fallback. Automatic reading is opt-in. Hiding the tab, starting a new prompt, or closing the page stops playback.

Read aloud uses independent Windows/browser speech synthesis. It does not record
microphone audio. Playback/storage failures are shown in the page; browser data
erasure resets the voice preference and automatic-reading switch.

## Agents cannot load or save

The Agents panel requires a server that implements the `/api/agents` endpoints. If the panel reports a not-found or unavailable error, update to a build with the Agents backend rather than editing `public/index.html`; it is generated from `tools/index.template.html`.

The API uses a per-session token and checks the request origin. Use the Horizon page opened by its launcher, and reload the page if a save or approval reports an invalid or expired token. The panel displays server errors as returned; if an action's outcome is uncertain, refresh the panel and inspect recent runs before trying it again.

## An agent is waiting for approval or has stopped

Runs that need a tool decision appear as **awaiting approval** with the exact tool arguments for review. Approve only when the action is understood; otherwise deny it. Use **Cancel run** to stop one run or **Stop all** to cancel every run and disable agent execution.

Scheduled runs require both the server and computer to remain awake. A missed interval (including a run more than 30 seconds late after wake) or overlapping occurrence is marked **skipped** and is not replayed; an interrupted run is not resumed after restart. Re-enabling execution resets future schedule times. A scheduled agent needs a default prompt or fixed workflow steps. A browser tool uses a fresh isolated session and public HTTPS only; it does not inherit personal browser sign-ins. The browser dependency is installed during one-time Horizon setup, not from the Agents panel. MCP servers are separate executables you must install and maintain.

Fixed workflow steps are JSON entries with a `tool` and `args`, for example:

```json
[
  { "tool": "file_list", "args": { "path": "C:\\Users\\you\\Documents" } },
  { "tool": "file_read", "args": { "path": "C:\\Users\\you\\Documents\\notes.txt" } }
]
```

File paths must be absolute and under an approved root. The tool must also be in the agent's allowed-tools list. The workflow can have at most 32 steps, and its length cannot exceed the agent's maximum-step setting. The editor's example disclosure lists argument shapes for other tools.

For `command_run`, pass `{"commandId":"configured-command-id"}`; for `mcp_list_tools`, pass `{"serverId":"configured-server-id"}`; for `mcp_call_tool`, pass `{"serverId":"configured-server-id","toolName":"tool-name","arguments":{}}`. These are `args` objects, not executable configuration. Configure the executable, fixed arguments and absolute `cwd` in Agents settings. Command and MCP working directories must exist under an approved root, but this check does not sandbox their effects or make an executable safe.

## Agent data and offline use

Agent definitions, settings, permissions, prompts, tool results and run history are stored by the local server in its runtime data file (currently `.runtime/agent-data.json`). Treat it as sensitive and do not commit or share it. Browser data erasure does not remove server-side agent history.

The server retains up to 100 runs / 16 MB and up to 150 events per run; tool results are limited to 12,000 characters. Older terminal runs are evicted as needed. Agent context is limited to 64,000 serialized JSON characters, not tokens; the model's own token context limit also applies. Long prompts or tool outputs may not fit.

To erase server-side agent data, use **Agents → Settings → Erase agent data** and confirm. This cancels work, disables execution, resets permissions/settings, and permanently removes saved definitions and run history. It does not undo files already created or external effects. This is separate from the browser-only **Erase all data** control.

Agent tool runs still use local model inference, but browser, command or MCP tools may use the network; enabling them is not an air-gap guarantee. Connection/privacy status distinguishes inference from network-capable tools and reports whether external tools are enabled or used. Persisted run history is not a network audit log and cannot record every request made by a command or MCP subprocess. For offline use, turn off link reading, cancel runs and use **Stop all** to disable agent execution. Configured commands and MCP servers can have effects beyond the approved file roots.

## A reply times out

Large models can be slow on first use, as weights load into memory. If replies consistently exceed the limit, raise the shared inference timeout in `config.local.json`:

```json
"inference": { "requestTimeoutMs": 240000 }
```

Or try a smaller model:

```powershell
.\scripts\Start-Horizon.ps1 -ModelAlias qwen2.5:0.5b
```

## "Your message is too large"

You have exceeded the request size limit. Click **Clear chat** to start fresh, or raise `chat.maxRequestBytes` in `config.json`.

## The model forgets earlier parts of the conversation

By design. Only the most recent `chat.historyLimit` messages are sent, to keep replies fast. When older messages are dropped, the note under the input box says so. Raise the limit in `config.json` if you need longer memory — at the cost of speed.

## Replies are slow

First, measure rather than guess:

```powershell
.\scripts\Optimize-Horizon.ps1 -IncludeCandidates -Apply
```

This benchmarks every downloaded model on your actual hardware and switches to the fastest sensible one.

Things worth knowing:

- **Model size dominates.** A 1.5B model is several times faster than a 14B one.
- **Reasoning-style models may spend extra time generating working** before an answer. Actual behavior depends on the selected Ollama model and has not been measured for this source-only update.
- **Under ~10 tokens/second, replies appear slower than reading pace.** That is your hardware, not a bug. Streaming means you can start reading almost immediately regardless.
- Actual performance depends on Ollama's available model/backend and the machine; this source-only update has no runtime benchmark evidence.

## The first message is slow, later ones are fine

Normal. The first completion after a model loads pays a one-off cost. The app sends a warm-up request at startup to absorb it; if you message before that finishes, you will still feel it. To turn it off:

Set `inference.warmUpOnStart` to `false` in `config.local.json` to disable the
startup warm-up.

## Long conversations get slower

Every message re-sends the conversation so far for reprocessing. Click **Clear** to start fresh, or lower `chat.historyLimit` in `config.json`. The app warns you when older messages are being dropped.

## A reply stopped halfway

If the note says *cut off at the length limit*, the model reached its output cap. Ask it to be more concise, or ask for the remainder.

If you pressed stop or `Esc`, that is expected — whatever had been written is kept.

## Ollama responds but Horizon cannot reach it

Horizon uses the Ollama native API at `http://127.0.0.1:11434` by default, not
the OpenAI-compatible `/v1` route. Check `ollama.baseUrl` and
`HORIZON_OLLAMA_URL`; use a loopback URL and restart Horizon after changing
configuration. The chat page is the address printed by `Start-Horizon.ps1`.

## The chat page looks unstyled

`app.css` or `app.js` failed to load. Confirm all three files exist in `public/`:

```powershell
Get-ChildItem .\public
```

You should see `index.html`, `app.css`, and `app.js`. Then refresh with `Ctrl+F5`.

## Stop-Horizon says nothing was running

The state file `.runtime/horizon.json` is missing, so the script does not know
which Horizon process or model it owns. If a server window is still open, press
`Ctrl+C` in it. Inspect loaded models with `ollama ps`; only unload a model
manually if you have confirmed it belongs to Horizon and no other Ollama client
needs it:

```powershell
ollama ps
ollama stop <model>
```

This unloads the named model but does not stop Ollama, which Horizon leaves
running.

## Checking offline behavior

Offline behavior is not validated for this source-only update. In an isolated
approved environment, prepare dependencies and the model while connected,
disconnect or apply approved isolation, then start Horizon and verify a local
prompt. Confirm the configured Ollama URL and Horizon web address are loopback.

## Useful commands

```powershell
node --version                 # Node.js must be 20 or later
ollama --version               # Ollama CLI is installed
ollama list                    # models available locally
ollama ps                      # models currently loaded
ollama pull qwen3:1.7b         # prepare the default model
```
