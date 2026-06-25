---
name: hermes-control-plane
description: Run a coding task in a sandbox; open a real GitHub PR.
version: 1.2.0
author: duckhoa-uit
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [github, sandbox, coding-agent, pull-request, e2b]
    category: devops
    related_skills: [github-pr-workflow, github-auth]
    config:
      launcher_url:
        description: "Base URL of the hermes-control-plane launcher (e.g. http://localhost:8789 or https://launcher.example.com)."
        default: "http://localhost:8789"
      worker_url:
        description: "Base URL of the deployed Cloudflare Worker (e.g. https://hermes.<sub>.workers.dev). Used as the polling endpoint when the WSS stream is not available."
        default: "http://localhost:8787"
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
- The repo is local-only with no GitHub remote — drop into the
  `github-pr-workflow` skill, which uses `terminal` + `patch` on the
  local checkout.
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

- **Operator's `GITHUB_USER_TOKEN` in the launcher env**
  (`/etc/hermes-control-plane/launcher.env`). Fine-grained PAT scoped to
  the target repos with Contents + Pull-requests read & write. The
  runner uses this for both `git push` and `POST /pulls`, so the PR
  `author` is the real operator — required for branch-protection rules
  like "PR review by someone other than author".

- **The four MCP tools must appear in your tool list**:
  `start_coding_task`, `get_session_status`, `send_followup_prompt`,
  `abort_session`. If they are missing, the MCP block is not loaded —
  tell the user "MCP server `hermes-control-plane` is not registered;
  check `~/.hermes/config.yaml` and restart Hermes." Do not improvise
  with `terminal` + `git`.

- **Hermes-side tools used by this skill**: the four MCP tools above
  for orchestration; `terminal` only for the optional polling fallback
  (`scripts/watch-session.sh`); `web_extract` if the user wants the
  rendered PR description and you have the URL. Never reach for
  `terminal` to run `gh` or `git` directly.

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

The session is the unit of work. Always remember the `sessionId`
returned by `start_coding_task` — every other tool needs it. If you
lose it mid-conversation you cannot follow up; ask the user to
restart the task.

When the host cannot hold a WSS connection open, fall back to the
shipped poller via `terminal`:

```bash
skills/hermes-control-plane/scripts/watch-session.sh <sessionId>
```

It exits 0 on `completed`, 1 on `failed`/`aborted`, 2 on transport
error, and prints one line per state change — feed it directly to the
user as a status tail. Override the Worker URL with the
`HERMES_WORKER_URL` env var or a second positional arg.

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
| `sandbox.provisioning` / `sandbox.ready` | status only; no user-facing message |
| `runner.connected` | status only; the agent is about to start work |
| `agent.message.delta` | Debounce 1 s, edit the running status reply |
| `agent.message.complete` | Final assistant turn; safe to stop editing |
| `tool.started` / `tool.completed` | Show `ran <tool>` (collapsed) |
| `approval.requested` | Surface the requested command to the user and wait — the runner is blocked until the user resolves it |
| `git.branch.pushed` | status only; PR is being opened next |
| `pr.created` | Post the PR URL — this is the success signal |
| `session.failed` / `session.aborted` | Post the error message |
| `system.stalled` | Tell the user "agent went silent (>15 min)"; offer to abort |

Full per-event payload field list is in
[`references/event-payloads.md`](references/event-payloads.md) — load
it when you need to extract a specific field (e.g. `approval.requested.command`,
`pr.created.prUrl`).

| Terminal session status | Meaning |
|---|---|
| `completed` | PR was opened; `artifacts.prUrl` is populated |
| `failed` | Agent or sandbox errored; `errorMessage` explains why |
| `aborted` | User-cancelled via `abort_session` |
| `stalled` | Runner missed heartbeats; will flip to `failed` if no reconnect |

| Error you may see | What it means | What to do |
|---|---|---|
| `launcher 429` | Concurrency cap reached (`MAX_CONCURRENT_SESSIONS`, default 10) | Tell the user "queue full, retry in a minute"; do not retry automatically |
| `launcher 4xx` on `start_coding_task` | Bad `repoUrl`, missing `taskDescription`, or unknown `projectId` | Fix the argument and try once; if unclear, ask the user |
| `launcher 5xx` / fetch failed | Launcher VPS is down or unreachable | Tell the user "control plane is unreachable" and stop — nothing to retry until ops fixes it |
| `worker 404` on `get_session_status` | The `sessionId` is wrong or the DO was archived | Stop polling; ask the user to restart the task |
| `worker 202 recoverable=true` on `send_followup_prompt` | Sandbox is paused; resume is in flight | Wait for the next `pr.created` or status change before replying |
| `session.failed` with `Bad credentials` | `GITHUB_USER_TOKEN` is missing, expired, or under-scoped | Tell the user "GitHub token rejected — operator must refresh `GITHUB_USER_TOKEN`"; do not retry |
| `session.failed` with `not found` / `404` on the repo | Repo URL is wrong or the PAT does not cover it | Confirm the repo with the user; if correct, the PAT is missing access |
| `session.failed` while pushing | Branch protection rejected the push | Pass the launcher message through verbatim; do not invent a workaround |

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

If the call returns `isError: true`, read the prefix and act per the
error table above — `429` and `5xx` are stop-conditions, not retry
conditions. Only `4xx` is worth a single corrected retry.

### 3. Stream or poll

Prefer subscribing to `streamUrl` over polling — it surfaces tool calls
and message deltas in real time. If the host platform can't hold a
WebSocket open, fall back to `get_session_status` every 5 s (or run
`scripts/watch-session.sh <sessionId>` via `terminal`). Render events
per the Quick Reference table; for payload field names see
`references/event-payloads.md`. **Completion criterion:** you receive
either a `pr.created` event (success) or a terminal event
(`session.failed` / `session.aborted`).

While polling, treat `provisioning`, `runner_connecting`, `ready`,
`running`, `needs_approval`, `review_ready`, and `creating_pr` as
non-terminal — keep polling. Only `completed`, `failed`, `aborted`,
and `archived` are terminal. `stalled` is a soft warning that resolves
to `failed` if the runner does not reconnect within the heartbeat
window (15 min by default).

### 4. Report back

On `pr.created`, post the PR URL. On terminal failure, post the
`errorMessage` from `get_session_status`. Do not summarize the diff or
the agent's internal reasoning — the user reviews the PR on GitHub.
**Completion criterion:** the user has either the PR URL or a clear
error.

Response shapes that work well — copy the spirit, not the words:

- Success: `PR opened: <prUrl>`. One line. The user clicks through.
- Failed: `Task failed: <errorMessage>. Session <sessionId>.` Keep
  the `sessionId` in the reply so the user (or you, on a follow-up)
  can call `get_session_status` for the full event log.
- Aborted: `Aborted at user request. Session <sessionId>.`
- Stalled: `Agent has been silent for 15 min — likely stuck. Want me
  to abort?` Then wait for the user.

### 5. Handle follow-ups

If the user replies with a change request in the same thread, call
`send_followup_prompt` with the new text. The control plane will resume
a paused sandbox automatically (M5). A 202 response with
`recoverable: true` means "queued, sandbox resuming" — wait for the
next `pr.created` or status change before responding to the user.

Follow-ups only work while the session is non-terminal. If the user
asks for changes after the session reached `completed`, `failed`, or
`aborted`, the sandbox is gone — call `start_coding_task` with a new
task description that references the prior PR (e.g. "follow-up on
<prUrl>: …") instead of `send_followup_prompt`. Don't try to revive a
terminal session.

If `send_followup_prompt` returns a non-202 error, call
`get_session_status` once before reporting the failure — the session
may have moved to a terminal state between your last update and the
follow-up.

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

- **Don't paraphrase `errorMessage`.** When `session.failed` arrives,
  pass the launcher's message through verbatim. The operator needs to
  see "Bad credentials" or "branch protection rejected push" exactly —
  paraphrasing turns a fixable error into a mystery.

- **Don't poll faster than 5 s.** Tighter polling produces no new
  information — events are appended on the runner's cadence and the
  DO returns the same snapshot you saw last call.

- **Don't abort to "clean up" after success.** Once you see
  `pr.created` / `completed`, the sandbox tears itself down via the
  per-session reaper. Calling `abort_session` afterwards is harmless
  (idempotent) but wastes a tool call.

- **Don't summarize the diff.** `git.diff.ready` events are
  intentionally not surfaced — the user reviews the PR on GitHub.
  Summarizing in chat invites the user to skip the actual review,
  which is the one quality gate this skill exists to protect.

## Verification

After running the skill once end-to-end, the operator can sanity-check
the deployment with `terminal`:

```bash
LAUNCHER="${HERMES_LAUNCHER_URL:-http://localhost:8789}"
WORKER="${HERMES_WORKER_URL:-http://localhost:8787}"

# 1. Both processes answer /health
curl -fsS "$LAUNCHER/health" | head
curl -fsS "$WORKER/health"   | head

# 2. The session record exists and has artifacts.prUrl populated
curl -fsS "$WORKER/sessions/<sessionId>" | python3 -m json.tool | head -40

# 3. The PR exists and is authored by the operator
PR_URL="<prUrl from above>"
gh pr view "$PR_URL" --json author,headRefName,body \
  --jq '{author: .author.login, branch: .headRefName, mentions_skill: (.body | contains("hermes-control-plane"))}'

# 4. No orphan sandboxes remain
curl -fsS "$LAUNCHER/health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("active sandboxes:", d.get("activeSessions"))'
```

Expected shape after a clean run:

1. `pull_request.user.login` equals the operator's GitHub handle
   (`GITHUB_USER_LOGIN`).
2. The branch name starts with `hermes/`.
3. The PR body references `hermes-control-plane`.
4. The launcher's `activeSessions` returns to 0 (orphan sweeper runs at
   sandbox kill + on launcher boot).

If a session terminated unexpectedly and the operator wants to debug,
point them at:

- `get_session_status <sessionId>` — full event log + `errorMessage`.
- `scripts/sandbox-debug.ts <sandboxId>` (in the control-plane repo) —
  SSH into the live sandbox (if it has not been reaped) and dump
  supervisor + runner logs.
- Launcher logs on the VPS — `journalctl -u hermes-control-plane-launcher`.

Don't run those yourself from inside Hermes; surface the names to the
operator so they can run them on the launcher host.
