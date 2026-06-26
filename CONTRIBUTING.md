# Contributing to hermes-control-plane

This file documents the conventions a human (or autonomous agent) needs to
follow when changing this repository. The CI lint job
(`.github/workflows/lint.yml`) is the authoritative gate; this document
exists so reviewers and agents can predict what the gate will reject
without having to re-read the full lint config.

For the high-level project layout and operational instructions, see
[`README.md`](README.md) and the runbook in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Local commands

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (lockfile pinned, `--frozen-lockfile` in CI). |
| `bun run dev` | `wrangler dev` — boot the Worker locally on port 8787. |
| `bun run launcher` | Boot the launcher sidecar on port 8789 (reads `.dev.vars`). |
| `bun run test` | Run the full vitest suite (17 files / 214 tests). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run lint` | Oxlint with the rules below. CI gate. |
| `bun run lint:fix` | Oxlint with `--fix` (safe autofixes). |
| `bun run format` | Biome formatter, write mode. |
| `bun run format:check` | Biome formatter, check mode. CI gate. |
| `bun run deadcode` | Knip dead-code / unused-export / unused-dep check. CI gate. |
| `bun run dupes` | jscpd duplicate-code check (threshold 4%). CI gate. |

A `husky` pre-commit hook runs `lint-staged` (Biome format + Oxlint
--fix on changed files only). The hook is installed automatically by
`bun install` via the `prepare` script. Bypass with
`git commit --no-verify` if you really have to; CI will still catch the
issue.

---

## Naming conventions

Oxlint does not yet port `@typescript-eslint/naming-convention`, so these
conventions are enforced socially via review and via reference to this
document. They are followed consistently across `src/`, `tests/`,
`scripts/`, and `infra/`.

### TypeScript identifiers

| Construct | Convention | Examples |
|---|---|---|
| Variables, parameters, properties | `camelCase` | `sessionId`, `prKey`, `headSha` |
| Functions, methods | `camelCase` | `handleAmendTrigger()`, `buildStartConfig()` |
| Boolean flags | `camelCase` with predicate prefix | `isTerminal`, `hasAdmin`, `shouldRetry`, `amendMode` |
| Module-level constants holding literals | `UPPER_SNAKE_CASE` | `HEARTBEAT_INTERVAL_MS`, `REPO_DIR`, `CORS_HEADERS` |
| Classes, types, interfaces, enums | `PascalCase` | `SessionDurableObject`, `ProjectProfile`, `RunnerCommand` |
| Type parameters (generics) | `PascalCase`, single-letter or descriptive | `T`, `Req`, `Resp` |
| Enum members | `PascalCase` (we rarely use enums; prefer string unions) | `PrStatus = "open" \| "merged" \| "closed"` |
| React-style hooks (n/a here) | not used | — |
| Unused-but-required identifiers | leading underscore | `_allowedTools`, `_unusedArg` |

### File and directory names

| Construct | Convention | Examples |
|---|---|---|
| TypeScript source files | `kebab-case.ts` | `state-machine.ts`, `github-webhook.ts`, `pr-index-do.ts` |
| Test files | `<unit-name>.test.ts` mirroring the file under test | `state-machine.test.ts`, `github-webhook.test.ts` |
| Folders | `kebab-case` or single-word | `src/worker/`, `src/core/`, `tests/_shims/` |
| Top-level config files | dot-prefixed where appropriate | `.oxlintrc.json`, `biome.json`, `knip.json` |

### Event / state-machine string literals

| Construct | Convention | Examples |
|---|---|---|
| Hermes event types | `dot.separated.lowercase` | `session.created`, `agent.message.delta`, `pr.created`, `runner.ready_to_publish` |
| State machine states | `snake_case` | `provisioning`, `runner_connecting`, `review_ready`, `creating_pr` |
| WebSocket framing types | `lowercase` | `event`, `command`, `replay`, `heartbeat` |

### Environment variables

| Construct | Convention | Examples |
|---|---|---|
| Operator-facing env vars | `UPPER_SNAKE_CASE`, no `HERMES_` prefix on tokens or shared secrets | `E2B_API_KEY`, `GITHUB_WRITE_TOKEN`, `LAUNCHER_SHARED_SECRET` |
| Sandbox-internal env vars set by the launcher | `CONTROL_PLANE_*` prefix | `CONTROL_PLANE_SESSION_ID`, `CONTROL_PLANE_PR_MODE_BRANCH` |
| GitHub-derived identity envs | `GITHUB_*` | `GITHUB_USER_LOGIN`, `GITHUB_USER_EMAIL`, `GITHUB_OWNER`, `GITHUB_REPO` |

### Branch and PR names

| Construct | Convention | Examples |
|---|---|---|
| Agent-authored branches | `hermes/<sessionId-suffix>` or `hermes/<task-slug>-<id4>` | `hermes/34aab1e6`, `hermes/add-rate-limit-1234` |
| Human-authored branches | `<category>/<short-description>` | `chore/oxlint-biome`, `fix/install-sh-no-overwrite-env` |
| Commit subject | Conventional Commits style | `chore(lint): add oxlint + biome formatter, wire into CI` |

---

## Module size and complexity budgets

Enforced by oxlint and surfaced in CI:

| Rule | Budget | What it catches |
|---|---|---|
| `complexity` | 25 | Deeply nested or sprawling logic; tells you a function should split. |
| `max-lines` (file) | 1500 | Modules ballooning past the point of reviewability. |
| `max-lines-per-function` (function) | 250 | God-functions. |
| `no-warning-comments` | TODO:/FIXME:/HACK: terms | Un-ticketed tech debt that should at least be tagged. |
| `unicorn/prefer-set-has` | n/a | Linear-scan lookups (`Array.includes`) that should be O(1) `Set.has`. |

Tests files are exempt from `max-lines*` and `complexity` (see
`.oxlintrc.json overrides`); some integration tests are intentionally
fat fixtures.

---

## Code quality philosophy

- **Don't add features beyond what the change requires.** A bug fix
  doesn't need surrounding code cleaned up. A simple feature doesn't need
  extra configurability.
- **Don't add error handling, fallbacks, or validation for scenarios that
  can't happen.** Trust internal code and framework guarantees. Validate
  only at system boundaries (user input, external APIs).
- **Don't create helpers, utilities, or abstractions for one-time
  operations.** Three similar lines is better than a premature
  abstraction.
- **Don't add backwards-compatibility hacks.** If something is unused,
  delete it.
- **Only comment what isn't self-evident.** Don't add docstrings, type
  annotations, or block comments to code you didn't change.

These rules apply equally to humans and agents.

---

## Dependency policy

Renovate (`renovate.json`) is the source of truth for dependency upgrades.
Key rules a reviewer or agent should know about:

| Rule | Value | Why |
|---|---|---|
| `minimumReleaseAge` | **3 days** | Wait 72 hours after a release before opening a PR. Mitigates supply-chain attacks against freshly-published versions. Security advisories bypass this gate (`minimumReleaseAge: 0` under `vulnerabilityAlerts`). |
| `rangeStrategy` | `bump` | Bumps the version in `package.json` instead of widening the range. Reproducible installs. |
| `lockFileMaintenance` | weekly | Refreshes `bun.lock` even when no version bump exists. |
| `dependencyDashboardApproval` for `major` | required | Major bumps wait for a human tick on the Renovate dashboard issue. |
| `prHourlyLimit` / `prConcurrentLimit` | 3 / 6 | Caps the rate at which Renovate floods the PR list. |
| Grouping | `cloudflare workers runtime`, `agent runtime (opencode + e2b)`, `dev toolchain` | Limits blast radius — runtime-critical upgrades land in their own PR. |

If you need to merge a freshly-released dependency before the 3-day gate,
edit `package.json` + `bun.lock` manually and explain why in the PR.

Unused dependencies are caught by `bun run deadcode` (knip, CI gate) — no
human policy needed there.

---

## Observability

The repo has a single shared logger in
[`src/core/logger.ts`](src/core/logger.ts). It works in both runtimes
(Cloudflare Worker + Bun launcher) and emits one JSON object per line on
stdout/stderr so the output is scrapeable by `wrangler tail`,
`journalctl -o cat | jq`, Datadog Logs, Axiom, etc. without a custom
shipper.

```ts
import { createLogger, requestIdFrom } from "@/core/logger";

const requestId = requestIdFrom(request.headers);
const log = createLogger({ service: "worker", fields: { requestId } });

log.info("session.created", { sessionId, mode });
log.metric("worker.request", 1, { path, status: 200 });
```

Guarantees the logger gives you:

| Guarantee | What it does | Why it matters for agents |
|---|---|---|
| **Structured (NDJSON)** | One JSON object per line with `ts`, `level`, `msg`, `service`, plus any fields you pass | Agents can grep + jq the logs deterministically instead of regexing a freeform string |
| **Request-ID propagation** | `requestIdFrom(headers)` extracts `X-Request-Id` (or `cf-ray`) or mints a 16-char hex ID; the Worker echoes it back as `X-Request-Id` on every response | Lets you pivot from a launcher log line to the Worker log line that triggered it (distributed tracing baseline without OpenTelemetry overhead) |
| **Redaction** | Field names matching `password\|secret\|token\|authorization\|api[-_]?key\|cookie\|webhook[-_]?secret` are auto-replaced; string values matching GitHub PATs, E2B/Z.AI keys, `Bearer …` headers, and long hex blobs are auto-replaced | Best-effort defense in depth so an accidentally-logged secret doesn't leak to the logs bucket. **Not a substitute** for not logging secrets in the first place. |
| **Metrics envelope** | `log.metric(name, value, tags)` emits a line with `type: "metric"` so the ingestion pipeline can route it to a metrics store separately from human logs | Same `service` / `requestId` correlation as logs; compatible with DogStatsD / Prometheus exposition format |

Conventions:
- `LOG_LEVEL` env var (`debug` / `info` / `warn` / `error`, default
  `info`) controls the threshold.
- Prefer `log.child({ sessionId })` over re-passing the same field on
  every call.
- Don't use bare `console.log` in `src/` — it skips the redaction pass
  and breaks the NDJSON contract.

## Feature flags

Lightweight env-driven flag system in `src/core/feature-flags.ts`. No
LaunchDarkly / Statsig; sufficient for kill-switches and progressive
rollout of agent-shipped changes. Two primary entry points:

```ts
import { isFlagEnabled, percentageRollout } from "@/core/feature-flags";

// Boolean kill-switch.
if (isFlagEnabled("autofix_review_changes", env)) {
  /* ... */
}

// Stable per-key rollout.
if (percentageRollout("new_sandbox_image", sessionId, env)) {
  /* ... */
}
```

Flag-name convention: lowercase snake_case in code. Stored as an env var
named `FF_<UPPERCASE>`:

| Code call | Env var | Accepted values |
|---|---|---|
| `isFlagEnabled("foo", env)` | `FF_FOO` | `1`, `true`, `on`, `yes` (case-insensitive) → on; anything else (or missing) → off |
| `percentageRollout("foo", key, env)` | `FF_FOO_PCT` | integer/float 0..100; bucket assignment is deterministic on `key` via FNV-1a |
| `flagValue("model", env)` | `FF_MODEL` | raw string (variant flags) |

Set flags via `wrangler secret put FF_FOO` (Worker), `.dev.vars` (local),
or the launcher's systemd unit env (VPS).

### Flag lifecycle (registry + dead-flag detection)

Every flag the code reads is registered in
[`feature-flags.json`](feature-flags.json). The registry is the
single source of truth for "what flags exist, who owns them, and when
were they introduced". The dead-flag detector
([`scripts/detect-dead-flags.ts`](scripts/detect-dead-flags.ts), run as
`bun run flags:check`) reconciles the registry with grep results from
`src/`, `scripts/`, and `infra/` and fails CI on three conditions:

| Finding | What it means | Fix |
|---|---|---|
| **Declared but unused** | Flag exists in `feature-flags.json` but no call site mentions it | Delete the registry entry and the dead branch in the same PR. The flag's code path has already been removed; the registry hasn't caught up. |
| **Used but undeclared** | A call site references a flag name not in the registry | Add a registry entry (with `owner`, `createdAt`, `kind`) in the same PR. New flags must be registered when they're introduced. |
| **Stale** | A registered flag is older than `maxAgeDays` (default 90) and still has live call sites | Either ship the change and remove the flag, or bump `maxAgeDays` in the entry with a written justification in the PR description. |

This runs in the `lint` CI workflow on every PR (blocking) and in
[`.github/workflows/feature-flags-audit.yml`](.github/workflows/feature-flags-audit.yml)
on a weekly cron so flags that age out without any related PR still
surface.

Adding a new flag — short version:

1. Add a call to `isFlagEnabled` / `percentageRollout` / `flagValue`.
2. Add an entry to `feature-flags.json` with `name`, `kind`, `owner`,
   `createdAt`, and an optional `cleanup` note saying what "done" looks
   like for this flag.
3. Set `FF_<NAME>` in your `.dev.vars` / `wrangler secret put` /
   launcher unit env as appropriate.

Removing a stale flag is a one-line PR — the call site becomes the
code path that was behind the flag, and the registry entry is deleted
in the same commit.
