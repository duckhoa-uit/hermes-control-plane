# Plan — Adopt the Industry Git/PR Authority Model

> **Status (updated 2026-06-26):** PR #A (Phases 0–5) is implemented and
> live-verified — see `docs/STATUS-PR-A.md`. PR #B (Phase 6 = publish-via-
> launcher + push lockdown) and PR #C (Phase 7 = cleanup) are unchanged
> and ready to start.

Companion to [`docs/RESEARCH-AGENT-PROMPTS.md`](RESEARCH-AGENT-PROMPTS.md) §7.
That note explains *why*; this doc says *what + in what order + how to verify*.

**Target outcome:** match the GitHub Copilot Coding Agent / Sweep /
OpenHands resolver shape — the in-sandbox agent uses git locally
(`add`, `commit`, `diff`, `log`) but cannot push to `origin` or open
PRs.  All side effects against GitHub flow through one launcher
endpoint that the control plane owns.

**Non-goals**

- Switch to a patch-only (Sweep-style) edit model.  Opencode emits
  tool calls, not unified diffs.
- Replace `PrIndexDurableObject` / webhook lifecycle (§13.3).  These
  are exactly the assets that make the refactor worth it.
- Multi-repo, multi-org, or multi-user OAuth.  ROADMAP §14 owns that;
  this plan is single-user OAuth as today.

---

## 1.  Current gaps (recap)

Reference: `RESEARCH-AGENT-PROMPTS.md` §7.1 / §7.2.

| Gap | Location today | Why it matters |
|---|---|---|
| G-a | `GITHUB_USER_TOKEN` written into `.git/config` inside the sandbox (`src/launcher/provision.ts:119`) | An agent that `cat .git/config` exfiltrates a `repo:write` token.  Worst case: PR opened on an unrelated repo. |
| G-b | `runPrCreation()` runs *inside* the sandbox (`src/runner/sandbox-runner.ts:346`) and calls `git push origin` + `POST /repos/.../pulls` | The plane has no chokepoint for "is this push allowed?" / "has this PR already been opened?"; the runner is trusted code AND the agent's environment. |
| G-c | Branch is `hermes/<8-char-id>` only — opaque to reviewers (`provision.ts:140`) | Reviewers can't tell what a branch is for from the GitHub branch picker. |
| G-d | Agent never authors the PR body; runner hardcodes "Automated PR …" (`sandbox-runner.ts:373`) | The diff narrative the agent has in context is thrown away; reviewers click through to file diff with zero guidance. |
| G-e | No completion-audit step; `agent.done` fires unconditionally after `session.prompt` returns (`sandbox-runner.ts:333`) | Sloppy turns ship as PRs and cost a review round-trip. |
| G-f | Single shared amend preamble for `review_changes_requested` vs `ci_failure` vs manual follow-up | Three very different problems get one prompt; review-feedback amends often drift. |

---

## 2.  Target shape

After this plan lands, the control flow for a fresh PR is:

```
  Hermes (host agent)
    │  start_coding_task { taskDescription, repoUrl, branchSuffix? }
    ▼
  Launcher  POST /sessions
    │  provision sandbox:
    │   - git clone with READ-ONLY clone token
    │   - git config user.{name,email} = real user
    │   - branch = hermes/<branchSuffix>-<4-char-id>
    │   - .git/config remote has NO write token
    │   - GITHUB_USER_TOKEN is NOT exported to sandbox env
    ▼
  Sandbox / runner / opencode
    │  - agent edits files
    │  - agent runs tests/lint locally
    │  - runner does `git add` + `git commit` on behalf of agent
    │  - runner asks agent for 1-shot PR title + body
    │  - runner emits `runner.ready_to_publish` over WS:
    │      { branch, headSha, title, body, verification, outOfScope }
    ▼
  Worker / SessionDurableObject
    │  - validates state (review_ready) + dedupes by headSha
    │  - calls launcher POST /sessions/:id/publish-pr (server-server,
    │    shared secret)
    ▼
  Launcher  POST /sessions/:id/publish-pr
    │  - holds the PR-author token (never seen by the sandbox)
    │  - runs `git push` against the sandbox with a one-shot remote
    │    URL passed as argv (not persisted in .git/config)
    │  - if fresh: POST /repos/.../pulls (with agent-authored title/body)
    │    elif amend: re-emit pr.updated (PR already exists)
    │  - registers PrIndex row inside the same RPC
    ▼
  Worker emits pr.created (or pr.updated) — webhook lifecycle unchanged
```

Amend flow is the same minus the `POST /pulls`.

Three concrete invariants the refactor establishes:

1. **No write-scoped token ever lives at rest inside the sandbox.**
   The launcher injects it for the duration of one `git push`, then
   wipes it.  Provable: `grep -r GITHUB_USER_TOKEN sandbox-snapshot`
   returns nothing after `publish-pr` completes.
2. **All `origin` mutations go through `publish-pr`.**  Provable: the
   sandbox-side `.git/config` remote URL has either no creds (HTTPS
   401 on push) or a read-only token (HTTPS 403 on push).  A push
   attempt by the agent fails cleanly.
3. **`PrIndex` registration and `POST /pulls` are atomic with respect
   to the launcher endpoint.**  Provable: webhook-handler tests
   still pass; no path opens a PR without an index row.

---

## 3.  Shipping plan — 3 PRs

Earlier drafts of this plan had 7 phases / 6 PRs.  After review we
collapsed the additive prompt/data-flow work into **one PR (#A)** and
kept the structural refactor isolated in **PR #B**, with a tiny
**PR #C** for cleanup.  Justification: Phases 1–5 are all additive
with independent fallbacks (each one's failure mode is "behave like
today"), so they can ride together and still be debuggable in
isolation by reading the per-commit diff.  Phase 6 changes where
secrets live and where PRs are opened — it stays alone, behind a
flag, soaked for one release.

### PR #A — "agent-prompt-baseline"  (additive only; no flag needed)

Single PR, six commits (one per phase) kept un-squashed so a reviewer
(or `git bisect`) can step through each behavioural change
individually.

| Commit | Phase | What changes | Fallback if buggy |
|---|---|---|---|
| A0 | 0 — flag + doc | Add `HERMES_PUBLISH_VIA_LAUNCHER` (default `false`) to `wrangler.jsonc` + `src/worker/env.d.ts`; add `HERMES_PR_AUTHORITY_MODE` to `infra/launcher/env.example`; land this plan + a `docs/DEPLOYMENT.md` rollout row | Flag is unread by anything in this PR; pure prep for PR #B |
| A1 | 1 — `branchSuffix` | Optional `branchSuffix` on `start_coding_task` MCP tool + launcher `POST /sessions`; validate `^[a-z0-9-]{1,40}$`; branch = `hermes/${suffix}-${id4}` else today's `hermes/${id8}` | Suffix absent → today's branch shape |
| A2 | 2 — agent-authored PR title/body | Add a 1-shot `opencode.session.prompt` after the main turn, constrained to STRICT JSON `{ title, summary[], verification, outOfScope }`, parsed with `zod`; render PR body from a fixed template (Summary / Verification / Out of scope / Hermes footer); emit `agent.pr_metadata` event | `zod` parse failure → today's hardcoded title + body |
| A3 | 3 — Working Rules + completion-audit clause | Replace `renderContextPackage()` (`src/worker/session-do.ts:519`) with the `Working Rules` + `Before you finish` blocks drafted in `RESEARCH-AGENT-PROMPTS.md` §3 P1 + P3 | None needed — pure prompt change; revert = one-line |
| A4 | 4 — repo-level `AGENTS.md` loader | At clone-time, read up to 8 KB of `AGENTS.md` / `CLAUDE.md` / `CONVENTIONS.md` (first that exists); pass through `start.json` as `REPO_INSTRUCTIONS`; DO appends as `## Repo Instructions` *below* the baseline rules in the context package; emit `repo.instructions.loaded` event | Missing file → no-op; size cap prevents context blow-up |
| A5 | 5 — differentiated amend preamble | Promote `triggerKind ∈ {review_changes_requested, ci_failure, manual_followup}` into the launcher request; forward as `CONTROL_PLANE_AMEND_TRIGGER_KIND` / `CONTROL_PLANE_AMEND_TRIGGER_DETAILS_JSON`; runner switches on it into one of three preambles (modelled on OpenHands suggested-task templates) | Trigger kind unset → today's single shared preamble |

**Why these gel in one PR:** A0 is pure infra; A1 changes provisioning input; A2 + A3 + A4 all just change the prompt text the runner sends opencode; A5 adds new env vars that the runner branches on.  No two of them touch the same lines of `renderContextPackage` / `sandbox-runner` simultaneously — they layer cleanly.

**Tests added in this PR:**

- `tests/provision.test.ts`: branch-suffix happy + invalid-suffix fallback (A1); `AGENTS.md` fixture loads end-to-end (A4).
- `tests/integration.test.ts`: golden update for new context package shape (A3).
- New `tests/pr-metadata.test.ts`: fake-runner emits `agent.pr_metadata`; DO threads it into the published PR body (A2).
- `tests/github-webhook.test.ts`: assert `triggerKind` ends up in the launcher call body for both review-changes-requested and check-run-failure paths (A5).
- New `tests/runner-amend-preamble.test.ts`: three trigger-kind cases each produce the right preamble (A5).

**Verification:**

- `bun test` (vitest) all green.
- `e2e:real` against fake-runner: confirms A1's new branch shape + A5's three preambles end-to-end.
- `e2e:full` (real E2B + real GitHub PR): confirms A2's agent-authored body renders, A3's rules visibly shape the diff, A4's `AGENTS.md` shows in the `repo.instructions.loaded` event.

**Risk:** Low.  Each commit has an explicit fallback to today's behaviour.  Worst case is "agent ignores rules", which is the current state.

**Roll-back:** revert the PR.  No data migration, no flag flip.

### PR #B — "publish-via-launcher"  (structural; flag-gated; soak)

Land **alone** after PR #A has merged and `e2e:full` is green.  Four
commits, all behind `HERMES_PUBLISH_VIA_LAUNCHER`.

| Commit | What changes |
|---|---|
| B1 — new launcher endpoint, dual-path | Add `POST /sessions/:id/publish-pr` (server-server, existing `x-hermes-launcher-secret`).  Extract today's `runPrCreation` (`sandbox-runner.ts:346`) body into a new `src/launcher/publish.ts` (`git push` via one-shot remote URL passed as argv, `POST /repos/.../pulls`, `PrIndex` register all in the same handler).  Endpoint is wired but unused — `handleCreatePR` still sends `pr.create` to the runner. |
| B2 — runner emits `runner.ready_to_publish` | Split `runPrCreation` into: local prep (`git add`, `git commit`, `git rev-parse HEAD`) + WS emit `runner.ready_to_publish { branch, headSha, title, body }` (title/body from PR #A's `agent.pr_metadata`).  DO's `handleCreatePR`: when `HERMES_PUBLISH_VIA_LAUNCHER=true`, call the new launcher endpoint instead of sending `pr.create`.  New event types `pr.publishing`, `pr.publish.failed`. |
| B3 — lock down sandbox-side push | `provision.ts:119`: change `git remote set-url origin` to a *read-only* clone token (TBD: simplest = a dedicated `Contents: Read` PAT in `HERMES_GITHUB_READ_TOKEN`; alternative = GitHub's `git-upload-pack`-only OAuth flow used by Copilot Coding Agent).  Stop exporting `GITHUB_USER_TOKEN` to `start.json` env entirely.  Sandbox-side `git push origin` now returns HTTPS 403. |
| B4 — rip the legacy path | After two release cycles with `HERMES_PUBLISH_VIA_LAUNCHER=true` by default and no regression, delete the legacy in-sandbox publish code path entirely. |

**Tests added/changed in this PR:**

- New `tests/publish-via-launcher.test.ts`: dual-path branching by flag.
- `tests/provision.test.ts`: assert `GITHUB_USER_TOKEN` is absent from `start.json` under the new mode (B3).
- `tests/m5-resume-contract.test.ts`: assert `runner.ready_to_publish` shape on the WS contract (B2).

**Verification:**

- `bun test` green.
- `e2e:full` with `HERMES_PUBLISH_VIA_LAUNCHER=false`: byte-identical PR to today.
- `e2e:full` with `HERMES_PUBLISH_VIA_LAUNCHER=true`: real PR opened by the launcher path; `sandbox-debug.ts <sbxId>` confirms `.git/config` has no write-scoped token and `git push origin` returns 403.
- Soak `=true` in staging for one release before defaulting on prod; soak default-on for one release before B4 ships.

**Risk:** High.  Mitigations: feature flag, dual-path through B1+B2, B3 only after B1+B2 have soaked, B4 only after two release cycles.

**Roll-back:** flip flag to `false`.  If B3 has already shipped and we need to revert further, restore the write token in launcher env and re-deploy.

### PR #C — "cleanup"  (small)

Ships immediately after PR #B's B4 commit.

- Delete dead code paths surfaced by B4.
- Update `docs/ARCHITECTURE.md`: replace runner-owned PR arrows with launcher-owned in the diagram + text.
- Update `docs/ROADMAP.md` §13/§14: mark P1/P2/P3/P4/P5/P8/P9/P10 as shipped, link this plan.
- Bump `version` in `skills/hermes-control-plane/SKILL.md` to 1.3.0; update Quick Reference event table if any event names changed in PR #A/B.

**Risk:** None.  Pure docs + dead-code removal.

---

## 4.  Timeline + dependencies

```
PR #A (agent-prompt-baseline)  ─── independent, ship anytime ───┐
                                                                 ▼
                                                              merge
                                                                 │
                                                                 ▼
PR #B (publish-via-launcher)   ─── B1+B2 behind flag ─── soak 1 release ─── flag default-on ─── soak 1 release ─── B4 (rip legacy)
                                                                                                                       │
                                                                                                                       ▼
                                                                                                                    merge
                                                                                                                       │
                                                                                                                       ▼
PR #C (cleanup)                                                                                                ─── final
```

Suggested calendar:

- **PR #A**: review + merge in one sprint.
- **PR #B**: B1+B2+B3 land in one PR with flag default `false`.  Soak in staging one release.  Default-on in next release.  B4 ships the release after.
- **PR #C**: same release as B4.

---

## 5.  Verification matrix

| PR | vitest | `e2e:real` | `e2e:full` | Manual check |
|---|---|---|---|---|
| #A | ✅ + 4 new suites | ✅ branch shape + 3 amend preambles | ✅ PR body has new template; `AGENTS.md` loaded; diff stays narrow | reviewer reads PR body, no clickthrough required |
| #B (flag off) | ✅ | ✅ | ✅ byte-identical to today | regression check vs. previous release |
| #B (flag on, B1+B2) | ✅ + `publish-via-launcher` suite | — | ✅ real PR via launcher endpoint | sandbox-debug shows publish completed via launcher |
| #B (flag on, B3) | ✅ + `provision` token-absent assertion | — | ✅ real PR | `sandbox-debug.ts <sbxId>` after publish: `.git/config` has no write token; `git push origin` returns 403 |
| #B (B4) | ✅ legacy paths deleted | ✅ | ✅ | no flag-off path exists |
| #C | ✅ | ✅ | ✅ | ARCHITECTURE diagram matches code |

---

## 6.  Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PR #B breaks `e2e:full` on a real repo | Med | High | Feature flag (A0), dual-path B1+B2, soak one release before B4 |
| PR #A — agent emits malformed JSON for PR body | Med | Low | `zod` parse + fall back to today's hardcoded body |
| PR #A — Working Rules explode token cost | Low | Med | `Working Rules` is ~400 tokens; measure before/after via `agent.usage` events |
| PR #A — `AGENTS.md` contains adversarial instructions (e.g. "ignore your rules") | Low | Med | Cap at 8 KB; load as `## Repo Instructions` *below* the baseline rules in the prompt so the system rules win on conflict (Codex convention — see RESEARCH §1.3) |
| PR #A — webhook payload shape change for `triggerKind` | Low | Med | Backwards-compatible: launcher reads both old and new fields for one release |
| PR #B — launcher endpoint becomes a new single point of failure | Med | Med | Existing launcher already has uptime requirements; add a `/health` row for `publish-pr` capacity; the orphan sweeper already handles stuck-publishing sandboxes via the existing terminal-state reaper |
| Read-only clone token strategy (B3) is GitHub-only | High | Low (single supported provider today) | Document in §14 of ROADMAP that GitLab/Bitbucket would need analogous tokens; not in scope here |
| Reviewer can't isolate bugs across PR #A's six commits | Low | Med | Commits are NOT squashed; each is independently revertable; commit messages link back to the table row in §3 |

---

## 7.  Definition of done

The refactor is complete when ALL of the following are true:

1. PR #A has merged: `start_coding_task { branchSuffix }` produces a
   readable branch; PR body uses the Summary/Verification/Out-of-scope
   template; `renderContextPackage` includes the Working Rules and
   completion-audit clause; repo-level `AGENTS.md` (if present) is
   loaded and visible in `repo.instructions.loaded`; the three amend
   trigger kinds produce three distinct preambles.
2. PR #B has merged with `HERMES_PUBLISH_VIA_LAUNCHER=true` as default,
   for two consecutive release cycles, with no rollbacks.
3. `scripts/sandbox-debug.ts <sandboxId>` on a session that just
   published a PR shows `.git/config` with no write-scoped token,
   and `git push origin` from inside the sandbox returns HTTP 403.
4. `tests/publish-via-launcher.test.ts` + the updated suites green on CI.
5. PR #C has merged: `docs/ARCHITECTURE.md` diagram + control-flow
   text match the shipped code; ROADMAP marks P1/P2/P3/P4/P5/P8/P9/P10
   as shipped; legacy in-sandbox publish code path is deleted.
6. The webhook lifecycle tests (review-feedback amend, CI-fail amend,
   merge → archive) still pass end-to-end with the new trigger-kind
   preambles.

Until (5), the legacy path stays available; until (2) we keep the flag.
