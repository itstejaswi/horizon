# Implementation roadmap

## Start here, next contributor

1. Read this folder, the project README and current source. Check the branch,
   dirty files and upstream changes before editing.
2. Run the existing build, checks and regression suite. Preserve user changes.
3. Keep all orchestration and lifecycle inside Horizon's Node.js service;
   Ollama supplies local inference only.
4. Confirm the runtime and dependencies are permitted in the target environment.
   Do not use another registry, archive, assistant or folder to evade a block.
5. Meet [ACCEPTANCE.md](ACCEPTANCE.md) before claiming runtime continuity.

## Historical external-runtime proposal — excluded

The former integration notes below are retained only as historical context;
they are not implementation instructions. Horizon does not install, execute,
depend on, or route work through OpenClaw or another external orchestrator.
The supplied archive is source-text reference only. Legacy external-backend
settings normalize to the Horizon Native runtime.

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

Suggested new files are `src/openclaw-runtime.js` and a dedicated bridge-plugin
directory under `tools`. These names are proposals; they do not currently exist.

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

`createAgentService()` in `src/server.js` currently passes `tools` and `complete`,
but no `orchestrate`. Inject the adapter there after it is implemented.

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

## Keep the execution authority in Horizon

There is no external orchestration callback seam. The Horizon-owned native
runtime validates model decisions, enforces grants and approvals, records
events, and handles cancellation and cleanup. Do not introduce a second
execution authority.

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
