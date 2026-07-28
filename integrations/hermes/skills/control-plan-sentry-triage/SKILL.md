---
name: control-plan-sentry-triage
description: Run read-only Control Plan Sentry triage after Hermes has fetched a bounded issue event, telemetry, and relevant code context. Use to classify evidence and recommend a next action; this workflow never queries or modifies Sentry and never publishes code.
version: 1.0.0
author: duckhoa-uit
license: MIT
metadata:
  hermes:
    tags: [sentry, incident, triage, control-plane]
    requires_tools:
      - mcp__control_plan__start_sentry_triage
      - mcp__control_plan__get_specialist_workflow
---

# Control Plan Sentry Triage

Use this skill when Hermes already has the relevant Sentry snapshot. Control
Plan has no Sentry connector and cannot fetch missing issue data.

## Required snapshot

- `organization`, `project`, and `issueId`.
- `event`: bounded event/error payload, at most 100,000 characters.
- `telemetry`: bounded logs, traces, release, frequency, and environment data,
  at most 150,000 characters.
- `codeContext`: optional relevant code, at most 100,000 characters.

Remove credentials, session cookies, personal data that is not needed for
triage, and unrelated logs before calling the workflow.

## Procedure

1. Call `mcp__control_plan__start_sentry_triage` once with the bounded
   snapshot. Save its `runId`; the start response is not the triage result.
2. While `terminal=false`, wait `pollAfterMs` and call
   `mcp__control_plan__get_specialist_workflow` with the saved `runId`. Do not
   start a duplicate merely because the run remains active.
3. When `terminal=true`, verify the response is for workflow
   `sentry-triage`.
   - For `status=completed`, report `severity`, `actionability`, `rootCause`,
     evidence, `nextAction`, and `blockedReason` when present.
   - For `status=errored`, report the error and do not invent a root cause.
4. Distinguish evidence from inference. If the snapshot is insufficient, say
   what telemetry or code context is missing.

## Safety

- Never claim that this workflow resolved, assigned, commented on, or otherwise
  modified the Sentry issue.
- A coding recommendation is not authorization to create a coding task. Use
  `control-plan-delegation` only as a separate step when implementation is
  explicitly requested and the repository and acceptance criteria are known.
- Do not include secrets or unnecessary personal data in the snapshot.
