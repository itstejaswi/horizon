# Acceptance and evidence

## Baseline evidence, not a universal guarantee

At commit `9112fbc`, the complete regression suite passed **163 tests**.
A real cached Phi-4 model also completed a dependent synthetic task:
read a source, create a copy using its returned content, then overwrite the
source using its returned SHA-256 reference.

That run used three inference calls (including one initial plan correction),
two separate exact-call approvals and five tool calls. Both writes passed
independent readback checks. The overall result was correctly labelled partial
verification: two checked writes out of three action steps, not proof that
every step had an outcome predicate.

Additional baseline coverage:

| Layer | Evidence and limits |
|---|---|
| Engine/tools | Automated permissions, approvals, budgets, cancellation, retries, outcome failures, concurrent changes and restart handling |
| HTTP integration | Actual Horizon server against a simulated model endpoint, including chat tools and planned writes |
| UI | Real Chromium with mocked backend responses: settings, plans, evidence, approval controls and reduced motion |
| Local inference | Actual Phi-4 file-only multi-step acceptance |
| OpenClaw | At the baseline: broker/seam unit coverage only. See the next section for later evidence |

Not proven by this evidence: a real-model full-browser-to-command journey,
all local models, every Windows architecture, long-running scheduling through
actual sleep/wake, or general autonomous reasoning reliability.

## OpenClaw evidence, 28 October 2026

Tested with OpenClaw `2026.6.34` (`5c38f99`), Node `v24.16.0`, Windows x64.
The regression suite passes **172 tests** (163 baseline + 9 adapter tests
driving a fake OpenClaw executable over the real broker protocol).

`npm run test:openclaw` passed against the **real installed runtime** with
**scripted model decisions** through Horizon's engine, broker, bridge plugin
and real file tools on synthetic files: an approved dependent read → write
(3 model calls, 2 tool calls, one exact-call approval, content checked, no
replay); a denied write (run failed, nothing written, no completion claim);
cancellation during inference (run cancelled, no further model calls); and no
per-run state or OpenClaw process left behind. Every model request offered
exactly the granted `horizon_*` tools. Separately, the real Horizon server
with a stub Foundry endpoint completed an OpenClaw chat from the UI; the
endpoint received the selected model ID and only granted tools.

### Real local models on a small laptop, 28–29 October 2026

Foundry Local 0.12.1 on an i3-1125G4 laptop with **7.7 GB RAM** and Intel UHD
integrated graphics. Same task each run: read `source.txt`, write an identical
`copy.txt`; the test approves only an exact match. **No run passed.** Every
wrong action was stopped at approval and nothing incorrect was written.

| Model | Backend | Result | Time per run | What happened |
|---|---|---|---|---|
| qwen2.5-3b GPU build | OpenClaw | crash | — | Foundry's daemon crashed on a ~2.5k-token prompt; the iGPU runs out of shared memory |
| qwen2.5-3b CPU build (3.0 GB) | OpenClaw | 0/3 | 5–8 min | Reached the write every time but asked to write `{{.}}`, `$(cat source.txt)`, or into an invented `approvedFolders\` folder |
| Phi-4-mini CPU build (4.8 GB) | OpenClaw | 0/3 | 13–30 min | Two runs timed out on the first decision; one replied without attempting the write |
| Phi-4-mini CPU build (4.8 GB) | native | — | — | Swapping froze the laptop; abandoned |

The plumbing held throughout: real model calls went through the broker to
Foundry, tool calls through Horizon's approvals, failures surfaced as failures.
What failed is capacity and small-model reasoning. Lessons applied in code:
Node's `fetch` waits at most five minutes for response headers, so agent
inference now uses a plain loopback request bounded by the run's own time
limit; OpenClaw's workspace and persona files are no longer injected (−18%
prompt); the model is told it may use paths relative to an approved folder.
OpenClaw's `localModelLean` mode must stay off: it replaces granted tools with
a generic `tool_call` wrapper, which the broker refuses.

On hardware like this, prefer the native engine. **The real-model OpenClaw gate
remains open** until it passes on a machine with enough memory for a capable
tool-calling model.

| Gate | Status |
|---|---|
| Fresh install without OpenClaw | Met: `npm install` does not fetch it; selector disabled with reason; native tests unchanged |
| Missing/incompatible runtime | Met: missing, version-mismatched and old-Node states reported; selection refused; runs fail explicitly |
| Local model routing | Met with stub endpoint: model ID forced by server, no provider fallbacks, provider keys not inherited |
| Chat and saved agents | Chat met (real runtime); saved-agent runs share the path but were not run against the real runtime |
| Dependent file task | Met with scripted decisions; **real models 0/6 on a 7.7 GB laptop** (see above) |
| Browser / fixed command / browser-to-script / MCP | **Not yet exercised** through OpenClaw |
| Denied action | Met (real runtime) |
| Concurrent file change | Relies on the unchanged native file tools; not separately exercised through OpenClaw |
| Tool failure after side effect | Run fails and warns that earlier calls may have taken effect; no retry (fake runtime) |
| Read/inference failure | Model failure fails the run (fake runtime) |
| Step/model/time/output limits | Tool steps enforced by engine; model calls capped at `maxSteps + 1`; stdout capped at 1 MB; time limit via run signal |
| Stop or permission change | Cancel met (real runtime); permission change uses the same abort path |
| Restart | Unchanged engine behaviour: interrupted, not replayed |
| Schedule | **Not yet exercised** through OpenClaw |
| Empty/forged tool access | Met: exclusive plugin and tool allowlists, and the broker rejects any ungranted tool offered to the model |
| Malformed runtime output | Met (fake runtime): non-JSON, empty payloads, error results and non-zero exits fail |
| Evidence/UI | Backend, model, tool and result events recorded; OpenClaw runs have no outcome checks |
| Cleanup | Met (real runtime): broker closed, process tree killed, state removed |
| Compatibility | Recorded above; ARM64, macOS and Linux untested |

## Reproduce the baseline

Use the project's declared dependencies and an approved environment:

```powershell
npm run build
npm run check
npm test
```

`npm run test:local-agent` is an explicit real-inference acceptance test.
First load a chosen already-cached compatible model using Foundry Local, then
set `HORIZON_AGENT_TEST_BASE_URL` to its actual loopback `/v1` endpoint and
`HORIZON_AGENT_TEST_MODEL` to the actual loaded model ID. See the project README
for PowerShell instructions.

The test does not download/load a model, change real Horizon permissions or use
personal files. It creates a synthetic temporary directory, validates the exact
two write requests before approving them, checks real outputs and persisted
state, then cleans up. It can take several minutes. Failure must remain visible;
do not replace inference with scripted output and call that a real-model pass.

## Required OpenClaw release gates

| Scenario | Required observable outcome |
|---|---|
| Fresh install without OpenClaw | Native setup and all native functionality work; no optional runtime downloaded implicitly |
| Missing/incompatible runtime | Clear unavailable/error state; no silent native or cloud fallback |
| Local model routing | Actual calls reach the selected Foundry Local model through the shared queue; no external inference |
| Chat and saved agents | Same explicit tool grants; conversation side effects still require approval |
| Dependent file task | Real result references reach subsequent actions; reads/copies/overwrites produce expected files and checked hashes |
| Browser task | Real model opens an authorised public HTTPS fixture, inspects text and performs a permitted interaction; isolated session only |
| Fixed PowerShell/script task | Model selects a configured command ID; executable and argv remain unchanged; controlled fixture output is verified |
| Browser-to-script task | Real model consumes actual browser results, chooses an authorised configured action and checks its observable output |
| MCP task | Discovery and a controlled tool call work; errors remain errors and grants are unchanged |
| Denied action | No actual tool execution, no replay and no completion claim implying the action occurred |
| Concurrent file change | Stale overwrite hash is rejected; another writer's content is preserved |
| Tool failure after side effect | Uncertain effects are reported; side effects are not blindly retried |
| Read/inference failure | Recovery is explicit and bounded; no unbounded retry or hidden success |
| Step/model/time/output limits | Each limit stops execution with a visible cause; no later action runs |
| Stop or permission change | Pending approval/inference/tool work aborts and owned subprocesses/browser sessions close |
| Restart | Incomplete runs become interrupted; no replay or automatic resume |
| Schedule | Actual interval firing, overlap prevention and missed-run handling; separately exercise real sleep/wake |
| Empty/forged tool access | No upstream built-in tool escape or automatic permission broadening |
| Malformed runtime output | Visible failure; no parsing guesses that convert errors into success |
| Evidence/UI | Actual model/tool events drive activity; terminal status and checked/unchecked outcomes agree with persisted state |
| Cleanup | Broker sockets, subprocesses and temporary state are released on every terminal path |
| Compatibility | Pin and record exact OpenClaw, Node, OS/architecture and model versions actually tested |

Use controlled public test fixtures and synthetic local files/scripts, not
personal sign-ins or production side effects. Unit tests with fake runtimes are
necessary but do not replace a real-runtime/local-model acceptance run.

## Definition of done

The integration is complete only when an authorised user can select the backend,
execute the supported scenarios, review or deny sensitive actions, cancel
reliably, and inspect truthful durable results, with no permission or privacy
regressions in native mode.

Record the release commit, exact tested versions, commands and remaining gaps.
Do not advertise OpenClaw as bundled, or as more than experimental, until the
real-model gates above are met.
Do not call an upstream feature supported until Horizon has wired and exercised
it under Horizon's lifecycle and tool boundaries.
