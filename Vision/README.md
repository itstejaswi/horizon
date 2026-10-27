# Horizon: vision and contributor handoff

This folder is the public engineering handoff for people and agents building on
Horizon. Read it before implementing another orchestration backend. It records
the starting point, intended outcome, existing boundaries and remaining work;
it is not a claim that the proposed integration already works.

Baseline: commit [`9112fbc`](https://github.com/itstejaswi/horizon/commit/9112fbc950f6636e3c4d59a2fa9a9a7b5d40405f),
published 28 October 2026. Reconcile this document with current code before
working: dependency APIs and the implementation may have changed.

## Why Horizon exists

Horizon began as a local chat interface that manages Microsoft Foundry Local.
The next step is a lightweight personal assistant that can act: ordinary chat
with tools, repeatable workflows, reusable agents and scheduled tasks, without
a paid cloud inference service.

Horizon is an independent project. Foundry Local is its inference runtime;
using that runtime does not make Horizon a Microsoft product. Preserve Horizon's
own identity.

The guiding split is:

**Horizon presents and governs. Foundry Local thinks. An orchestration backend
coordinates actions. Approved tools execute them.**

Today the supported backend is Horizon's native engine. OpenClaw is a possible
additional backend, not a prerequisite for native features and not yet a
connected integration.

## Read next

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current and proposed plumbing, ownership and code map |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Concrete OpenClaw integration work and extension guidance |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Measurable outcomes, regression gates and known coverage gaps |
| [Project README](../README.md) | Installation, user controls, configuration and limitations |
| [Troubleshooting](../TROUBLESHOOTING.md) | Operational problems and recovery |

## What shipped at the baseline

- Conversation tools with inline approvals and cancellation.
- Saved agents, deterministic fixed workflows and persistent interval schedules.
- Scoped file tools, isolated public-HTTPS browser tools, fixed configured
  commands and a stdio MCP client.
- Experimental native task planning, saved step progress and deterministic
  outcome checks, including independent file-write readback.
- Local activity animations, dictation and optional verified-local browser
  speech synthesis. Read aloud is not a Foundry Local TTS integration.
- An authenticated per-run broker and backend injection seam intended for
  OpenClaw. Neither is connected to an actual OpenClaw process.

## Non-negotiable boundaries

1. Keep native execution usable independently of OpenClaw.
2. Keep inference local. Do not silently add cloud providers, billing, telemetry
   or third-party credentials.
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
configured report script, then verify its observable output. The same permission
and lifecycle rules must apply whether the native backend or a future OpenClaw
backend chooses the actions.

This is not a promise of unrestricted desktop control, arbitrary PowerShell,
personal signed-in browser access, reliable reasoning on every small model,
or unattended success without review.

## Maintaining this handoff

Update this folder when a backend contract, permission boundary or acceptance
claim changes. Record the relevant commit and distinguish implemented,
experimentally observed and proposed behaviour. Link to evidence rather than
turning a future plan into a feature claim.
