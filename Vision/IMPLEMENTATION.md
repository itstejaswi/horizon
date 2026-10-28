# Implementation roadmap

## Start here, next contributor

1. Read this folder, the project README and current source. Check the branch,
   dirty files and upstream changes before editing.
2. Run the existing build, checks and regression suite. Preserve user changes.
3. Decide whether the work improves the supported native engine or implements
   the optional OpenClaw backend; do not blur their release status.
4. Confirm the runtime and dependencies are permitted in the target environment.
   Do not use another registry, archive, assistant or folder to evade a block.
5. Implement against a specific verified upstream version, then meet
   [ACCEPTANCE.md](ACCEPTANCE.md) before exposing the backend.

## OpenClaw: status

| Step | Status |
|---|---|
| 1. Runtime contract | Done for `openclaw@2026.6.34` (MIT, Node `>=22.19.0`). CLI flags, `openclaw.json` schema (`openclaw config validate`), plugin loading (`openclaw plugins inspect --runtime`), `--json` output shape and `--local` abort behaviour were checked against the installed release, on Windows x64 with Node 24.16. ARM64, macOS and Linux are untested. |
| 2. Adapter and bridge | Done: `src/openclaw-runtime.js`, `tools/openclaw-bridge/`. |
| 3. Server wiring | Done: `createAgentService()` injects `orchestrate` and `openclawStatus`. |
| 4. Outcome verification | **Open.** OpenClaw runs have no outcome checks; the run shows tool execution events only. Native planning still applies only to the native engine. |
| 5. Backend selector | Exposed as experimental, disabled with a reason while the runtime is missing or mismatched. Real-model acceptance is still outstanding; see [ACCEPTANCE.md](ACCEPTANCE.md). |

Things found while wiring it, worth knowing before changing it:

- `tools.profile: "minimal"` filters plugin tools out even when `tools.allow`
  names them, and OpenClaw then refuses to start the turn. Use the exclusive
  `tools.allow` list without a profile.
- OpenClaw sends `max_completion_tokens`, `stream_options` and streams by
  default; the broker serves SSE and the adapter maps parameters for Foundry.
- OpenClaw's system prompt alone is about 8,000 characters; small local models
  with short context windows will struggle.
- PowerShell cannot browse the installed package because of Windows path-length
  limits under deep `node_modules`; Node itself is unaffected.

The original plan follows for reference.

### 1. Establish a version-correct runtime contract

The isolated manifest currently pins `openclaw@2026.6.34` and declares Node
`>=22.19.0`. This is a historical candidate, not an endorsement, an installed
runtime or proof of compatibility.

Verify the chosen release's licence, Node/platform requirements, CLI commands,
configuration, plugin API, local provider support, output schema and shutdown
behaviour against that exact release. Do not copy contracts from a newer release
or assume Windows ARM64 support from metadata.

Keep OpenClaw provisioning separate from normal Horizon setup until the
integration is complete and permitted. Native installation must not depend
on the optional runtime.

### 2. Implement an adapter and bridge plugin

Implemented as `src/openclaw-runtime.js` and `tools/openclaw-bridge/`.

The adapter should:

- Create per-run state/configuration and a broker with only the run's effective
  tool definitions. Reuse shared context formatting.
- Route inference through the server's existing selected-model callback and
  serial queue; never let upstream choose a cloud model or external endpoint.
- Register only bridge tools that call the authenticated broker. Disable all
  unrelated upstream tools, plugins, shell, browser, channels and background
  jobs. An empty upstream allowlist must not be assumed to mean deny-all.
- Start the permitted local runtime without shell-interpolated commands, using
  isolated configuration/state instead of a user's normal OpenClaw profile.
- Translate results and final output using the pinned release's real schema.
  Bound stdout/stderr, model calls, tool calls, output and total runtime.
- Propagate model/tool events and explicit failures back to Horizon.
- Close the broker and terminate the owned process tree on completion, errors,
  abort, timeout and server shutdown. Remove only owned temporary state.

Never log or persist the ephemeral broker credential. Pass it only through a
version-appropriate private local configuration mechanism. Loopback authentication
does not make the subprocess an OS sandbox.

### 3. Wire the server without a second execution authority

`createAgentService()` in `src/server.js` now injects the adapter as
`orchestrate`.

Do not duplicate the engine's approval handling or invoke tool executables
directly from the plugin. Every actual action must use the supplied `invoke`.
Conversation actions must never inherit saved-agent unattended permissions.

On missing runtime, invalid configuration, a denied tool, invalid output or a
failed broker request, report an explicit failure. Do not silently switch to
native and make it appear OpenClaw succeeded.

Keep fixed workflows deterministic. Keep ordinary chat and saved/scheduled
agents on the same permission and lifecycle foundations.

### 4. Decide outcome verification explicitly

Native planned-mode verification is implemented in `src/agent-planner.js`;
it does not automatically apply to OpenClaw. A final message from OpenClaw is
not independent evidence.

Specify how the adapter's actions expose observable completion criteria. Reuse
or extract check machinery where appropriate, without bypassing grants or
creating automatic replay. Display successful execution separately from passed
outcome checks. Browser/command/MCP success does not prove a business outcome.

### 5. Expose a backend only after acceptance

Add a validated, explicit backend selector only when the runtime is provisioned
and the tests pass. Show missing/incompatible runtime state rather than a
nonfunctional choice. Preserve the supported native default.

Document installation, cleanup, supported versions/platforms, local inference,
network-capable tools, storage, permissions and known limitations. Keep feature
claims consistent across the README, landing page, settings and this folder.

## Building around Horizon instead

Another orchestration backend can implement the existing callback seam, but
its semantics must be documented and tested rather than pretending to be
OpenClaw. Generalising backend validation is an intentional code change;
the current settings accept only `native` and `openclaw`.

New tools require schema validation, feature gating, explicit grants, correct
approval treatment, cancellation, bounded results and tests. Do not register a
generic unrestricted shell under the existing fixed-command label.

## Native improvements not yet promised

Potential follow-on work includes adaptive replanning, parameterised reusable
skills, richer context selection and additional deterministic output checks.
None is implemented merely by changing a prompt or integrating OpenClaw.
Define measurable behaviour, permission implications and failure handling first.

The browser is not a signed-in personal desktop browser; arbitrary PowerShell
and unattended access to private services are not baseline capabilities.
