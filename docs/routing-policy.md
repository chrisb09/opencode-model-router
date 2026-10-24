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
