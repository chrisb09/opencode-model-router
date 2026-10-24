# OpenCode quota-aware subagent router

A local, deterministic router for OpenCode **2.1.4**. Keep using **Plan** and
**Build** and select their models normally. The existing `subagent` tool is
wrapped per invocation; agent definitions are **not** globally rewritten to
select concurrent models.

The agreed table is in [docs/routing-policy.md](docs/routing-policy.md).
Its machine-readable counterpart is [config/policy.json](config/policy.json).
Opus 5.5 has **no specified reasoning variant**.

## Installed components

- Seven focused subagent prompts and native V2 permissions: explore, research,
  general, debugger, reviewer, architect, critic.
- Four tiers, separate importance, context/output and modality checks.
- Critic family independence and original-session provenance.
- Shared local SQLite reservations, per-account concurrency limits, cooldowns,
  decision explanations and measured request performance.
- Live quota integration with the **existing** `ai_usage` service at
  `https://usage.christian-f-brinkmann.de`; no duplicate provider polling logic.
- Request-local Antigravity account pins, without global credential activation
  for pinned requests. API-key/header-pool fallback is disabled on pinned work.
- AI SDK request guards and a local guarded proxy for native HTTP requests.
- An authenticated local API and four **read-only** MCP tools (status,
  recommendation, workflow read/export, recent workflow listing).
- User systemd service; no additional Docker or remote database.
- Native todos enabled for progress tracking, including Plan's `todowrite` permission.
- Local task/workflow tracing, explicit outcome annotations, redacted JSON /
  Mermaid exports, and a static HTML/SVG lifeline timeline. No new remote telemetry
  export or conversation-content capture.

Plan cannot dispatch general, run arbitrary shell commands, mutate ordinary
project files or use mutating MCP/plugin tools. Explore is local-only; research
has web access. Debugger diagnostics and general's shell commands require
approval. Read-only agents cannot recurse. These are OpenCode tool permissions,
**not an OS sandbox**. Build itself retains its existing normal permissions.

## Start and inspect

The installed service starts with the user's session:

```sh
systemctl --user start opencode-model-router.service
systemctl --user status opencode-model-router.service
bun /home/christian/git/opencode-model-router/src/cli.ts status
journalctl --user -u opencode-model-router.service -n 30 --no-pager
opencode mcp list
```

The CLI status includes source/freshness, catalog limits, all independent quota
windows, locally reserved percentage points, execution/request states, measured
performance and recent decisions. Benchmark priors are **not** treated as actual
subscription charges or measured local throughput.

Generate a self-contained lifeline timeline for a recorded session:

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts workflow <sessionID> \
  --timeline --out ~/.local/share/opencode-model-router/exports/timeline.html
```

Open the resulting file locally. It is a static SVG/HTML snapshot with one lane
per agent/child, wall-clock spans, request marks, model colors, contribution
badges and a detail table. It makes no network requests. Add
`--include-local-text` only for a private local copy containing task labels.

The TUI's normal subagent calls are routed automatically. Optional metadata:

```json
{
  "agent": "reviewer",
  "description": "Review transaction handling",
  "prompt": "Review the attached changes and relevant tests without editing.",
  "routing": {
    "tier": "HARD",
    "importance": "high",
    "inputTokens": 30000,
    "outputTokens": 8000
  }
}
```

For a critic of a child, set `routing.originSessionID`. The plugin resolves that
session's actual model rather than trusting a fabricated origin-model argument.
For a critic of the primary session, omit it. Always provide enough evidence for
the critic to evaluate the work. High/critical importance instructs the
coordinator to obtain independent verification; it does not silently purchase a
stronger model or start an expensive review ensemble.

Each running child keeps its selected model. Escalation requires a **new child**
with a handoff. Failed implementation tasks are never automatically replayed
through another provider after possible partial writes. Foreground and background
completion use OpenCode's native child jobs and notifications.

### Delegation tendency

Plan and Build should **consider specialist subagents for every task**, not only
large tasks, unless the user specifies otherwise or the work is trivial. Routine
delegation within the requested task is explicitly authorized in the installed
`~/.config/opencode/AGENTS.md`, and the router's coordinator hook supplies matching
guidance. Consideration is not mandatory fan-out: launch a specialist when it adds
useful expertise, focused context, independent verification or parallel progress.
Keep trivial work direct, avoid duplicate investigations and overlapping writers,
and let the coordinator integrate the results.

Say "work solo for this session", "no subagents for this task", or "do this
directly" to override the default for that scope. The coordinator should flag
any resulting verification limitation, not quietly ignore the opt-out. These are
instruction-based preferences, not an enforced session-mode switch or a probability
setting. Quota checks, paid locks, primary models, permissions and no-recursion
rules do not change. More frequent consideration does not imply higher tiers.

The global instruction file is a separate user preference and is not removed
by the router disable helper. Edit/remove its delegation section separately if
you no longer want this preference; it does not authorize bypassing a router denial.

## Configuration

See [docs/workflow.md](docs/workflow.md) for in-chat workflow tools, contribution
assessments, CLI exports, local text controls, recording limits and deletion.

Private runtime configuration:

```text
~/.config/opencode-model-router/config.json
~/.config/opencode-model-router/policy.json
~/.config/opencode-model-router/service-token
~/.config/opencode-model-router/collector-authorization
~/.local/share/opencode-model-router/router.db
~/.config/systemd/user/opencode-model-router.service
```

The authorization file reuses the existing usage-service Basic authorization.
It is not a provider credential and is never exposed through MCP. The `ai-usage`
MCP header reads this protected file with OpenCode's `{file:...}` substitution,
so a service restart does not depend on inheriting `AI_USAGE_BASIC` in its
environment. Provider API keys and OAuth tokens remain with their existing
OpenCode integrations. The native proxy forwards provider authorization only in
memory to an allowlisted HTTPS provider host, strips local authorization headers
and refuses redirects.

`credentialBindings` records approved credential IDs and private HMAC identity
bindings. Provider IDs need not equal credential integration IDs: the installed
Go models use **`opencode` Console OAuth**, not the legacy `opencode-go` API key.
Its workspace was compared with the production quota collector and matched.
Native Codex requests must match the approved OAuth account; native Go requests
must match the approved Console workspace and a resolved token fingerprint.
Raw access tokens are never persisted by the router. Console token rotation keeps
at most three fingerprints with a five-minute overlap for that same workspace.

New credentials do not automatically inherit an old account's quota mapping.
After independently verifying identity/workspace against the collector, approve
the current mapping with:

```sh
bun /home/christian/git/opencode-model-router/scripts/bind-credentials.ts --approve-current
```

This backs up the router configuration and changes router mappings only. It does
not alter provider credentials or authorize spending. Restart the router service
and use OpenCode `/reload` after approval. Never approve a mismatched workspace
merely to make a denial disappear.

Policy configuration includes:

- Model aliases and ordered role/tier candidates/fallbacks.
- Output budgets and per-execution request limits.
- Maximum quota age, hard reserve and soft conservation floors.
- Estimated percentage-point usage and per-account concurrency.
- Critic family preferences.

Soft floors can be relaxed to the hard floor for critical work. A user tier
override does not override quota, context, independence or spending safeguards.
Unknown, stale, missing, exhausted or post-reset-unconfirmed windows block
dispatch. Credit expiry is not replenishment. All applicable windows are checked
separately; account allowances are never summed into an interchangeable pool.

After changing policy/settings, restart **the router service** and use OpenCode
`/reload` to refresh captured plugin configuration. You do not need to restart
the OpenCode service or change the primary model. Ordinary OpenCode configuration
edits reload automatically.

```sh
systemctl --user restart opencode-model-router.service
```

Do this while managed children are idle; active reservations are intentionally
durable across restarts. Model/credential metadata is refreshed every minute and
at dispatch; quota-source reads are deduplicated and cached for 30 seconds.
Stale/reset-crossing quotas request a collector refresh, respecting its cooldown.

## Paid models and accounting limitations

**Paid Opus and Kimi dispatch are locked in this release**, even if policy budget
booleans are changed. No live paid-model tests were authorized or executed.
The policy keeps their desired assignments for future work, but a boolean or an
LLM-supplied argument is not spending authorization.

Enabling them needs a trusted approval/grant mechanism, monetary reservations
against per-task/total ceilings, verified prices and enforcement before **every
physical billable attempt**, including SDK/provider retries. Benchmark task-cost
estimates and a task-level token estimate cannot supply that guarantee. VNAI is
not registered for automatic routing.

Subscription reservation quantities are explicitly **estimated percentage
points**, not exact provider token capacity. Go raw meter units are exposed when
available, but their conversion to task consumption is not assumed. Codex and
Antigravity do not expose sufficient absolute capacity for a mathematical token
reservation. Configure conservative headroom and concurrency for your workload.

The ledger prevents oversubscription among managed local tasks; it cannot stop
other machines, manually selected primaries, the Codex CLI or unrelated API
clients from using the same accounts. Primary models are never automatically
changed or routed. Native WebSocket calls from routed children are deliberately
blocked rather than allowed to bypass the HTTP guard.

Successful transport retains conservative debt until a newer authoritative quota
observation can reflect it; actual token counts remain **null** when unavailable.
Aborted/ambiguous requests retain uncertainty and may retain capacity indefinitely;
time passing alone is not proof that an upstream request stopped or was free.
Do not clear reservations merely to get past a denial. Automatic ambiguous
recovery is not implemented. An explicit operator recovery is available:

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts reconcile '<executionID>' --confirm-provider-idle
```

Only confirm after checking that no provider request remains active. The service
also verifies that the native child is idle and requires an authoritative quota
observation newer than termination. It releases the concurrency slot without
inventing token measurements, retaining estimated debt until a subsequent quota
observation. This command is not available through the read-only MCP tools.

Input bounds conservatively include serialized request bytes plus overhead, not
just the coordinator's estimate. This can reject some contexts that a tokenizer
would fit. Nothing silently truncates required input. Split the work or improve
the tokenizer integration instead. Native request decoding supports identity,
gzip, deflate and zstd with a bounded decompressed size. Unsupported encodings,
conflicting output-limit fields, changed model objects, and mixed custom AI SDK /
native subscription transports fail closed.

Measured reliability/throughput is currently diagnostic. Ranking uses the agreed
role/tier preferences, quota availability and critic independence; it does not
pretend short smoke tests are a reliable model-quality benchmark. Automatic task
difficulty assessment remains coordinator-supplied, with deterministic safeguards.

## Disable and rollback

```sh
bun /home/christian/git/opencode-model-router/scripts/disable.ts
```

This removes the router's plugin/MCP entries and unchanged agent definitions,
preserves subsequently edited settings and stops/disables the service. It keeps
credentials, historical state and private backups. It does not delete sessions.
Run it while delegated tasks are idle. The Antigravity adapter's pin support is
inert on ordinary requests without routing headers. Native todos are a separate
user preference and remain enabled. A dry-run against the live configuration and
regression tests cover removal; the live service was not disabled for testing.

To **pause** rather than remove routing, set `enabled: false` in the router's
private configuration, restart its service, and `/reload` OpenCode. Pausing denies
new delegations; it never exposes an unrestricted fallback executor. A plugin
initialization failure likewise retains a deny gate. Tool snapshots admitted
before a successful plugin reload stay executable, as required by OpenCode V2.

The private original configuration and installation manifest are under:

```text
~/.local/state/opencode-model-router/backups/
~/.local/share/opencode-model-router/installation-backup
```

Do not blindly copy the original backup over newer user changes. The disable
script performs a targeted removal instead.

## Development and verification

```sh
cd /home/christian/git/opencode-model-router
npm ci --ignore-scripts
npm run typecheck
bun test tests
npm audit --omit=dev
```

Runtime is **Bun 1.3.14+**, not the system Node version. Tests use in-memory
databases and mocked providers; they do not touch real queues, configuration or
authentication stores. OpenCode plugin/client dependencies are pinned to 2.1.4.

The installer is deliberately additive and refuses to overwrite an existing
router installation or custom agent definitions. It expects the current global
`.jsonc` file to contain JSON; it refuses to strip comments/trailing commas.

## Troubleshooting

- **No eligible model:** inspect recent decisions. Check all windows, freshness,
  context/output bounds, credential bindings, concurrency and cooldowns.
- **Unknown quota:** fix the collector or identity mapping; never substitute 100%.
- **Stale registry:** inspect plugin status and reload the location; the router
  does not reuse model metadata from another project.
- **Quota service authentication failure:** repair the private authorization file
  using the existing credential; do not generate provider API keys.
- **Router unavailable:** new delegations fail closed. Primary work remains
  untouched. Inspect the user-service journal and `opencode mcp list`.
- **Interrupted background child:** inspect native child status and the durable
  ledger before considering manual reconciliation. Never automatically rerun
  possible partial implementation work.
- **Native transport mismatch:** retain the failed child and diagnose the exact
  protocol/encoding. Do not bypass the guard via direct provider calls.

Provider parser fixes in the sibling `ai_usage` checkout preserve missing usage
as unknown. They are separate source changes and are not automatically deployed
to the remote usage service by this installer.

See [docs/validation.md](docs/validation.md) for verified behavior, final test
results, source locations and the version-control handoff.
