<!-- AUTO-GENERATED FILE. Do not edit by hand.
     Source: src/core/types.ts
     Regenerate: bun run docs:gen
-->


# Event, state, and message types

Auto-generated from the string-union types exported by `src/core/types.ts`. These are the wire contracts agents see when they read the DO event log, send a runner command, or wire up a webhook downstream.

## `SessionStatus`

| Value | Notes |
|---|---|
| `created` |  |
| `provisioning` |  |
| `runner_connecting` |  |
| `ready` |  |
| `running` |  |
| `needs_approval` |  |
| `review_ready` |  |
| `creating_pr` |  |
| `completed` |  |
| `failed` |  |
| `aborted` |  |
| `stalled` |  |
| `archived` |  |

## `HermesEventType`

| Value | Notes |
|---|---|
| `session.created` |  |
| `session.status_changed` |  |
| `session.completed` |  |
| `session.failed` |  |
| `sandbox.provisioning` |  |
| `sandbox.ready` |  |
| `sandbox.destroyed` |  |
| `runner.connected` |  |
| `runner.disconnected` |  |
| `runner.heartbeat` |  |
| `agent.message.delta` |  |
| `agent.message.complete` |  |
| `agent.started` |  |
| `agent.done` |  |
| `agent.error` |  |
| `tool.started` |  |
| `tool.output` |  |
| `tool.completed` |  |
| `file.changed` |  |
| `approval.requested` |  |
| `approval.resolved` |  |
| `git.diff.ready` |  |
| `git.branch.pushed` |  |
| `pr.created` |  |
| `pr.updated` |  |
| `pr.merged` |  |
| `pr.closed` |  |
| `pr.autofix.triggered` |  |
| `pr.autofix.skipped` |  |
| `system.stalled` |  |
| `system.retrying` |  |
| `agent.usage` |  |
| `repo.instructions.loaded` | A4 — AGENTS.md / CLAUDE.md / CONVENTIONS.md |
| `agent.pr_metadata` | A2 — agent-authored PR title/body parsed OK |
| `runner.ready_to_publish` | B2 — runner finished local prep; DO drives publish |
| `pr.publishing` | B2 — DO has dispatched publish to launcher |
| `pr.publish.failed` | B2 — launcher publish failed (push or REST) |

## `RunnerMessageType`

| Value | Notes |
|---|---|
| `runner.connect` |  |
| `runner.heartbeat` |  |
| `runner.event` |  |
| `runner.command_ack` |  |
| `runner.command_error` |  |
| `runner.complete` |  |
| `runner.error` |  |

## `ClientMessageType`

| Value | Notes |
|---|---|
| `client.subscribe` |  |
| `client.unsubscribe` |  |
| `client.approve` |  |
| `client.deny` |  |
| `client.abort` |  |
| `client.create_pr` |  |
