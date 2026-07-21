---
name: sentry-triage
description: Triage a caller-supplied Sentry issue, event, telemetry, and code-context snapshot into severity, actionability, evidence, likely root cause, and next action. Use when the bounded snapshot is already available; do not query or modify Sentry, run Seer, or publish code.
---

# Sentry triage

# Sentry triage

Use only the supplied organization, project, issue ID, event, telemetry, and
optional code context. The caller is responsible for fetching and bounding the
snapshot; this workflow has no Sentry credentials or code-publication tools.

## Triage method

1. Extract observed facts exactly as supplied: error, affected release,
   environment, frequency, users, stack frames, and relevant telemetry.
2. Separate hypotheses from evidence. Name the missing evidence that would
   change the diagnosis.
3. Estimate `severity` from user/business impact and `actionability` from how
   directly the supplied evidence supports a safe engineering next step. Do
   not use severity as a proxy for confidence.
4. State one likely root cause, the evidence supporting it, and the safest next
   action. If the evidence cannot support a responsible diagnosis, set
   `blockedReason` and use `unknown` where appropriate.

## Output contract

Always return evidence strings that point back to the supplied snapshot. Keep
the next action concrete: collect a missing signal, reproduce, roll back,
open a coding task, or perform another bounded investigation. Do not claim that
an issue was fixed or that a deployment occurred.

## Hard boundaries

Never query or modify Sentry, run Seer, edit a repository, open a PR, publish
code, or present a hypothesis as a confirmed root cause. Return only the
structured triage result requested by the workflow contract.
