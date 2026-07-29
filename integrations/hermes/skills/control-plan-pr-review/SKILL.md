---
name: control-plan-pr-review
description: Run a read-only Control Plan PR review after Hermes has fetched a complete bounded diff and exact base/head SHAs. Use for review findings only; this workflow never comments, approves, pushes, edits files, or creates a coding task.
version: 1.0.0
author: duckhoa-uit
license: MIT
metadata:
  hermes:
    tags: [pull-request, review, github, control-plane]
    requires_tools:
      - mcp__control_plan__start_pr_review
      - mcp__control_plan__get_specialist_workflow
---

# Control Plan PR Review

Use this skill when Hermes needs an isolated, read-only review of a GitHub
pull request. This workflow is separate from coding delegation and never edits
or publishes code.

## Gather the snapshot before calling MCP

Control Plan does not fetch GitHub for this workflow. Resolve the repository and
PR context first:

1. Use the explicit `owner/repo` and PR number from the request, issue, or
   current GitHub context.
2. If Hermes is in a Git worktree with a current PR context, use read-only Git
   commands and the GitHub integration to obtain the exact base and head SHAs.
3. Fetch the complete bounded unified diff for those exact SHAs. If the PR head
   changes, discard the snapshot and start again.
4. Include only relevant code context and metadata. Remove secrets, cookies,
   tokens, and unrelated repository data.

If repository, PR number, exact SHAs, or a complete bounded diff is missing,
do not start the workflow. Gather the missing snapshot or report the blocker.

## Required snapshot

- `repository`: GitHub `owner/repo`, never a URL.
- `pullRequest`: positive PR number.
- `baseSha` and `headSha`: the exact commits used to generate the diff.
- `diff`: complete bounded unified diff, at most 200,000 characters.
- `context`: optional relevant metadata or code context, at most 50,000
  characters and without credentials.

If the complete diff is larger than the limit, do not silently pass only an
arbitrary prefix. Narrow the review scope explicitly or tell the operator that
the snapshot is incomplete.

## Procedure

1. Call `mcp__control_plan__start_pr_review` once with the snapshot. Save its
   `runId`; the start response is not the review result.
2. While `terminal=false`, wait `pollAfterMs` and call
   `mcp__control_plan__get_specialist_workflow` with the saved `runId`. Do not
   start another run merely because the current run is active.
3. When `terminal=true`, verify the response is for workflow `pr-review`.
   - For `status=completed`, report the structured `verdict`, `summary`, and
     findings, and verify `reviewedHeadSha` equals the requested `headSha`.
   - For `status=errored`, report the error and do not invent review findings.
4. Keep findings attached to the supplied snapshot. Re-fetch and start a new
   review if the PR head changes.

## Safety

- Never claim that this workflow posted a GitHub review or comment.
- Never call the coding delegation workflow implicitly. If the operator asks
  to implement a finding, treat that as a separate coding task with explicit
  acceptance criteria.
- Do not include tokens, private keys, cookies, or unrelated repository data
  in `diff` or `context`.
