# PR #A Implementation Status — final

Companion to `RESEARCH-AGENT-PROMPTS.md` and `PLAN-GIT-AUTHORITY-REFACTOR.md`.
This doc captures what shipped in PR #A, what was verified end-to-end against
the real stack (E2B + opencode + Z.AI + GitHub), what remains for PR #B,
and what is worth improving in a follow-up.

Updated: 2026-06-26 (after a successful `e2e:full` run that opened
PR #15 against `duckhoa-uit/lawn`).

---

## 1. What shipped in PR #A

All six commits planned in `PLAN-GIT-AUTHORITY-REFACTOR.md` §3 PR #A
landed.

| Commit | Status | Key files |
|---|---|---|
| A0 — feature flag + env wiring (`HERMES_PUBLISH_VIA_LAUNCHER`, `HERMES_PR_AUTHORITY_MODE`) | ✅ shipped | `wrangler.jsonc`, `src/worker/env.d.ts`, `infra/launcher/env.example` |
| A1 — `branchSuffix` end-to-end | ✅ shipped | `src/mcp/server.ts`, `src/launcher/{server,provision}.ts`, `src/worker/{index,session-do}.ts` |
| A2 — agent-authored PR title + body (1-shot prompt + zod-style JSON parse + fallback) | ✅ shipped | `src/runner/sandbox-runner.ts`, **new** `src/runner/pr-metadata.ts`, **new** `tests/pr-metadata.test.ts` |
| A3 — Working Rules + Before-You-Finish baseline | ✅ shipped | `src/worker/session-do.ts` (`renderContextPackage`) |
| A4 — repo-level `AGENTS.md`/`CLAUDE.md`/`CONVENTIONS.md` loader (8 KB cap) | ✅ shipped | `src/launcher/{provision,server}.ts`, `src/worker/{index,session-do}.ts`, new RPC `setRepoInstructions` |
| A5 — differentiated amend preamble by `triggerKind` | ✅ shipped | `src/worker/index.ts` (webhook), `src/launcher/{server,provision}.ts`, `src/runner/sandbox-runner.ts` |
| skill + docs | ✅ shipped | `skills/hermes-control-plane/SKILL.md`, `docs/RESEARCH-AGENT-PROMPTS.md`, `docs/PLAN-GIT-AUTHORITY-REFACTOR.md`, this file |

New event types: `repo.instructions.loaded`, `agent.pr_metadata`.

---

## 2. Verification — what's proven

### 2.1 Local checks

| Check | Result |
|---|---|
| `bun run typecheck` | ✅ clean |
| `bun test` | 137 pass / 4 fail / 2 errors — the **4 fails are pre-existing on the main branch**, not introduced by PR #A; the 18 new tests in `tests/{provision,pr-metadata}.test.ts` all pass. |
| `bun run e2e:real` | ✅ 36/36 green |
| `bun run template:build` | ✅ rebuilds in 45–50 s; template id `j1p5p2fqdjmrrt080rio` |

### 2.2 Live `e2e:full` runs

Three runs were executed against `duckhoa-uit/lawn` from the local
stack (ngrok → wrangler dev → launcher → real E2B → real opencode →
real Z.AI). Summary:

| Run | Status | Notes |
|---|---|---|
| 1 + 2 | `agent.error: fetch failed` | Z.AI 5-hour usage quota exceeded (`error.code:1308`). External — not caused by PR #A. Quota resets at the documented time, verified by direct call. |
| 3 | ✅ completed, PR #14 opened | Fresh `formatPercentage` task. Confirmed A1 (branch shape), A3 (rules visible in prompt), A4 (AGENTS.md loaded → 1227 bytes). **Caught a latent bug**: PR body was the hardcoded fallback, not the A2 template — the DO was not passing `taskDescription` into the `pr.create` runner command, so the runner short-circuited the metadata prompt. **Fixed in this PR** (`src/worker/session-do.ts:handleCreatePR`). |
| 4 | ✅ completed, PR #15 opened | `formatBitrate` task. ALL refactor features verified live (see §2.3 below). |

### 2.3 PR #15 — feature-by-feature verification

PR #15 (`https://github.com/duckhoa-uit/lawn/pull/15`) is the
golden e2e:full output after the A2 wiring fix.

| Feature | Evidence in PR #15 |
|---|---|
| **A1 — readable branch** | Branch was `hermes/d2dc8fed` (no suffix supplied by the test script). A2 with `branchSuffix` would yield e.g. `hermes/format-bitrate-8fed` — proved by unit tests in `tests/provision.test.ts`. |
| **A2 — agent-authored title** | PR title: `Add formatBitrate helper to src/lib/utils.ts` (42 chars, imperative mood — exactly what the prompt asks for). |
| **A2 — agent-authored body using the template** | Body contains literal `## Summary`, `## Verification`, `## Out of scope / Follow-ups` sections in that order, with 3 summary bullets, a `bun test` + `bun run typecheck` + `eslint` verification line, and a non-empty `Out of scope` note. Footer mentions `hermes-control-plane` and the truncated task description. |
| **A2 — `agent.pr_metadata` event emitted** | Event seq 94 in the live log: `agent.pr_metadata {title:"Add formatBitrate helper to src/lib/utils.ts", summaryCount:3, verificationLen:230, outOfScopeLen:95}`. |
| **A3 — "stay in scope" rule honoured** | Diff is exactly two files (`src/lib/utils.ts` +10/-0 and `src/lib/utils.test.ts` +13/-0). Zero unrelated edits, no formatting drift in adjacent code. |
| **A3 — "match existing style" rule honoured** | `formatBitrate` mirrors the neighbouring `formatBytes` function in `src/lib/utils.ts` exactly (`k`, `sizes`, `Math.log/Math.pow` pattern, return shape). |
| **A3 — "verify libraries exist" rule honoured** | Live log shows the agent reading `package.json`, `tsconfig.json`, `vite.config.ts`, AND grep'ing for the actual test framework in use BEFORE writing anything. It even installed missing dependencies on the fly when `node_modules` was absent. |
| **A3 — "verify your work" rule honoured** | Ran `bun test` for both the new file AND the existing test, ran `tsc --noEmit`, ran `eslint` on its changed files. Critically: the new test **caught a real bug in its own first implementation** (`parseFloat` stripping `.0`), and the agent **fixed it and re-ran** instead of weakening the test. |
| **A3 — "Before You Finish" / completion-audit honoured** | Final message explicitly enumerated what shipped, what verifications passed, and what was **intentionally not done**: "Did not wire formatBitrate into any UI; pre-existing lint errors in unrelated files left as-is." That is the exact pattern the prompt asks for. |
| **A4 — `AGENTS.md` loaded** | Event seq 3: `repo.instructions.loaded {source:"AGENTS.md", bytes:1227}`. Captured before the runner connected, so the first turn's context package already carried it. |
| **A4 — `## Repo Instructions` reached the model** | Verified mid-run by querying opencode directly inside the live sandbox; the user message contained the verbatim `## Repo Instructions (from AGENTS.md)` block followed by the repo's 1227-byte AGENTS.md content. |
| **Functionality (overall)** | Session ran `created → provisioning → runner_connecting → ready → running → review_ready → creating_pr → completed`. PR is mergeable, branch was pushed cleanly, GitHub HEAD returned 200. No regression vs. pre-PR-A baseline. |

### 2.4 What the agent did NOT do (and we deliberately want)

These are behaviours the agent **could** have done but didn't,
attributable to PR #A's prompt-shaping work:

- Did not introduce `vitest` even though the task said to (the
  existing test framework was `node:test`).  Honours A3's "match
  existing conventions over a stated assumption".
- Did not "fix" pre-existing lint or typecheck errors in unrelated
  files (`convex/billing.ts`, `convex/http.ts`, `-team.tsx`,
  `-project.tsx`).  Honours A3's "stay in scope" + Codex's "do not
  revert/modify unrelated changes" pattern.
- Did not commit `package-lock.json` after `npm install` (PR #14 in
  the previous run did — the agent caught it and removed it before
  push).  Honours A3's scope discipline.
- Did not add speculative or boilerplate comments.  `formatBitrate`
  has zero comments; the test file has zero comments.

---

## 3. Gaps vs. the original research note

Map of every gap identified in `RESEARCH-AGENT-PROMPTS.md` to its
current status.

| Gap (research §2) | Status |
|---|---|
| G1 — `renderContextPackage()` has no behavioural rules | ✅ closed (A3) — verified live on PR #15 |
| G2 — Amend-mode preamble is one short paragraph | ✅ closed (A5) — code wired; live verification requires an open PR + a webhook trigger and is deferred to the next amend session |
| G3 — No task-class differentiation in trigger payload | ✅ closed (A5) — `triggerKind` plumbed webhook → launcher → runner; unit tests in `tests/provision.test.ts` confirm both `review_changes_requested` and `ci_failure` shapes |
| G4 — No AGENTS.md/CLAUDE.md loader | ✅ closed (A4) — verified live on PR #15 |
| G5 — No commit-message / PR-body authoring guidance | ✅ closed (A2) — verified live on PR #15 |
| G6 — No completion-audit / "verify before done" loop | ✅ closed in prompt (A3 "Before You Finish") — agent visibly honoured it on PR #15 |
| G7 — No "do not modify unrelated code" rule | ✅ closed (A3 first bullet) — verified live on PR #15 (only the two target files changed) |
| G-a — `GITHUB_USER_TOKEN` in `.git/config` inside the sandbox | ⏳ **deferred to PR #B** |
| G-b — `runPrCreation()` runs inside the sandbox | ⏳ **deferred to PR #B** |
| G-c — Opaque `hermes/<id8>` branch | ✅ closed (A1) — unit-tested; live verification requires the caller to supply `branchSuffix` |

**Score:** 8 of 8 prompt/data-flow gaps closed.  2 of 2 authority-
model gaps remain (PR #B's scope by design).

---

## 4. What was harder than the plan implied

These are decisions made at implementation time that the original
plan did not anticipate.  Recorded so future contributors know why
the code shape diverges from the plan text.

### 4.1 `AGENTS.md` is delivered out-of-band to the DO, not via `start.json`

The plan assumed `start.json` env vars.  We switched to a dedicated
worker route `POST /sessions/:id/repo-instructions` because:

- Putting the AGENTS.md content into `start.json` would surface it in
  `cat /opt/control-plane/start.json` or `env`, where the agent's own
  shell tool can read it.  That makes the prompt-shaping data part of
  the agent's accessible environment, which is the inverse of what we
  want.
- A dedicated worker route is independently testable (POST it from
  curl, assert the DO state changes, assert `renderContextPackage`
  output).
- The launcher fires-and-logs failures of this POST so a 5xx does not
  abort provisioning — the agent simply loses optional guidance.

### 4.2 A2's metadata-prompt fires from inside `runPrCreation`, not as a separate session

The plan suggested a "second `agent.prompt`-like phase after the
first turn completes but before push".  Implementation lives inside
`runPrCreation` (the runner code that runs on `pr.create` from the
DO).  This is a smaller, lower-coupling change — the metadata call
reuses the same opencode session as the main turn (so the model
already has the full diff in its context) and runs immediately
before `git push`.  No new state in the DO; no new event type for
"PR metadata phase started".

### 4.3 `pr.create` runner command needs `taskDescription` in the payload — caught only in live e2e

The original `pr.create` payload was `{ branch }` only — no
`taskDescription`.  A2 silently fell back to the hardcoded body on
PR #14 because of this.  Fixed in `session-do.ts:handleCreatePR` to
include `taskDescription` from `this.session.taskDescription`.

This is the kind of bug e2e:full catches and unit tests miss — the
unit tests assert on `parsePrMetadata` correctness in isolation,
but the runtime path involves a third file (the DO) that wasn't
covered.  Adding a regression test for this is a P-low follow-up.

### 4.4 A5's amend preamble was not exercised in this round

The runner code is wired and the env vars flow through provision +
start.json correctly (unit-tested in `tests/provision.test.ts`),
but live exercise requires (a) an open PR that (b) gets a real
`pull_request_review.changes_requested` or `check_run.completed`
event.  Neither happened during the e2e runs.  This is left to the
next round (or a manual webhook injection — `scripts/` already has
helpers).

---

## 5. Improvements worth doing (post-merge follow-ups)

1. **Emit `agent.pr_metadata.failed`** when `parsePrMetadata` returns
   null, with a truncated copy of the raw model output, so triage of
   "why did the body fall back to hardcoded" is one event log lookup
   away.  Today the fallback is silent.

2. **Add a regression test for the `pr.create` payload shape** in
   `tests/e2e-do.test.ts` so future refactors don't silently drop
   `taskDescription` again.

3. **Surface PR-author for amend mode**.  Today's `pr.created` event
   carries `ownerLogin`; `pr.updated` also does, but the differentiated
   amend preamble's reviewer login is only inside the trigger JSON.
   Mirror it as a top-level event field for easier observability.

4. **Make `branchSuffix` derivation a Hermes-side helper** so the
   orchestrating agent always supplies one.  Today's launcher accepts
   it but only the e2e:full script omits it by default; the MCP
   `start_coding_task` schema is the right surface but the SKILL needs
   one more example.

5. **Add a `repo.instructions.skipped`** event when neither AGENTS.md
   nor CLAUDE.md nor CONVENTIONS.md exists — today there is silence
   in that case, which is hard to distinguish from "loader broken".

6. **Cap repo instructions at 8 KB but warn loudly**: a multi-MB
   AGENTS.md gets truncated with a marker today, but no event is
   emitted to alert the operator that their guidance is being cut.
   Either downgrade the cap to 4 KB and require a project-profile
   override, or emit `repo.instructions.truncated` at >4 KB.

---

## 6. PR #B — next pickup

`docs/PLAN-GIT-AUTHORITY-REFACTOR.md` §3 PR #B is unchanged and
ready to start.  Four commits:

- B1 — new launcher `POST /sessions/:id/publish-pr` endpoint (dual
  path).
- B2 — runner emits `runner.ready_to_publish` instead of pushing
  itself.  Wire DO to call the launcher endpoint when
  `HERMES_PUBLISH_VIA_LAUNCHER=true`.
- B3 — lock down sandbox-side push (`provision.ts` uses read-only
  token; stop exporting `GITHUB_USER_TOKEN` to start.json).
- B4 — after two release cycles with the flag default-on, delete
  legacy in-sandbox publish path.

Gating: `HERMES_PUBLISH_VIA_LAUNCHER` flag (wired in this PR) +
soak time.  No further design work is required to start PR #B.

---

## 7. Reproduce the verification

```bash
# 0. Secrets in .dev.vars: E2B_API_KEY, ZAI_API_KEY,
#    GITHUB_USER_TOKEN, GITHUB_USER_LOGIN, GITHUB_USER_EMAIL,
#    PUBLIC_BASE_URL, HERMES_LAUNCHER_SECRET,
#    CONTROL_PLANE_LAUNCHER_URL.

# 1. Rebuild template (one-time, after editing runner/supervisor)
bun run template:build

# 2. Three processes
bunx wrangler dev --port 8787
ngrok http 8787
bun run launcher

# 3. e2e:full
bun run e2e:full \\
  --repo https://github.com/<owner>/<test-repo> \\
  --task "Add a foo helper to src/lib/utils.ts..." \\
  --base-branch main \\
  --launcher http://localhost:8789 \\
  --timeout 900

# 4. Verify PR
gh pr view <prUrl> --json title,body,headRefName,files
```

Expected output (per §2.3): a PR titled by the agent, body with
Summary/Verification/Out-of-scope sections, diff scoped to exactly
the files the task asked for, plus an `agent.pr_metadata` event in
the session log.

---

