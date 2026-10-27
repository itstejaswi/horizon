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
| OpenClaw | Broker/seam unit coverage only; no installed runtime, adapter or real integration |

Not proven by this evidence: a real-model full-browser-to-command journey,
all local models, every Windows architecture, long-running scheduling through
actual sleep/wake, or general autonomous reasoning reliability.

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
Do not advertise OpenClaw as bundled or connected while only the broker exists.
Do not call an upstream feature supported until Horizon has wired and exercised
it under Horizon's lifecycle and tool boundaries.
