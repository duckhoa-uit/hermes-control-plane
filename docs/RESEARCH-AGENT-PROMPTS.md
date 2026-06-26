# Research — Agent / Git Workflow Prompts in Other Tools

> **Status (updated 2026-06-26):** Gaps G1–G7 below are now closed in
> PR #A (see `docs/STATUS-PR-A.md` and `docs/PLAN-GIT-AUTHORITY-REFACTOR.md`).
> Live-verified on PR #15 of `duckhoa-uit/lawn`. Gaps G-a / G-b in §7.2
> are deferred to PR #B (publish-via-launcher).

Date: 2026-06-26. Scope: how Devin, Claude Code, Codex CLI/Cloud, Cline,
Aider, OpenHands, Cursor and friends structure (a) their *system prompts*
and (b) the *git/PR workflow rules* they hand the model. Goal: identify
gaps in `hermes-control-plane` and propose targeted, low-risk updates.

This is a research note + an action list. It is **not** a refactor PR.
Each proposal is sized so it can land independently and be reverted
without ripple effects.

---

## 0. What Hermes ships today

Two layers of prompt:

1. **`renderContextPackage()`** in `src/worker/session-do.ts:519`. Built
   per-session, sent as the first text part to opencode. Today it is:

   ```
   # Hermes Task Context

   ## Project: <name>
   ## Repository: <repoUrl>
   ## Branch: <branch>

   ## Task
   <taskDescription>

   ## Project Instructions
   <profile.agentsContext>      // optional
   ```

2. **Amend-mode preamble** in `src/runner/sandbox-runner.ts:288`.
   Prepended when `CONTROL_PLANE_PR_MODE_*` env is set:

   ```
   # Hermes amend mode
   You are continuing work on an EXISTING open pull request:
   - Branch: ...
   - PR #N: <url>
   Make the requested change on this branch. Do NOT open a new PR — ...
   ```

Everything else (commits, branch creation, PR opening) happens
*outside* the model — the runner calls `git add -A && git commit` and
`POST /pulls` itself (`src/runner/sandbox-runner.ts:346`). The model
writes files; the runner publishes them.

`ALLOW_ALL_TOOLS` (`sandbox-runner.ts:39`) pre-declares every opencode
tool so the session never blocks on `permission.asked` (rationale in
ROADMAP §12.17).

`skills/hermes-control-plane/SKILL.md` is a *host-side* skill — it
tells *Hermes* (the orchestrating agent) when/how to call the four
MCP tools, not what the sandboxed agent should do.

So: the in-sandbox agent currently gets very little written guidance
beyond "here is the task, here is the repo". That is the gap this
note is about.

---

## 1. What the field is doing

### 1.1 Devin (Cognition) — explicit *Approach to Work* block

Devin's system prompt (leaked, see
`x1xhlol/system-prompts-and-models-of-ai-tools` →
`Devin AI/Prompt.txt`) is the most relevant reference because Devin is
also a background agent that opens real PRs. Key sections:

- **Approach to Work** — explicit rules about environment issues, test
  modifications ("never modify the tests themselves unless your task
  explicitly asks you to"), running lint/tests before submitting.
- **Coding Best Practices** — short, declarative:
  - Do not add comments unless asked or the code is complex.
  - Mimic existing file conventions before editing.
  - Never assume a library is available — check `package.json` /
    `cargo.toml` / neighbors first.
- **Data Security** — never commit secrets, never log keys.
- **Git and GitHub Operations** (literal text):
  > - Never force push, instead ask the user for help if your push fails
  > - Never use `git add .`; instead be careful to only add the files
  >   that you actually want to commit.
  > - Use gh cli for GitHub operations
  > - Do not change your git config unless the user explicitly asks
  >   you to do so. Your default username is "Devin AI" …
  > - Default branch name format: `devin/{timestamp}-{feature-name}`.
- **"Think before critical git decisions"** — Devin has a `<think>`
  scratchpad and is told to use it *before* deciding what branch to
  branch off, whether to open a new PR vs. update an existing one,
  etc.

### 1.2 Claude Code 2.0 — explicit *Git Safety Protocol*

`Anthropic/Claude Code 2.0.txt` ships a numbered protocol the model
follows when asked to commit / PR:

- NEVER update the git config.
- NEVER run destructive/irreversible git commands (push --force, hard
  reset, etc.) unless explicitly requested.
- NEVER skip hooks (`--no-verify`).
- NEVER force push to main/master, warn the user if requested.
- Avoid `git commit --amend`. Only amend if (1) user explicitly asked
  or (2) adding edits from pre-commit hook — and even then, check
  authorship first (`git log -1 --format='%an %ae'`) and confirm the
  commit hasn't been pushed.
- "If there are no changes to commit, do not create an empty commit."
- Compose commit/PR bodies via HEREDOC to preserve formatting.
- PR body template includes `#### Summary` (1-3 bullets) +
  `#### Test plan` (markdown checklist).

### 1.3 Codex CLI — *AGENTS.md spec* + sandbox/approvals model

`codex-rs/core/prompt_with_apply_patch_instructions.md` formalises the
`AGENTS.md` convention:

> Repos often contain AGENTS.md files… For every file you touch in the
> final patch, you must obey instructions in any AGENTS.md file whose
> scope includes that file. More-deeply-nested AGENTS.md files take
> precedence in the case of conflicting instructions. Direct
> system/developer/user instructions take precedence over AGENTS.md
> instructions.

Codex also formalises a *preamble* (1–2 sentence "what I'm about to
do" message before tool batches) and a *planning tool* (`update_plan`)
with strict rules:

- Skip planning for the easiest ~25%.
- Do not make single-step plans.
- Update after completing each sub-task.
- Do not repeat plan contents after `update_plan` — the harness
  re-renders.

Codex's "goal continuation" template (`codex-rs/prompts/templates/
goals/continuation.md`) is the most rigorous *completion audit* I
have seen in any agent: it forces the model to re-derive requirements
from the objective and verify them against current state before
marking the goal done. Worth borrowing wholesale for unattended runs.

### 1.4 Cline — YOLO mode for unattended runs

`sdk/packages/shared/src/prompt/system.ts` ships two prompts. The
`YOLO_CLINE_SYSTEM_PROMPT` is the one for "background agent
investigating a reported issue":

> Your goal is to utilize the tools at your disposal to investigate
> and answer the question according to user's instructions with the
> aim to verify that the issue is resolved.
>
> - When the user describes a bug … your primary goal is to produce a
>   correct fix in the source code that resolves the issue.
> - A correct fix means the underlying behavior is fixed — not just
>   the symptoms addressed superficially.
> - After applying your fix, you must run the relevant test suite to
>   confirm your changes actually resolve the problem. If tests
>   fail, analyze the failures, revise your fix, and re-run until
>   tests pass.
> - Do not consider the task complete until the test suite related to
>   the files you have touched passes.
> - Always includes tool calls in your response until the task is
>   completed. You should only end the task when all the requirements
>   are met by calling the `submit_and_exit` tool.

This matches Hermes exactly: the operator is *not* in the loop, so
the prompt must (a) force verification and (b) define an explicit
termination signal.

### 1.5 Aider — *overeager_prompt* and *lazy_prompt*

`aider/coders/base_prompts.py` has two short reminders that
consistently move model behaviour:

- `lazy_prompt`: "You are diligent and tireless! You NEVER leave
  comments describing code without implementing it! You always
  COMPLETELY IMPLEMENT the needed code!"
- `overeager_prompt`: "Pay careful attention to the scope of the
  user's request. Do what they ask, but no more. Do not improve,
  comment, fix or modify unrelated parts of the code in any way!"

`overeager_prompt` is directly relevant to PR review quality — a
background agent that drifts produces unreviewable PRs.

### 1.6 OpenHands — task-class templates

`openhands/app_server/integrations/templates/suggested_task/*.j2` —
task-class-specific prompts for *exactly* the auto-amend scenarios
Hermes already supports:

- `failing_checks_prompt.j2`: "fetch PR details with $GITHUB_TOKEN,
  diff against base, look at failing CI checks, reproduce locally,
  push, sleep 30s, recheck."
- `unresolved_comments_prompt.j2`: "fetch the PR comments, address
  anything that hasn't been addressed, commit back to the same
  branch."
- `merge_conflict_prompt.j2`: "check out PR branch, look at base diff
  to understand intent, walk commit history to resolve."

OpenHands also ships a `summary_prompt.j2` that asks the model to
self-audit its final message — "whether the request has been
completely addressed, whether the changes are concise, whether
extraneous changes have been reverted."

### 1.7 Common patterns across all of the above

| Pattern | Devin | Claude Code | Codex | Cline | Aider | OpenHands |
|---|---|---|---|---|---|---|
| Explicit "do not amend / force-push" rules | ✅ | ✅ | ✅ | — | — | — |
| Branch-name convention baked in | ✅ | — | — | — | — | ✅ |
| Default to *no comments* unless asked | ✅ | ✅ | ✅ | — | — | — |
| "Mimic existing conventions" | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| "Check the lib exists in `package.json` first" | ✅ | ✅ | — | ✅ | — | — |
| AGENTS.md / CLAUDE.md / repo-instructions loader | — | ✅ (CLAUDE.md) | ✅ (AGENTS.md) | — | ✅ (CONVENTIONS.md) | — |
| Test-after-edit loop until green | — | ✅ | — | ✅ (YOLO) | — | ✅ |
| Self-audit / completion check before "done" | — | — | ✅ | — | — | ✅ |
| Task-class prompt fragments (CI fail / review / conflict) | — | — | — | — | — | ✅ |
| Auto-allow tool rules (no permission prompts) | — | — | ✅ | ✅ | — | ✅ |

---

## 2. Gaps in `hermes-control-plane`

Cross-referenced against §0 above.

### G1. `renderContextPackage()` has no behavioural rules

The prompt today is purely descriptive (project / repo / branch /
task). The model gets zero guidance about:

- Not adding speculative comments / refactors.
- Mimicking existing conventions before editing.
- Verifying changes (running tests/lint) before claiming done.
- Not committing secrets / .env files.
- Not force-pushing or changing git config.

The runner does push + open PR itself, so *some* of the git rules
don't need to be in the prompt — but the *editing discipline* rules
absolutely do, because they show up in the PR diff that the operator
then has to review.

### G2. Amend-mode preamble is one short paragraph

`sandbox-runner.ts:294` says only "do not open a new PR". It does
not tell the agent to:

- Read the PR description + the reviewer comment / failing-check
  output that triggered this amend session.
- Diff against base branch to understand the existing PR's intent.
- Keep the change *narrow* — only address the specific feedback /
  failure, not "improve" adjacent code.
- Treat the existing PR commits as someone else's work (don't revert
  them).

OpenHands' three suggested-task templates exist precisely because
"address review feedback" and "fix failing CI" need different
instructions than "implement a feature from scratch". Hermes
collapses both into the same amend preamble.

### G3. No task-class differentiation in the trigger payload

`auto-amend` is triggered by two webhook event classes
(`pull_request_review.changes_requested` and
`check_run.failure/timed_out`, see ROADMAP §13.3) but the runner
gets the same prompt for both. We *know* which trigger fired —
`pr.autofix.triggered` carries the reviewer login or check name in
its payload (see `references/event-payloads.md`). We could pass
that distinction to the agent.

### G4. No AGENTS.md / CLAUDE.md loader

`profile.agentsContext` is a *Hermes-side* configured string per
project profile. But repos increasingly ship `AGENTS.md` (Codex
convention) or `CLAUDE.md` (Claude Code convention) or
`CONVENTIONS.md` (Aider convention) inside the repo itself. Today
Hermes ignores those. The clone already has them on disk; opencode
may or may not pick them up depending on its agent config.

### G5. No commit-message / PR-body authoring guidance

`runPrCreation()` uses a fixed title (`Hermes: <taskDescription>`)
and a fixed body ("Automated PR created by hermes-control-plane.").
The agent never gets a chance to write a real PR description even
though it knows the full diff and rationale. Claude Code's
`#### Summary` + `#### Test plan` template is a good baseline.

### G6. No completion-audit / "verify before done" loop

`agent.done` is emitted unconditionally after `session.prompt`
returns (`sandbox-runner.ts:333`). There is no instruction to the
model that says "before saying you are done, re-read the task and
verify". This matters most for unattended runs (Hermes' whole
model) — the operator only sees the PR, so a sloppy
"good enough, claiming done" turn costs an entire review cycle.

Codex's `goals/continuation.md` ("Completion audit" section) is the
strongest version of this pattern I found and is borrowable
verbatim.

### G7. No "do not modify unrelated code" rule

The current PR review workflow assumes the operator catches scope
creep at review time. In practice that wastes reviewer cycles.
Aider's `overeager_prompt` is a one-liner that measurably reduces
scope drift in similar setups.

---

## 3. Proposed updates

Sized small → large. Each is independent.

### P1. Rewrite `renderContextPackage()` with a baseline rules block (S, ~30 LOC)

Replace the descriptive-only template at `src/worker/session-do.ts:519`
with one that adds a short *Working Rules* section. Draft text below
— deliberately short, declarative, and only covering things the
runner can't enforce itself. (Git / push / config rules are *not*
included because the runner handles those; the agent doesn't push.)

```md
# Hermes Task Context

## Project: <name>
## Repository: <repoUrl>
## Branch: <branch>

## Task
<taskDescription>

## Working Rules

You are running unattended inside an ephemeral sandbox. No human
will answer questions or grant permissions mid-run. The control
plane will open a pull request from your final diff for human
review. Optimise for a PR that is easy to review.

- Stay in scope. Touch only what the task requires. Do not refactor,
  reformat, or "improve" adjacent code, comments, imports, or
  formatting. Every changed line should trace to the task.
- Match the existing style. Before editing a file, read enough of it
  (and its neighbours / imports) to copy its conventions — naming,
  typing, error handling, test layout. Do not introduce a new
  library, framework, or pattern unless the task explicitly asks.
- Verify libraries exist. Before using a package, confirm it is
  already in `package.json` / `pyproject.toml` / `go.mod` / etc.
  Do not invent imports.
- Do not add speculative comments. Only add comments where the
  logic is not self-evident. Never leave TODOs in committed code
  unless the task asks for them.
- Verify your work. After editing, run the project's test/lint/build
  commands when they exist. If tests fail, fix the cause; do not
  weaken or skip the test unless the task explicitly says so.
- Never commit secrets. Refuse to write `.env`, credentials, tokens,
  or private keys into the repo even if asked.
- Stop cleanly. When the task is complete, end the turn. Do not
  open a new PR or push (the control plane handles that).

## Project Instructions   (optional, from profile.agentsContext)
...

## Repo Instructions      (optional, see P4 below)
contents of AGENTS.md / CLAUDE.md / CONVENTIONS.md at repo root
```

Why this is safe: it adds tokens but not state. Rollback is a single
commit. Failure mode is "agent ignores rules", which is the current
behaviour.

### P2. Differentiate amend-mode preamble by trigger (M, ~40 LOC)

Pass the auto-amend trigger metadata into the sandbox env and branch
the amend preamble on it. Concretely:

- Worker side (`session-do.ts` autofix dispatcher): pass
  `triggerKind = "review_changes_requested" | "ci_failure" | "manual_followup"`
  and the trigger details (reviewer login + comment, or failing check
  name + log excerpt) into the launcher request.
- Launcher (`provision.ts`): forward as `CONTROL_PLANE_AMEND_TRIGGER_*`
  env vars.
- Runner (`sandbox-runner.ts:288`): pick one of three preambles
  modelled on OpenHands' three suggested-task templates:

  - `review_changes_requested`: paste reviewer name + comment +
    location, instruct agent to address *only* the comment and not
    re-litigate adjacent code.
  - `ci_failure`: paste failing check name + last N lines of log,
    instruct agent to reproduce locally before patching, then run the
    same check.
  - `manual_followup`: today's "continue work on existing PR" text.

Why this is safe: same shape as the existing amend env vars, gated by
`CONTROL_PLANE_AMEND_TRIGGER_KIND`; if absent, behaviour is unchanged.

### P3. Borrow Codex's completion-audit clause for unattended runs (S, ~15 LOC, prompt-only)

Append to the Working Rules section above:

> ## Before you finish
>
> Before you stop, re-read the task description and verify, against
> the current state of the worktree, that every requirement has been
> implemented. Treat the task as unproven until you have inspected
> the relevant files / run the relevant commands. Do not redefine
> success around what is easy to ship; if you cannot finish a
> requirement, say so explicitly in your final message so the
> reviewer is not surprised.

Pairs naturally with P5 below (model-authored PR body).

### P4. Auto-include repo-level `AGENTS.md` / `CLAUDE.md` (M, ~30 LOC, runner-side)

After clone (`provision.ts` step 3), have the runner read up to ~8 KB
of `AGENTS.md` (preferred) or `CLAUDE.md` or `CONVENTIONS.md` from
the repo root and append it to the context package as
`## Repo Instructions` (Codex-style precedence: repo-instructions
override profile-instructions only when there is no conflict; the
task itself always wins).

Implementation note: this is *not* the same as opencode's
per-directory agent context loader — we want the file content visible
to *our* logging too (so reviewers can see why the agent did what it
did) and we want a hard size cap so a 200 KB AGENTS.md doesn't blow
the context budget.

### P5. Let the agent author the PR title + body (M, ~50 LOC)

Today: `runPrCreation()` hardcodes title + body. Proposal:

- Add a second `agent.prompt`-like phase after the first turn
  completes but before push — a 1-shot "write the PR title and body
  for the diff you just produced" call. Constrain the body to a
  fixed template:

  ```
  ## Summary
  <1-3 bullets, what changed and why>

  ## Verification
  <commands run + what passed>

  ## Out of scope / Follow-ups
  <anything intentionally not done>

  ---
  _Opened by hermes-control-plane. Session <id>._
  ```

- Validate the response against the template; on parse failure, fall
  back to today's title + body (zero regression).

- For amend mode, instead of a new PR body, post the same template as
  a *PR comment* on the existing PR via REST so reviewers see exactly
  what changed in this amend pass.

Why this is worth doing: the PR description is the single artefact
the operator reads first, and the agent has the diff in context for
free. Today the operator clicks through to the file diff with no
narrative.

### P6. Surface scope drift in the diff (L, optional)

Lightweight static check after `agent.done`: compute the set of
changed file *paths* and emit `git.diff.summary` events grouped by
top-level directory. Useful as a telemetry trail; out of scope for
the first round.

### P7. Document the prompting contract (S, doc-only)

Add a section `§16 Agent prompting contract` to `docs/ROADMAP.md`
(or a new `docs/AGENT-PROMPT.md`) capturing:

- Layer 1 — control-plane baseline rules (P1).
- Layer 2 — profile-level instructions (`profile.agentsContext`).
- Layer 3 — repo-level `AGENTS.md` (P4).
- Layer 4 — per-task amend trigger fragment (P2).
- Precedence order (task ⟶ profile ⟶ repo ⟶ baseline).

So future contributors know *where* to add a new rule and which
layer it affects.

---

## 4. Non-goals / things we deliberately should NOT borrow

- **Devin's `<think>` scratchpad.** Opencode already supports
  reasoning tokens; reinventing it as XML inside the prompt would
  fight the SDK.
- **Devin's "ask the user for git push failures."** Hermes has no
  in-loop user; the runner must fail closed (already does).
- **Claude Code's "NEVER commit unless asked."** The Hermes contract
  is the *opposite*: the runner always commits and opens a PR. Do
  not import this rule — it would silently break the product.
- **Cursor's hidden chain-of-thought XML scaffolding.** Not portable;
  opencode handles structured tool calls natively.
- **Aider's SEARCH/REPLACE block format.** Opencode uses its own
  tool-call format; do not graft Aider's diff format on top.

---

## 5. Recommended sequencing

1. **P1** (baseline rules in `renderContextPackage`) — tiny, safe,
   measurable. Land first.
2. **P3** (completion audit clause) — appends to P1, ship together
   if reviewer is happy.
3. **P7** (doc the contract) — codifies what P1/P3 introduced.
4. **P4** (AGENTS.md loader) — independent, ~30 LOC, useful for any
   repo that already ships an AGENTS.md.
5. **P2** (differentiated amend preamble) — needs a small webhook
   payload change; do once P1/P3 have bedded in so we can measure
   the marginal effect.
6. **P5** (model-authored PR body) — biggest behavioural change, do
   last so we can compare PR review-time before/after.
7. **P6** — defer until we have a real signal that scope drift is a
   recurring reviewer complaint.

---

## 6. References (raw)

- Devin AI / Cognition — leaked prompt:
  `github.com/x1xhlol/system-prompts-and-models-of-ai-tools` →
  `Devin AI/Prompt.txt`.
- Anthropic Claude Code 2.0:
  `Anthropic/Claude Code 2.0.txt` (same repo).
- OpenAI Codex CLI:
  `github.com/openai/codex` →
  `codex-rs/core/prompt_with_apply_patch_instructions.md`,
  `codex-rs/core/gpt_5_codex_prompt.md`,
  `codex-rs/prompts/templates/goals/continuation.md`.
- Cline:
  `github.com/cline/cline` →
  `sdk/packages/shared/src/prompt/system.ts`
  (`YOLO_CLINE_SYSTEM_PROMPT`).
- Aider:
  `github.com/Aider-AI/aider` →
  `aider/coders/base_prompts.py` (`lazy_prompt`, `overeager_prompt`),
  `aider/coders/editblock_prompts.py`.
- OpenHands:
  `github.com/All-Hands-AI/OpenHands` →
  `openhands/app_server/integrations/templates/suggested_task/*.j2`,
  `…/resolver/github/*.j2`,
  `…/resolver/summary_prompt.j2`.

---

## 7. Git / PR authority model — additional proposals

Follow-up to a 2026-06-26 discussion: "should the coding agent be free
to use git and open PRs itself, or do we keep the dedicated endpoint?"

### 7.1 Two industry models

**Model A — agent owns git + `gh`** (Claude Code, Codex CLI, Devin,
Cursor Agent).  Agent has shell + `git` + `gh` binaries, decides when
to commit / push / open PR.  Guardrails live in the prompt and the
sandbox.  Foreground / human-in-the-loop.  Auth = user's local
`gh auth`.

**Model B — control plane owns side effects** (GitHub Copilot Coding
Agent, Sweep, OpenHands resolver, Codex Cloud, Hermes today).  Agent
has git locally but no credentials to `origin`.  Push + PR creation
go through a dedicated control-plane endpoint.  Background /
unattended.  Auth held by the plane, never exposed to the model
context.

Both are valid.  The split is driven by 3 system requirements, not
by "is the agent good at git":

| Requirement | Foreground (A) | Background (B) |
|---|---|---|
| Who owns the consequence if a PR is wrong? | User reverts immediately | Plane — PR is public, other reviewers read it |
| Where does the token live? | User's machine (`gh auth`) | Plane secret store; must NOT leak into model context |
| Need idempotency? | No (user retries by hand) | Yes — webhook retry, double-trigger amend, race PR-vs-followup |
| Need branch protection "PR author ≠ reviewer"? | User IS author → OK | A bot token fails the rule → must author as the real user |
| Need lifecycle observability? | No | Yes — webhook, archive, autofix cap |

Hermes sits squarely in column B.  That is why `runPrCreation` should
NOT be handed over to the agent.

### 7.2 The actual best practice (synthesised from §7.1)

Rule of thumb across Copilot Coding Agent, Sweep, OpenHands resolver,
Cosine:

- **Read git**: ✅  (`git log`, `git diff`, `git blame`, `git show`)
- **Mutate the worktree via git**: ✅  (`git checkout -b feature`,
  `git add`, `git commit`)
- **Talk to `origin`**: ❌  (`git push`, `git fetch origin`,
  `gh pr create`, `gh pr merge`, `git remote set-url`)

Every side effect against `origin` goes through one code path, with
audit log, idempotency key, and safe retry semantics.

Hermes is mostly there but has two gaps:

- `GITHUB_USER_TOKEN` is baked into the cloned repo's `.git/config`
  (`src/launcher/provision.ts:119`).  An agent that `cat .git/config`
  sees a write token.  Works for MVP; not the long-term shape.
- `runPrCreation` runs *inside the sandbox* (`src/runner/sandbox-
  runner.ts:346`).  It uses the same token to call `git push` and
  `POST /pulls`.  Moving it to the launcher (outside the sandbox)
  removes the need to ever expose the write token to sandbox code.

### 7.3 P8 — Move `runPrCreation` from runner to launcher endpoint  (M, ~80 LOC)

Today: runner code (running inside the sandbox) calls `git push` and
`POST /pulls` directly.

Proposed shape:

```
runner → emit  ready_to_publish { branch, commitSha, title, body }
launcher → POST /sessions/:id/publish-pr
   1. verify session state (must be ready_to_publish, not already published)
   2. resolve PR-author token from plane secret store
   3. git push (short-lived token, never written to sandbox .git/config)
   4. if amend: re-emit pr.updated; else: POST /pulls + emit pr.created
   5. update PrIndexDurableObject in the same RPC
```

Why this is worth doing:

- The PR-author token never enters the sandbox.  An agent (or a
  compromised sub-tool the agent invoked) cannot exfiltrate it.
- Single code path for both fresh-PR and amend-PR flows; today they
  share most of `runPrCreation` but each has its own special-case
  branches (`amendMode`, `cmpBase`, etc.).
- Testable without spinning E2B — mock the launcher endpoint.

What stays the same:

- Runner still does `git add`, `git commit`, and `git diff` locally.
  The agent's commits are real commits authored in the sandbox; only
  the push is proxied.
- `PrIndexDurableObject` is still the source of truth for "this PR
  belongs to session X".
- Webhook lifecycle (`pull_request.merged` → archive, etc.) is
  unchanged.

Migration:

1. Add launcher endpoint `POST /sessions/:id/publish-pr`.  Initially
   it just forwards to the existing in-sandbox `runPrCreation` code
   path via the runner WS — zero behaviour change.
2. Move git-push + REST `POST /pulls` from `sandbox-runner.ts` to a
   new `src/launcher/publish.ts`.  Runner now only computes `{branch,
   commitSha, title, body}` and emits `ready_to_publish`.
3. Switch token plumbing: launcher reads `GITHUB_USER_TOKEN` from its
   own env (already does), runner's `.git/config` is rewritten to use
   a *read-only* clone token (P9 below).
4. Update tests + e2e scripts.

Rollback: feature-flag at the launcher (`HERMES_PUBLISH_VIA_LAUNCHER`,
default false) so old + new paths coexist for one release.

### 7.4 P9 — Lock down `origin` push permission inside the sandbox  (S, ~10 LOC, depends on P8)

Once P8 has landed:

- Provision-time `git remote set-url origin <https-url-with-RO-clone-token>`
  instead of the write token (`provision.ts:119`).
- Strip `GITHUB_USER_TOKEN` from the runner's start.json — runner does
  not need it any more.
- Result: `git push origin` from inside the sandbox fails with 403.
  The only path to `origin` is the launcher's `publish-pr` endpoint.

Risk: zero behaviour change for the happy path (push goes via P8
endpoint).  Failure mode: an agent that tries to `git push` directly
gets a clean 403 instead of a silent success — strictly safer.

Open question: read-only clone token shape.  Either (a) a separate
fine-grained PAT scoped `Contents: Read` on the target repo, or (b)
GitHub's `git-upload-pack`-only OAuth flow.  (a) is simpler; (b) is
what GitHub Copilot Coding Agent uses internally.  Decide at
implementation time.

### 7.5 P10 — Let the agent suggest a `branchSuffix`  (S, ~15 LOC)

Today: branch = `hermes/<8-char-session-id>` (`provision.ts:140`).
Predictable prefix is load-bearing — the webhook router matches on
it to route GitHub events back to the right DO.

But the 8-char id portion is opaque to reviewers.  GitHub's branch
picker shows `hermes/a3f9b2c1` and the reviewer has no idea what's
in it.

Proposal:

- Add an optional `branchSuffix` field to `start_coding_task` MCP
  tool + `POST /sessions` body.  Hermes (the orchestrating agent on
  the host side) derives it from the task description ("add rate
  limit middleware" → `add-rate-limit-middleware`).
- Launcher branch = `hermes/${suffix ?? "task"}-${4charId}` if
  suffix is supplied, else today's behaviour.
- Validate: `^[a-z0-9-]{1,40}$`, else fall back to default.

Why not have the in-sandbox agent suggest the suffix?  Because the
branch is created at provision time — *before* the agent has run.
Letting the host-side agent (Hermes) suggest it is the right
abstraction layer; it already has the task description.

Skill update (separate, tiny): `skills/hermes-control-plane/SKILL.md`
section "Resolve the GitHub repo URL" gains a step "Derive a short
slug from the task description and pass as `branchSuffix`."

### 7.6 Sequencing — updated

Original sequence from §5 was P1 → P3 → P7 → P4 → P2 → P5 → P6.
Updated to interleave the new authority-model proposals:

1. **P1** — baseline rules in `renderContextPackage` (prompt only)
2. **P3** — completion-audit clause (prompt only)
3. **P7** — document the prompting contract (doc only)
4. **P10** — `branchSuffix` (smallest of the new batch; no runner
   changes, just launcher + MCP shape)
5. **P4** — auto-include repo-level `AGENTS.md`
6. **P2** — differentiated amend preamble
7. **P8** — move PR creation to launcher endpoint (biggest refactor;
   land alone)
8. **P9** — lock down sandbox-side push (one-line follow-up to P8)
9. **P5** — agent-authored PR body (lands on top of P8 — agent's
   `ready_to_publish` payload gets a real `body`)
10. **P6** — diff scope-drift telemetry (defer until needed)

Rationale for ordering: prompt-only changes (P1/P3) ship first
because they are reversible in one commit and let us measure
behavioural impact before structural refactors.  P8 is gated until
after P5's design is firm, because the `publish-pr` endpoint shape
is easier to lock in once we know what payload the agent will emit.

### 7.7 What we deliberately do NOT change

- The runner still computes the diff and does `git add` / `git
  commit` inside the sandbox.  We are not switching to a
  "patch-only" model (Sweep-style) — too disruptive, and opencode
  doesn't naturally emit unified diffs.
- The agent still has read access to `git log` / `git show` /
  `git blame`.  These are pure local operations and are useful for
  the agent to understand history before editing.
- The webhook → amend lifecycle (ROADMAP §13.3) is untouched.  P8
  changes *where* the push happens, not *when* a new session is
  spawned.
