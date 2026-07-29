---
name: control-plan-delegation
description: Delegate a known implementation or bug-fix task to Hermes Control Plan when the repository, root cause, and acceptance criteria are available. Use for asynchronous coding work that may produce a task branch or PR; do not use for read-only PR review, Sentry triage, or status-only questions.
version: 1.2.0
author: duckhoa-uit
license: MIT
metadata:
  hermes:
    tags: [coding, delegation, github, control-plane]
    requires_tools:
      - mcp__control_plan__spawn_coding_task
      - mcp__control_plan__get_coding_task
      - mcp__control_plan__respond_coding_approval
      - mcp__control_plan__cancel_coding_task
---

# Control Plan Delegation

Use this skill when Hermes has a coding or bug-fix request that should be
implemented by the Control Plan coding agent in a task-bound Sandbox. This
skill owns input discovery and the remote task lifecycle; it does not replace
the coding agent, perform the code change locally, or prove completion from the
initial dispatch response.

## Delegation boundary

Once this skill is selected for an implementation task:

- do not edit, delete, move, commit, or test implementation files in the local
  repository;
- do not run a parallel local coding workflow for the same request;
- use the Control Plan MCP tools and let the task-bound coding agent work in its
  Sandbox and branch;
- local read-only inspection is allowed to resolve repository context and
  gather bounded evidence before spawning.

## Resolve inputs before spawning

### Repository

Resolve `repository` in this order:

1. Use an explicit GitHub `owner/repo` from the user, issue, Linear context,
   or project context.
2. If Hermes is operating in a Git worktree and no repository was supplied,
   read the `origin` remote with `git remote get-url origin` and normalize
   GitHub URLs such as `https://github.com/owner/repo.git` or
   `git@github.com:owner/repo.git` to `owner/repo`.
3. If no GitHub repository can be resolved, ask for it before spawning. Never
   pass a URL to the MCP tool and never guess an owner or repository name.

### Base branch

Resolve `baseBranch` in this order:

1. Use an explicit branch from the request or issue context.
2. Read the current remote default branch with
   `git symbolic-ref --short refs/remotes/origin/HEAD` and remove the
   `origin/` prefix.
3. If the branch is still unknown, omit `baseBranch` and let Control Plan use
   the GitHub repository default. Do not guess `main` or `master`.

### Task prompt

Build a self-contained `task` prompt that includes:

- the observed issue and relevant evidence;
- files, modules, or symbols already identified;
- the requested behavior change;
- acceptance criteria and non-goals;
- repository-specific checks to run;
- whether a draft PR is expected.

Do not send a vague prompt such as "fix the backend" when the available
context can make the task more precise. Do not include credentials, cookies,
signed URLs, or unbounded logs. If the root cause or acceptance criteria are
not known, gather read-only evidence or ask the operator before spawning.

### Idempotency key

`idempotencyKey` is optional. Do not ask the user for one in the normal flow.

- If the request has a stable external ID, pass a traceable key such as
  `github:issue:<owner>/<repo>#<number>`, `linear:<identifier>`,
  `incident:<provider>:<id>`, or `run:<id>`.
- If no stable external ID exists, omit `idempotencyKey`. Control Plan
  deterministically derives one from the normalized task and resolved base
  branch.
- Never generate a random UUID or timestamp key for a normal task.
- For a transport or capacity retry, reuse the exact same inputs and key. If
  the first request omitted the key, omit it again so Control Plan derives the
  same key.
- Use a different external key only for a genuinely different task, not to
  evade `idempotency_conflict`.

## Procedure

1. Call `mcp__control_plan__spawn_coding_task` exactly once for one logical
   task after resolving the inputs above. Save the returned `taskId`, `branch`,
   and `replayUrl`. Reuse the same inputs and `idempotencyKey` for a transport
   or capacity retry; never create a random retry key.
2. If spawn returns `capacity_exceeded`, wait at least its `retryAfterMs` and
   retry with the identical inputs and idempotency key. If it returns
   `idempotency_conflict`, stop and correct the repository, task, or key rather
   than creating another run.
3. Follow the response's `lifecycle` object instead of inferring progress from
   a state name:
   - `terminal=false`, `nextAction=poll`: wait `pollAfterMs`, then call
     `mcp__control_plan__get_coding_task` with the saved `taskId`.
   - `terminal=false`, `nextAction=respond_to_approval`: select the pending
     approval from `approvals`, pass its `id` as `approvalId` to
     `mcp__control_plan__respond_coding_approval`, then resume polling.
   - `terminal=true`, `nextAction=report`: stop polling and report the result.
4. For an approval, request `decision=once` unless the operator explicitly
   denies it. A non-deny request is not approval by itself: wait for native
   Hermes form-mode elicitation and use its accept/decline result.
5. On a terminal response, report `state`, `outcome`, summary/error,
   `blockedReason`, verification commands, branch, commit SHA, and PR
   URL/number when present. `completed + no_change` is a valid success;
   `failed + blocked` is an expected blocked outcome; `cancelled` is terminal.
   The replay URL is diagnostic evidence, not proof of completion.
6. Use `mcp__control_plan__cancel_coding_task` only when cancellation is
   explicitly required or the operator timeout is reached. Follow the returned
   lifecycle until terminal; `publishing` and `cancellation_requested` remain
   active states.

## Do not use this skill for

- Reviewing a supplied PR diff without changing the repository; use the PR
  review workflow instead.
- Classifying a supplied Sentry issue/event snapshot; use Sentry triage instead.
- A status-only request where no implementation task should be created.

## Idempotency and safety

- Treat an omitted `idempotencyKey` as intentional: Control Plan owns
  deterministic derivation from task and base branch.
- Never infer completion from the initial spawn response.
- Never treat a model-supplied approval decision as human approval; Control
  Plan enforces native Hermes elicitation for non-deny publication decisions.
- Never reuse one task ID for a different repository or prompt.
- Never create a second task while the saved task has `lifecycle.terminal=false`.
- Do not expose signed replay tokens in chat logs or issue comments.

## Verification checklist

Before reporting a published success, confirm:

- the task reached `completed` with `outcome=published`;
- the result branch belongs to the requested repository;
- a commit SHA is present and a PR URL is present when PR creation was requested;
- the coding agent's requested tests/checks are reflected in the final summary.
