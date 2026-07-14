---
name: control-plan-delegation
description: Delegate repository coding work to Hermes Control Plan and reconcile asynchronous execution safely.
version: 1.0.0
author: duckhoa-uit
license: MIT
---

# Control Plan Delegation

Use this skill after Hermes has triaged a root cause and the required fix must
be implemented in a GitHub repository by the Control Plan coding agent.

## Required inputs

Before spawning, identify:

- `repository`: `owner/repo`, never a URL;
- `baseBranch`: the branch to inspect, when it is known;
- `task`: a self-contained implementation prompt with acceptance criteria;
- `idempotencyKey`: a stable issue, incident, or run identifier.

Do not hardcode a repository in this skill. Project profiles supply the
repository and each task supplies its own prompt.

## Procedure

1. Call `mcp_control_plan_spawn_coding_task` exactly once with the inputs above.
   Save the returned `taskId`, `branch`, and `replayUrl`. If a retry is needed,
   reuse the same `idempotencyKey`; never create a random retry key.
2. Treat `state=created`, `dispatching`, `dispatched`, and
   `cancellation_requested` as non-terminal states. In particular,
   `dispatched` means Flue accepted the asynchronous work; it does not mean
   the task is stuck, failed, or complete.
3. Call `mcp_control_plan_get_coding_task` with the saved `taskId` every
   10–20 seconds. Continue for the task timeout configured by the operator;
   do not spawn a duplicate while polling.
4. If the response contains a non-empty `approvals` list, call
   `mcp_control_plan_respond_coding_approval` for the matching `approvalId`.
   For a non-deny request, wait for the native Hermes approval elicitation and
   use the gateway's accept/decline result. Then resume polling.
5. Stop only when the response is `completed` or `failed`. Report the final
   state, summary/error, repository branch, commit SHA, PR URL/number, and
   relevant test results. The replay URL is for diagnostics and operator
   review, not proof of completion.
6. Use `mcp_control_plan_cancel_coding_task` only when cancellation is
   explicitly required or the operator timeout is reached. After cancellation,
   continue polling until the abort is reconciled or report the timeout.

## Idempotency and safety

- Never infer completion from the initial spawn response.
- Never treat a model-supplied approval decision as human approval; Control
  Plan enforces native Hermes elicitation for non-deny publication decisions.
- Never reuse one task ID for a different repository or prompt.
- Do not expose signed replay tokens in chat logs or issue comments.

## Verification checklist

Before reporting success, confirm:

- the task reached `completed`;
- the result branch belongs to the requested repository;
- a commit SHA or PR URL is present when publication was requested;
- the coding agent's requested tests/checks are reflected in the final summary.
