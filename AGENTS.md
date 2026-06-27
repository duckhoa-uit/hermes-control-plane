# AGENTS.md — instructions for autonomous coding agents

This file tells an autonomous coding agent (Claude Code, Factory Droid,
OpenAI Codex, etc.) the **minimum it needs to be productive in this
repo** without having to re-derive conventions from the source. It is
deliberately short and links out to the canonical sources for anything
deep.

If you are a human, you probably want `README.md` (project pitch +
architecture) or `CONTRIBUTING.md` (the full conventions playbook). This
file is the agent-targeted distillation of both, plus the playbook of
"how do I run X" that an agent typically asks first.

---

## 1. Stack at a glance

- **Runtime A** — Cloudflare Worker (`src/worker/`) + two Durable
  Objects (`SessionDurableObject`, `PrIndexDurableObject`). Deployed
  with `wrangler`.
- **Runtime B** — Bun sidecar in `src/launcher/` (the "launcher").
  Long-running process on a VPS; talks to E2B + GitHub.
- **Runtime C** — agent runner in `src/runner/` baked into an E2B
  sandbox image. Drives [OpenCode](https://opencode.ai).
- **Package manager** — Bun (1.3+). Lockfile is `bun.lock`. Never
  switch to npm / pnpm / yarn; CI uses `bun install --frozen-lockfile`.
- **Language** — TypeScript strict mode. `tsconfig.json` paths: `@/*`
  → `src/*`.
- **Tests** — Vitest (`tests/`). 280+ tests.

For the full architecture, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 2. Commands you will actually need

| Need | Command | Notes |
|---|---|---|
| Install deps | `bun install` | First time only; CI uses `--frozen-lockfile`. |
| One-shot bootstrap from clone | `bun run setup` | Verifies tooling, installs, runs lint + typecheck + tests, copies `.dev.vars.example` → `.dev.vars`. Idempotent. |
| Worker dev server | `bun run dev` | `wrangler dev` on port 8787. Needs `.dev.vars` populated. |
| Launcher dev server | `bun run launcher` | Port 8789. Reads `.dev.vars`. |
| Run full vitest suite | `bun run test` | ~2 s. Pure: no network, no real sandbox. |
| Watch tests | `bun run test:watch` | |
| Tests with coverage gate | `bun run test:coverage` | v8 provider; thresholds in `vitest.config.ts`. Same gate CI runs. |
| Tests as CI runs them | `bun run test:ci` | Adds verbose + junit reporters and `retry: 2` for flake surfacing. |
| Typecheck | `bun run typecheck` | `tsc --noEmit`. |
| Lint | `bun run lint` | Oxlint. CI gate. |
| Lint with autofix | `bun run lint:fix` | Safe autofixes only. |
| Format (write) | `bun run format` | Biome formatter. |
| Format (check) | `bun run format:check` | CI gate. |
| Dead code / unused exports / unused deps | `bun run deadcode` | Knip. CI gate. |
| Duplicate code | `bun run dupes` | jscpd, threshold 4%. CI gate. |
| Dead feature flag detection | `bun run flags:check` | Reconciles `feature-flags.json` with call sites. CI gate. |
| Worker bundle size budget | `bun run bundle:size` | Hard limit 1 MiB. CI gate. |
| End-to-end against fake runner | `bun run e2e:real` | Needs `bunx wrangler dev` running. |
| End-to-end real PR | `bun run e2e:full --repo <url>` | Real E2B + Z.AI + GitHub. |

### The "make it green" loop

The pre-commit hook (`husky`) runs `lint-staged` (Biome format + Oxlint
--fix on changed files). CI runs the full set above. Locally, the
shortest path to green is:

```bash
bun run lint:fix && bun run format && bun run typecheck && bun run test
```

If you change a feature-flag call site, also run `bun run flags:check`.
If your change touches `src/worker/` or any imported dependency, also
run `bun run bundle:size`.

---

## 3. Where things live

```
src/core/           pure logic, no I/O           (logger, feature-flags, types, state-machine, ...)
src/worker/         Cloudflare Worker            (HTTP + WS + DOs)
src/launcher/       Bun sidecar                  (E2B + GitHub + publish)
src/runner/         runs inside the sandbox      (OpenCode driver)
src/mcp/            MCP server                   (Slack/agent integration)
infra/              build scripts + systemd
scripts/            CLIs + one-off tooling
tests/              vitest suites (mirror src/)
docs/               long-form architecture / setup / deployment / roadmap
skills/             Hermes-agent skill files
```

Conventions (full table in
[`CONTRIBUTING.md`](CONTRIBUTING.md#naming-conventions)):

- File names: `kebab-case.ts`. Test files: `<name>.test.ts`.
- Identifiers: `camelCase` for vars/functions, `PascalCase` for types,
  `UPPER_SNAKE_CASE` for module-level constants.
- Event types: `dot.separated.lowercase` (e.g. `session.created`).
- State machine states: `snake_case` (e.g. `review_ready`).
- Env vars: `UPPER_SNAKE_CASE`; sandbox-internal vars get the
  `CONTROL_PLANE_` prefix.
- Branches: `<category>/<short-description>` (e.g. `chore/add-x`,
  `fix/handle-y`). Agent-authored sessions use `hermes/<sessionId>`.
- Commit subjects: Conventional Commits (e.g.
  `chore(lint): tighten complexity budget`).

Module size budgets enforced by Oxlint: `complexity 25`,
`max-lines 1500`, `max-lines-per-function 250`. Tests are exempt.

---

## 4. Things every agent should read before editing

| If you are about to … | Read first |
|---|---|
| Add a feature flag | [`CONTRIBUTING.md` §Feature flags](CONTRIBUTING.md#feature-flags) + `feature-flags.json` |
| Log anything | [`CONTRIBUTING.md` §Observability](CONTRIBUTING.md#observability) — use the logger, never bare `console.log` |
| Touch the state machine | `src/core/state-machine.ts` + `tests/state-machine.test.ts` |
| Add a route to the Worker | `src/worker/index.ts` (dispatcher); keep handlers under the per-function size budget |
| Touch the sandbox runner | `docs/ARCHITECTURE.md` §sandbox interior — the runner's contract with OpenCode SSE is locked in §11.9 of `docs/ROADMAP.md` |
| Add a webhook handler | `src/worker/github-webhook.ts` — read the lifecycle matrix in `docs/DEPLOYMENT.md §13.3` |
| Add a new dependency | [`CONTRIBUTING.md` §Dependency policy](CONTRIBUTING.md#dependency-policy) — Renovate gate is 3 days `minimumReleaseAge`. |

---

## 5. Code-quality philosophy

These are explicit project values, not generic style advice. Reviewers
will reject PRs that violate them.

- **Do only what was asked.** Bug fixes don't refactor surrounding
  code; small features don't add configurability beyond what was
  requested.
- **Don't add error handling for impossible scenarios.** Trust internal
  guarantees. Validate only at system boundaries (HTTP, webhooks,
  external APIs).
- **Don't create helpers for one-time operations.** Three similar
  lines is better than a premature abstraction.
- **Don't add backwards-compat shims** unless explicitly required —
  delete unused code.
- **Only comment what isn't self-evident.** Don't add docstrings or
  type annotations to code you didn't change.

Full version in [`CONTRIBUTING.md`](CONTRIBUTING.md#code-quality-philosophy).

---

## 6. Environment variables you will probably need

| Var | Used by | What | How to get it |
|---|---|---|---|
| `E2B_API_KEY` | launcher | E2B sandbox auth | https://e2b.dev/dashboard |
| `ZAI_API_KEY` | sandbox runner | LLM provider | https://z.ai/manage-apikey |
| `GITHUB_WRITE_TOKEN` | launcher only | Push + open PR | Fine-grained PAT, Contents + Pull-requests RW |
| `GITHUB_READ_TOKEN` | sandbox | Clone + fetch | Fine-grained PAT, Contents Read |
| `GITHUB_WEBHOOK_SECRET` | Worker | HMAC validation | `openssl rand -hex 32` |
| `LAUNCHER_SHARED_SECRET` | Worker + launcher | Mutual auth | `openssl rand -hex 32` |
| `WORKER_URL` / `LAUNCHER_URL` | both | Wire-up between the two | ngrok / Cloudflare Tunnel URL |
| `LOG_LEVEL` | both | `debug` / `info` (default) / `warn` / `error` | optional |
| `FF_*` | both | Feature flags (see `feature-flags.json`) | optional |

Full annotated list with context is in
[`.dev.vars.example`](.dev.vars.example).

---

## 7. CI gates an agent must respect

Every PR runs:

1. **lint** — `oxlint` (no warnings, no errors).
2. **format:check** — `biome format` (no diff).
3. **typecheck** — `tsc --noEmit`.
4. **tests** — `bun run test:ci` (vitest + v8 coverage). Job fails on:
   - any failing test;
   - line/function/statement coverage below 60% or branch below 70%
     (thresholds in `vitest.config.ts`);
   - any test that turns green only after a retry surfaces as
     `:warning: Flaky tests` in the run summary (vitest `retry: 2` on CI).
   The junit XML + lcov report are uploaded as workflow artifacts.
5. **deadcode** — `knip` (no unused files / exports / deps).
6. **dupes** — `jscpd` (<4% duplication).
7. **flags:check** — feature-flag registry consistency.
8. **bundle:size** — Worker bundle ≤ 1 MiB.
9. **droid-review** — automated PR review (advisory).
10. **release-drafter** — labels the PR by Conventional Commit prefix.

A pre-commit hook (`husky` + `lint-staged`) catches the first two
locally. Everything else is CI-only.

---

## 8. Don'ts

- Don't push directly to `main`. Open a PR.
- Don't bypass the pre-commit hook (`--no-verify`) unless you're
  certain CI will be happy.
- Don't add a dependency without reading the §Dependency policy
  section of `CONTRIBUTING.md`. Renovate enforces a 3-day
  `minimumReleaseAge` for supply-chain reasons.
- Don't use bare `console.log` in `src/` — the structured logger in
  `src/core/logger.ts` does redaction and request-ID propagation that
  matter in production.
- Don't change branch / PR naming conventions; the release-drafter
  config and PR-index lookup both depend on the current shape.
- Don't introduce a new state machine state without updating
  `src/core/state-machine.ts` **and** the matching tests.

---

## 9. Where to ask follow-up questions

- Architecture / state machine: `docs/ARCHITECTURE.md`
- Local-dev setup: `docs/SETUP.md`
- Deployment / GitHub webhooks: `docs/DEPLOYMENT.md`
- Roadmap, decision log, future direction: `docs/ROADMAP.md`
- Everyday conventions: `CONTRIBUTING.md`

When in doubt: read the test for the file you're about to change. The
test fixtures encode invariants the production code relies on.
