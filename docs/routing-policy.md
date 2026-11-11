# Agreed subagent routing policy

Agreed 2026-10-24; revised 2026-11-09 (DeepSeek-low defaults, media and designer
agents, Gemini retirement). Plan and Build remain the only visible primary
agents, with their model selected manually by the user. This policy routes
delegated work only.

| Subagent | Responsibility / access | LOW | DEFAULT | HARD | EXCEPTIONAL |
|---|---|---|---|---|---|
| explore | Local code exploration; read-only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 high \| Go DeepSeek max] | DeepSeek 1017 max, GLM max | Sol medium, Kimi high |
| research | External documentation and research; read-only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 high \| Go DeepSeek max] | DeepSeek 1017 max, GLM max | Sol high, Kimi high |
| general | Implementation and refactoring; controlled writes, Build only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 max \| Go DeepSeek max] | Sol high, Kimi high | Opus 5.5*, Sol high, Kimi high |
| debugger | Root-cause investigation; read-only, approved diagnostics | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 max \| Go DeepSeek max] | Sol high, Kimi high | Opus 5.5*, Sol high, Kimi high |
| reviewer | Correctness, security, concurrency and performance; read-only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 max \| Go DeepSeek max] | Sol high, Kimi high | Opus 5.5*, Sol high, Kimi high |
| architect | Design, algorithms, interfaces and tradeoffs; read-only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 max \| Go DeepSeek max] | Sol high, Kimi high | Opus 5.5*, Sol high, Kimi high |
| designer | Visual design, UX, layout, typography and design-system consistency; read-only | [DeepSeek 1017 low \| Go DeepSeek low] | [DeepSeek 1017 max \| Go DeepSeek max] | Sol high, Kimi high | Opus 5.5*, Sol high, Kimi high |
| critic | Challenge assumptions and conclusions; read-only | GLM Flash high, [DeepSeek group] | [DeepSeek group], Sol medium, Kimi | Sol high, [DeepSeek group], Kimi | Opus 5.5*, Sol high, [DeepSeek group], Kimi |
| media | Analyze images, video and PDFs natively; read-only, approved media diagnostics | GLM Flash low | GLM Flash high | GLM Flash max | GLM Flash max |

DeepSeek 1017 means `mistral/deepseek-v4-1-flash-1017` (`low`/`high`/`max`).
Go DeepSeek means `opencode-go/deepseek-v4.1-flash` (`low`/`max`).
GLM Flash means `mistral/zai-glm-5-3-flash` (`low`/`high`/`max`).
GLM max means `mistral/zai-glm-5-3#max` (strong knowledge synthesis; used for
HARD exploration/research alternatives, not implementation).
Sol means `openai/gpt-6.1-sol`, using only `medium` and `high` automatically.
Kimi means `opencode-go/kimi-k3.1-pro#high`. Opus means
`oneprovider/claude-opus-5-5`, **without a reasoning variant**.

**Media input.** GLM Flash is the only routed model that accepts video and PDF
natively, so the `media` agent owns those inputs. Images are handled by the
normal text agents: Go DeepSeek accepts images, while Mistral DeepSeek 1017 is
text-only, so image tasks fall through the DeepSeek pace group to the Go member.
Kimi also accepts video but not PDF; it is not part of the media route.
The media agent may request approval to run read-only `ffprobe`/`ffmpeg`
diagnostics for local video, and must never modify source media.

**Designer.** The `designer` agent reviews visual hierarchy, spacing,
typography, color, accessibility, responsive behavior and design-system
consistency. It is read-only and returns prioritized findings and concrete
direction; implementation stays with `general`. Its EXCEPTIONAL tier is the only
designer route that uses paid Opus 5.5.

**Quota-pace groups.** A bracketed pair `[A | B]` shares one preference rank:
the member whose account is furthest ahead of its quota-window progression wins.
Pace is `available% / max((reset − now) / windowDuration, 0.1)`, the minimum
across an account's windows, capped so policy rank always dominates. Windows
without a published duration fall back to raw availability. Pace only decides
*preference* between healthy candidates; hard/soft reserve floors and estimated
request reservations remain absolute. This prefers quota that would otherwise
be forfeited at a monthly reset (e.g. Mistral at 95% with days left over Go at
45% of a fresh window) and reverses automatically as windows progress.
API-key providers (Mistral Code and OneProvider) carry **no soft reserve**; the
2pp hard floor and per-request estimates still apply. With valid model prices and
an account-specific allowance, Mistral per-request estimates are monetary:
uncached full-byte input plus capped output for the reservation, then measured
inclusive-input/cache/output usage after a valid completion. Price tiers and the
allowance are snapshotted per physical request. Missing metadata retains the
legacy fallback; unknown/failed/uncertain usage retains the full reservation.
OAuth subscription providers use a 5% soft floor, applied only to their longest
window (weekly or monthly); short 5h windows use the hard floor.

Gemini 3.8 Flash (`antigravity`) is retired from routing as of 2026-11-08; the
antigravity provider plumbing remains in place but dormant. GLM-5.3 max is the
operator's primary model, so critic independence excludes the GLM family after
GLM origins. Mistral Large 4 was evaluated and excluded (weakest AA profile of
the candidates). VNAI Pro remains excluded from automatic routing; DeepSeek Pro,
Sonnet 4.6, Opus 4.6 and Sol xhigh/max remain excluded. Unknown quota is not
unlimited.

* Opus is paid per-request and gated by `allowPaid` with `maxTaskUsd` /
  `totalBudgetUsd` ceilings. It is disabled in the default policy; the live
  installation enables it with explicit operator approval. No
  exhaustion-triggered paid fallback is permitted. Sol high can handle
  exceptional tasks when suitable, with the fallback recorded explicitly.

Kimi is gated by `allowKimi` in the same way (enabled in the live installation).

## Native steps and concurrency

Native OpenCode `steps` is the normal per-child turn budget. All visible agents
use `steps: 30`; hidden `<role>-extended` variants use `steps: 60`. The
coordinator may set `routing.steps` to 1–60. Values above 30 select the extended
variant; the native runner still performs its own graceful final-step summary.
The router keeps a 100-request runaway backstop, not a tier-based 10/20/30 cap.
A continuation keeps the child's step variant; use a new child to change it.

Concurrency caps are local burst admission limits, not provider-published
concurrency numbers. Installed caps:

| Provider | Installed cap |
|---|---:|
| Antigravity (dormant) | 4 per account |
| OpenCode Go / DeepSeek | 4 total |
| OpenAI Codex / Sol | 4 total |
| Mistral Code | 4 per account |
| OneProvider (paid) | 2 per account |

The global cap is 8. Concurrency-only denials wait up to 20 seconds and then
fail; other denial classes do not queue. A startup/5-minute maintenance loop
finishes and reconciles executions whose native child is idle, without clearing
quota debt. Providers meter quota windows and may throttle bursts;
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
| GLM | DeepSeek |
| Mistral | Sol |

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
- Title generation uses GLM Flash low; compaction inherits the session model.
- Account, quota, context, capability and spending checks precede dispatch.
- Do not automatically replay tasks with possible partial writes after failures.
- Custom AI SDK transports for native subscription providers (openai,
  opencode-go, mistral) are rejected before dispatch; native providers use the
  HTTP proxy boundary with verified credential fingerprints.
