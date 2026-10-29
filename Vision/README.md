# Horizon: vision and contributor handoff

This folder is the public engineering handoff for people and agents building on
Horizon. It records the current runtime direction, ownership boundaries,
acceptance criteria and remaining work; it is not a claim that the Ollama
runtime has passed acceptance.

**Current status:** the Foundry-to-Ollama update is source-only plumbing and
has not been runtime-validated. No install, build, test, inference or browser
run was performed for this update. Validate it in an isolated approved
environment before relying on it.

Baseline: commit [`9112fbc`](https://github.com/itstejaswi/horizon/commit/9112fbc950f6636e3c4d59a2fa9a9a7b5d40405f),
published 28 October 2026. That is the earlier Foundry-based baseline, not
evidence for the current Ollama-only update. Reconcile this document with
current code before working: dependency APIs and implementation may have
changed.

## Why Horizon exists

Horizon is a local assistant that uses Ollama for inference and can act through
ordinary chat tools, repeatable workflows, reusable agents and scheduled tasks,
without a paid cloud inference service.

Horizon is an independent project. Ollama is its sole inference runtime;
preserve Horizon's own identity.

The guiding split is:

**Horizon presents, reasons and governs. Ollama supplies local inference.
Horizon's LangGraph harness coordinates actions. Approved tools execute them.
The Human at Horizon's web UI remains the authority.**

Ollama is the only supported inference provider. OpenClaw is not installed,
launched or used as a runtime dependency. Only selected source patterns inform
Horizon-owned orchestration; do not introduce an OpenClaw runtime.

## Read next

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current and proposed plumbing, ownership and code map |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Implementation notes and extension guidance |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Measurable outcomes, regression gates and known coverage gaps |
| [Project README](../README.md) | Installation, user controls, configuration and limitations |
| [Troubleshooting](../TROUBLESHOOTING.md) | Operational problems and recovery |

## Historical baseline features

The following describes the earlier revision; it is not acceptance evidence
for the current Ollama-only runtime.

- Conversation tools with inline approvals and cancellation.
- Saved agents, deterministic fixed workflows and persistent interval schedules.
- Scoped file tools, isolated public-HTTPS browser tools, fixed configured
  commands and a stdio MCP client.
- Experimental native task planning, saved step progress and deterministic
  outcome checks, including independent file-write readback.
- Local activity animations and optional verified-local browser speech
  synthesis. Microphone recording and dictation are not provided.
- An authenticated per-run broker and backend injection seam intended for
  OpenClaw. They are not connected to or executed by an OpenClaw process.

## Runtime contract for this update

- Node.js 20 or later; Ollama is the only supported inference provider.
- Default model: `qwen3:1.7b`; `config.provider` is `ollama`.
- Shared request/status timeouts, status caching and warm-up are configured
  under `config.inference.*`; Ollama settings are under
  `config.ollama.{baseUrl,keepAlive,binary,autoStart}`.
- `HORIZON_MODEL_ID` selects the model and replaces `FOUNDRY_MODEL_ID`.
  `HORIZON_OLLAMA_URL` points to Ollama's native loopback API.
- Ollama routes use `/api/ollama/*`; retired `/api/foundry*` routes are not part
  of the contract.
- Setup, Start, Stop, Test and Optimize scripts target Ollama. Stop unloads
  Horizon's selected model, but does not stop the independently owned Ollama
  service.
- Foundry CLI dictation and microphone recording are removed, with no
  recording replacement. Local browser/Windows read-aloud remains independent.
- OpenClaw is not installed or executed. Reuse source patterns only; Horizon
  owns the LangGraph harness, and the Human at its web UI is the authority.

This update is source-only and not runtime-validated. Acceptance must be
completed in an isolated approved environment; see [ACCEPTANCE.md](ACCEPTANCE.md).

## Non-negotiable boundaries

1. Keep the Horizon-owned execution harness usable independently of any
   external orchestration runtime.
2. Keep inference local through Ollama. Do not silently add cloud providers,
   billing, telemetry or third-party credentials.
3. Keep execution and tool flags off by default. Planning is experimental and
   separately opt-in.
4. An orchestrator does not grant itself permissions. Horizon remains the
   authority for tool access, exact-call approvals, budgets and cancellation.
5. Never confuse model confidence with an observed result. A successful tool
   call, a passed predicate and fulfillment of the user's entire intent are
   different claims.
6. Do not replay uncertain side effects. Interrupted work is not automatically
   resumed. Stop must reach subprocesses, browser sessions and pending inference.
7. Respect the environment's software and package policies. A separate folder,
   visible package metadata or a different assistant does not confer permission.
8. Never commit runtime state, user documents, personal paths, credentials,
   conversations or approval tokens.

## Intended outcome

A person should be able to describe an authorised task in ordinary chat or
save it as a reusable/scheduled agent, see what is happening, approve sensitive
actions, stop the work, and inspect evidence of what actually happened.

Example: read a public page, save an authorised local report, run an explicitly
configured report script, then verify its observable output. The same
permission and lifecycle rules apply throughout the Horizon-owned harness;
Ollama provides inference, never authority to act.

This is not a promise of unrestricted desktop control, arbitrary PowerShell,
personal signed-in browser access, reliable reasoning on every small model,
or unattended success without review.

## Maintaining this handoff

Update this folder when the runtime contract, permission boundary or acceptance
claim changes. Record the relevant commit and distinguish source-plumbed,
runtime-validated and proposed behaviour. Link to evidence rather than turning
a future plan into a feature claim.
