---
name: control-plan-delegation
description: Delegate a known implementation or bug-fix task to Hermes Control Plan when the repository, root cause, and acceptance criteria are available. Use for asynchronous coding work that may produce a task branch or PR; do not use for read-only PR review, Sentry triage, or status-only questions.
version: 1.1.0
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

Use this skill after Hermes has triaged a root cause and the required fix must
be implemented in a GitHub repository by the Control Plan coding agent. This
skill orchestrates the remote task lifecycle; it does not replace the coding
agent, perform the code change, or prove that a task is complete by itself.

## Required inputs

Before spawning, identify:

- `repository`: `owner/repo`, never a URL;
- `baseBranch`: the branch to inspect, when it is known;
- `task`: a self-contained implementation prompt with acceptance criteria;
- `idempotencyKey`: a stable issue, incident, or run identifier.

Do not hardcode a repository in this skill. Project profiles supply the
repository and each task supplies its own prompt.

## Procedure

1. Call `mcp__control_plan__spawn_coding_task` for one logical task. Save the
   returned `taskId`, `branch`, and `replayUrl`. Reuse the same
   `idempotencyKey` for a transport or capacity retry; never create a random
   retry key.
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
