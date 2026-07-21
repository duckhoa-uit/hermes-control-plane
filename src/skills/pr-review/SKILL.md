---
name: pr-review
description: Review a caller-supplied PR diff and context snapshot for concrete correctness, security, and regression risks. Use when the bounded snapshot is already available; do not fetch GitHub data, publish comments, approve the PR, or implement fixes.
---

# PR review

# PR review

Review only the supplied repository, PR number, base/head SHAs, diff, and
context. The caller is responsible for fetching and bounding that snapshot;
this workflow has no GitHub write tools and must not invent unseen files.

## Review method

1. Confirm that the supplied `headSha` is the revision being reviewed.
2. Read the diff once for intent and changed surfaces, then inspect each
   changed hunk for correctness, security, data-loss, concurrency, and
   compatibility regressions.
3. Prefer a small number of high-signal findings over exhaustive commentary.
4. A finding must be introduced by the diff, have a concrete trigger, and be
   actionable by the author. Do not report style preferences or speculative
   risks unsupported by the snapshot.

## Finding contract

For every finding include:

- `path`, `startLine`, and `endLine` from the supplied diff;
- `severity`: `critical` for an exploitable or release-blocking defect,
  `high` for a likely production failure or security issue, `medium` for a
  material correctness/regression risk, and `low` for a bounded minor defect;
- `confidence`, concise `title`, and a body explaining the trigger and impact.

Use `approve` only when no actionable finding remains. Use
`changes_requested` when at least one actionable defect is present. Use
`comment` when the review has useful observations but no blocking defect.

If the diff, line mapping, or repository context is insufficient, return no
speculative finding and explain the missing evidence in the summary.

## Hard boundaries

Never modify files, call GitHub, publish comments, approve a PR, push a branch,
or create a PR. Return only the structured review result requested by the
workflow contract.
