---
name: control-plan-coding-task
description: Implement and verify one task-bound repository change in the provisioned Control Plan sandbox. Use only when a coding task supplies a repository, branch, prompt, and acceptance criteria; do not use this skill for PR review, Sentry triage, direct push/PR operations, or unrelated cleanup.
---

# Control Plan coding task

Use this procedure for the coding task supplied by the Control Plane. The
Control Plane owns publication, credentials, approval policy, and the final
commit/PR boundary.

1. Read `AGENTS.md` and the relevant repository skills. Treat them as project
   guidance, while keeping the Control Plane's security and branch rules
   authoritative.
2. Inspect the repository structure, current implementation, and existing
   tests before editing.
3. Make the smallest change that satisfies the task. Avoid unrelated cleanup
   and do not change deployment or publication behavior unless the task asks
   for it.
4. Run the repository-native formatter, type checker, linter, and focused tests
   that apply to the changed code. Run the broader test suite when practical.
5. Review `git diff`, `git status`, and the verification output. Check that no
   credentials, generated artifacts, or unrelated files are included.
6. Call `finalize_change` only when the implementation is ready for the
   Control Plane to create the commit and optional pull request. Use the exact
   task branch and base branch from the task context.

If verification fails, fix the issue when it is in scope. Otherwise report the
failure and stop without calling `finalize_change`.

## Completion contract

Before finalization, report the checks that ran and their outcomes. Use
`finalize_change` only for a verified implementation that should be published.
If the requested behavior already exists, or the task is blocked by missing
requirements or failed checks outside the task scope, stop and report that
condition without publishing a speculative change.
