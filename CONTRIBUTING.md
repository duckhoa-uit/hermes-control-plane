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
