# Agreed subagent routing policy

Agreed 2026-10-24. Plan and Build remain the only visible primary agents, with
their model selected manually by the user. This policy routes delegated work only.

| Subagent | Responsibility / access | LOW | DEFAULT | HARD | EXCEPTIONAL |
|---|---|---|---|---|---|
| explore | Local code exploration; read-only | Gemini medium | Gemini high | DeepSeek max | Sol medium |
| research | External documentation and research; read-only | Gemini medium | Gemini high | DeepSeek max | Sol high |
| general | Implementation and refactoring; controlled writes, Build only | Gemini high | DeepSeek max | Sol high | Opus 5.5* |
| debugger | Root-cause investigation; read-only, approved diagnostics | Gemini high | DeepSeek max | Sol high | Opus 5.5* |
| reviewer | Correctness, security, concurrency and performance; read-only | Gemini high | DeepSeek max | Sol high | Opus 5.5* |
| architect | Design, algorithms, interfaces and tradeoffs; read-only | Gemini high | DeepSeek max | Sol high | Opus 5.5* |
| critic | Challenge assumptions and conclusions; read-only | Independent Gemini/DeepSeek | Different model family | Independent Sol high/DeepSeek max | Independent Opus 5.5* |

Gemini means `antigravity/antigravity-gemini-3.8-flash`.
DeepSeek means `opencode-go/deepseek-v4.1-flash#max`.
Sol means `openai/gpt-6.1-sol`, using only `medium` and `high` automatically.
Opus means `oneprovider/claude-opus-5-5`, **without a reasoning variant**.

* Opus requires explicit spending authorization and a hard budget. It is disabled
  initially. No exhaustion-triggered paid fallback is permitted. Sol high can
  handle exceptional tasks when suitable, with the fallback recorded explicitly.

Kimi `opencode-go/kimi-k3.1-pro` is authorization-only, outside routine escalation.
VNAI Pro is excluded from automatic routing. DeepSeek Pro, Sonnet 4.6, Opus 4.6,
and Sol xhigh/max are excluded. Unknown quota is not unlimited.

## Native steps and concurrency

Native OpenCode `steps` is the normal per-child turn budget. All visible agents
use `steps: 30`; hidden `<role>-extended` variants use `steps: 60`. The
coordinator may set `routing.steps` to 1–60. Values above 30 select the extended
variant; the native runner still performs its own graceful final-step summary.
The router keeps a 100-request runaway backstop, not a tier-based 10/20/30 cap.
A continuation keeps the child's step variant; use a new child to change it.

Concurrency caps are local burst admission limits, not provider-published
concurrency numbers. Locally measured clean levels and installed caps:

| Provider | Measured clean | Installed cap |
|---|---:|---:|
| Antigravity | 16 per account (one account; 8 on two others) | 8 per account |
| OpenCode Go / DeepSeek | 16 total | 8 total |
| OpenAI Codex / Sol | 6 total | 4 total |

The global cap is 16. Providers meter quota windows and may throttle bursts;
these values must be remeasured after material provider changes. The
`scripts/concurrency-probe.ts` tool runs only with temporary router `testMode`,
which disables concurrency admission but keeps quota, cooldown, identity,
context and paid/Kimi gates active. Test mode and test-only account pinning must
not be left enabled. Probe tasks are excluded from ordinary performance stats.

## Critic family preferences

| Original model family | Preferred critic |
|---|---|
| Gemini | DeepSeek |
| DeepSeek | Sol |
| Sol | DeepSeek |
| Kimi | Sol |
| Opus | Sol |

Independence is model-family independence, not merely a different provider or
reasoning variant. A critic must receive the original model provenance and enough
evidence to verify the result. If no independent eligible model is available,
report that limitation instead of silently claiming independent verification.

## Other invariants

- Complexity, importance and context requirements are separate inputs.
- Explicit user tier overrides are supported; authorization cannot be asserted
  merely by an LLM-supplied tool argument.
- Preserve a running child's model; escalate through a new child and handoff.
- No subagent recursion by default.
- Plan never dispatches the write-capable general agent.
- Title generation uses Gemini medium; compaction inherits the session model.
- Account, quota, context, capability and spending checks precede dispatch.
- Do not automatically replay tasks with possible partial writes after failures.
