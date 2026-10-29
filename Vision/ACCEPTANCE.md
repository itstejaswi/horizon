# Acceptance and evidence

## Current status: not yet validated

The current Foundry-removal/Ollama-only work is **source plumbing only**. No
dependency installation, build, tests, inference, or browser run was performed
for this update. The earlier acceptance record below is historical evidence
from a different runtime baseline and does not validate this checkout.

Validate the update only in an isolated approved environment. Record the
checkout revision, exact Node.js/Ollama/model/OS versions, commands, results and
remaining gaps. Do not claim runtime acceptance from source inspection alone.

## Runtime contract

| Area | Required behavior |
|---|---|
| Runtime | Node.js 20 or later; Ollama is the sole inference provider |
| Default model | `qwen3:1.7b` |
| Ownership | Horizon owns its LangGraph harness, run state, tool policy and approval lifecycle; Ollama supplies inference only |
| Human authority | The Human controls and reviews work through Horizon's web UI; model output never grants permission |
| Configuration | `provider=ollama`; shared timeouts, status cache and warm-up live under `config.inference.*`; Ollama settings are `config.ollama.{baseUrl,keepAlive,binary,autoStart}` |
| Environment | `HORIZON_MODEL_ID` selects a model and replaces `FOUNDRY_MODEL_ID`; `HORIZON_OLLAMA_URL` names Ollama's native loopback URL |
| API | Horizon's Ollama routes use `/api/ollama/*`; there are no `/api/foundry*` routes |
| Lifecycle | Setup/Start/Stop/Test/Optimize target Ollama. Stop unloads Horizon's selected model but does not stop the independently owned Ollama service |
| Voice | Foundry CLI dictation and microphone recording are removed, with no recording replacement. Independent local browser/Windows read-aloud remains |
| OpenClaw | Never install or execute an OpenClaw runtime. Only selected source patterns may inform Horizon-owned code |

## Isolated acceptance gates

Run these checks only in the isolated environment and use synthetic files,
controlled public fixtures and a disposable Ollama setup. Do not use personal
browser sign-ins, production side effects or private user files.

| Scenario | Required observable outcome |
|---|---|
| Prerequisites and setup | Node.js 20+ and Ollama are detected; setup prepares the configured model and reports errors without pretending setup succeeded |
| Default selection | Fresh configuration selects provider `ollama` and `qwen3:1.7b` |
| Model override | `HORIZON_MODEL_ID` and the supported launcher option select the requested installed model without shell interpolation |
| Endpoint override | `HORIZON_OLLAMA_URL` resolves only to the intended native loopback Ollama endpoint; non-loopback inference endpoints are rejected |
| Inference | Requests reach the selected Ollama model through Horizon's shared queue, using shared `inference.*` timeouts/cache/warm-up and no cloud or Foundry fallback |
| Routes and diagnostics | `/api/ollama/*` reports actual service/model state; retired `/api/foundry*` routes are absent |
| Agent and conversation tools | Horizon-owned LangGraph execution preserves exact grants, approvals, cancellation, run visibility, evidence and honest failure handling |
| Human-paced handoff | The follow-up run carries an 8,000-character-bounded original-intent/completed-result checkpoint; mutable browser state is freshly observed; cancelling before execution leaves the prior handoff resumable |
| Fixed workflows | Each completed step remains visible in the final run result, with a 24,000-character cap and explicit truncation |
| Native-only orchestration | Legacy external-backend settings normalize to native; no external orchestration callback or process is invoked |
| Setup/Start/Stop/Test/Optimize | Each script uses Ollama rather than Foundry; Stop unloads only Horizon's selected model and leaves Ollama running |
| No microphone recording | No Foundry CLI dictation path, microphone capture or replacement recording feature is exposed |
| Read aloud | Local browser/Windows voices remain independent of inference; no cloud speech fallback is used |
| Offline chat | With dependencies/model pre-provisioned and external tools disabled, local chat continues under approved isolation |
| Failures and limits | Unavailable service/model, malformed output, timeouts, budget exhaustion and cancellation are explicit; no silent provider fallback or unsupported completion claim |
| Persistence and restart | Interrupted runs do not replay uncertain effects; Ollama remains independently managed across Horizon shutdown |
| OpenClaw absence | No OpenClaw runtime is installed/executed or used as a backend; the provided archive is source-text reference only |

The runtime gates require both automated checks appropriate to the code and
actual local Ollama acceptance. A stubbed provider test alone cannot establish
real inference, model compatibility, browser behavior or offline operation.

## Historical baseline

Before the Ollama-only change, an earlier checkout recorded 163 passing
regression tests and one real local-model synthetic file task. Those results
belong to that earlier Foundry-based revision and are not evidence for the
current runtime. A previous real Qwen/Edge browser acceptance also failed its
exact-evidence selection check; do not describe that attempt as a pass or imply
general small-model reliability.

## Definition of done

Acceptance is complete only after the isolated environment has exercised the
runtime contract above and the results have been recorded with exact versions,
commands and remaining gaps. Until then, describe this work as source-plumbed,
not runtime-validated.
