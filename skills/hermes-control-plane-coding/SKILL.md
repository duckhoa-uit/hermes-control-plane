---
name: hermes-control-plane-coding
description: Run a coding task in a sandbox; open a real GitHub PR.
version: 1.0.0
author: duckhoa-uit
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [github, sandbox, coding-agent, pull-request, e2b]
    category: devops
    related_skills: [github-pr-workflow, github-auth]
---

# Hermes Control Plane Coding Skill

Use the `hermes-control-plane` MCP server to spawn an isolated E2B sandbox,
run a background coding agent against a GitHub repo, and open a real pull
request authored by the operator. This skill is the orchestration layer:
it does NOT touch the repo on the local machine; the agent runs entirely
inside the sandbox and the result lands on GitHub as a PR for review.

## When to Use

- The user describes a concrete code change against a specific GitHub repo
  ("fix bug in login", "add /v1/health endpoint to acme/backend").
- The change is bounded — one feature, one bug, or a small refactor that
  fits in a single PR.
- The user wants a real PR they can review, not a local diff applied in
  the current conversation.

Do NOT use this skill when:

- The user is asking a question or wants an explanation — answer directly.
- The repo is local-only with no GitHub remote — use `terminal` + `patch`
  on the local checkout instead.
- The user wants to keep iterating live in the current conversation; this
  skill hands the task off to a separate sandbox and reports back.

## Prerequisites

- **MCP server `hermes-control-plane` configured** in `~/.hermes/config.yaml`.
  See <https://github.com/duckhoa-uit/hermes-control-plane/blob/main/infra/mcp/README.md>
  for install instructions. The user-side block looks like:

  ```yaml
  mcp_servers:
    hermes-control-plane:
      url: "http://localhost:8789/mcp"   # or your tunnel URL
      timeout: 300
  ```

- **GitHub App installed on the target repo** (one-time owner setup).
  The control plane's launcher mints short-lived installation tokens
  per session; the repo must show the app under Settings → Installations.

- **Operator's `GITHUB_USER_TOKEN` in the launcher env**
  (`/etc/hermes/launcher.env`). This is the PAT whose identity the PR
  will be authored by — required so branch-protection rules like "PR
  review by someone other than author" work.

## How to Run

The MCP server exposes four tools. The default flow uses
`start_coding_task` once, then either subscribes to the events stream or
polls `get_session_status`.

```text
1. Call start_coding_task with { taskDescription, repoUrl }.
2. Capture the sessionId and streamUrl from the response.
3. Subscribe to streamUrl (WebSocket) OR poll get_session_status every 5s.
4. On the pr.created event, post the PR URL back to the user.
5. If the user replies with follow-up changes, call send_followup_prompt.
6. On user "stop" / "cancel", call abort_session.
```

## Quick Reference

| Tool | Purpose | Required args |
|---|---|---|
| `start_coding_task` | Spawn sandbox + start agent | `taskDescription`, `repoUrl` |
| `get_session_status` | Poll status + check for `prUrl` | `sessionId` |
| `send_followup_prompt` | Append a follow-up prompt | `sessionId`, `text` |
| `abort_session` | Cancel + tear down sandbox | `sessionId` |

| Event the stream emits | What to do |
|---|---|
| `session.created` | (optional) reply "starting…" |
| `agent.message.delta` | Debounce 1 s, edit the running status reply |
| `tool.started` / `tool.completed` | Show `ran <tool>` (collapsed) |
| `pr.created` | Post the PR URL — this is the success signal |
| `session.failed` / `session.aborted` | Post the error message |

## Procedure

### 1. Resolve the GitHub repo URL

The user says "in acme/backend, add rate-limiting middleware". Resolve
`acme/backend` to a full HTTPS URL (`https://github.com/acme/backend`).
If the user gave only a slug, confirm the owner with them before
proceeding. **Completion criterion:** `repoUrl` matches the regex
`^https://github\.com/[^/]+/[^/]+$`.

### 2. Start the task

Call `start_coding_task` with a concise `taskDescription` (the user's
exact request is fine — the control plane preserves it as the agent's
top-level goal). Capture `sessionId` and `streamUrl`. **Completion
criterion:** response includes a non-empty `sessionId`.

### 3. Stream or poll

Prefer subscribing to `streamUrl` over polling — it surfaces tool calls
and message deltas in real time. If the host platform can't hold a
WebSocket open, fall back to `get_session_status` every 5 s. Render
events per the Quick Reference table. **Completion criterion:** you
receive either a `pr.created` event (success) or a terminal event
(`session.failed` / `session.aborted`).

### 4. Report back

On `pr.created`, post the PR URL. On terminal failure, post the
`errorMessage` from `get_session_status`. Do not summarize the diff or
the agent's internal reasoning — the user reviews the PR on GitHub.
**Completion criterion:** the user has either the PR URL or a clear
error.

### 5. Handle follow-ups

If the user replies with a change request in the same thread, call
`send_followup_prompt` with the new text. The control plane will resume
a paused sandbox automatically (M5). A 202 response with
`recoverable: true` means "queued, sandbox resuming" — wait for the
next `pr.created` or status change before responding to the user.

## Pitfalls

- **Don't shell out to `gh` or `git`.** The control plane drives the
  sandbox; the local agent doesn't touch the repo. If you find yourself
  reaching for `terminal` to run git, you're in the wrong skill — use
  `github-pr-workflow` for local-checkout work.

- **Don't auto-merge.** The whole point of opening a PR is human review.
  Branch protection on `main` should require review from someone other
  than the PR author — that rule depends on the PR being authored by
  the real user, which is what `GITHUB_USER_TOKEN` ensures.

- **One sandbox per session.** Calling `start_coding_task` twice spawns
  two sandboxes — don't retry on transient errors; check
  `get_session_status` first.

- **`429` from `start_coding_task`** means the concurrency cap
  (`MAX_CONCURRENT_SESSIONS`, default 10) is full. Tell the user
  "queue full, retry in a minute" and stop. Don't queue locally.

## Verification

After running the skill once end-to-end, verify on GitHub:

1. The PR exists and `pull_request.user.login` equals the operator's
   GitHub handle (NOT the bot identity `hermes-bot`).
2. The branch name starts with `hermes/`.
3. The PR body references `hermes-control-plane`.
4. The launcher's E2B sandbox list is empty after the session reaches
   `completed` (orphan sweeper runs at sandbox kill + on launcher boot).
