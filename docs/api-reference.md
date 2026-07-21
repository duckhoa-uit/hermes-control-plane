<!-- AUTO-GENERATED FILE. Do not edit by hand.
     Source of truth: src/app.ts, src/agents/control-plan.ts, src/workflows/*.ts, src/channels/github.ts
     This reference is maintained with the current Control Plan route surface.
-->

# HTTP API reference

Control Plan is a Cloudflare Worker. Hermes Agent uses the authenticated
`/mcp` endpoint; Flue mounts the agent and GitHub channel routes below.

## Worker routes

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Unauthenticated liveness check. |
| ALL | `/mcp` | Remote HTTP MCP for Hermes Agent. Requires `Authorization: Bearer <CONTROL_PLAN_MCP_TOKEN>`. |
| POST | `/agents/control-plan/:id` | Internal Flue dispatch only; requires a short-lived internal capability (enforced by both the Worker mount and the Agent route). |
| GET | `/agents/control-plan/:id` | Internal Flue history/updates only; requires a short-lived internal capability (enforced by both the Worker mount and the Agent route). |
| POST | `/workflows/coding-task` | Internal finite coding Workflow invocation; requires the scoped workflow capability. |
| POST | `/workflows/pr-review` | Internal finite, read-only PR review Workflow; requires the `pr-review` scoped workflow capability. |
| POST | `/workflows/sentry-triage` | Internal finite, read-only Sentry triage Workflow; requires the `sentry-triage` scoped workflow capability. |
| GET/HEAD | `/runs/:runId` | Internal Workflow run inspection/streaming; requires the scoped workflow capability. |
| POST | `/channels/github/webhook` | HMAC-verified GitHub webhook acknowledgement; it does not dispatch through Hermes. |
| POST | `/proxy/git-push` | Credential-isolated GitHub push; requires a short-lived proxy capability and active task binding. |
| POST | `/proxy/create-pr` | Credential-isolated PR creation; requires a short-lived proxy capability and active task binding. |
| GET | `/replay/:id` | Token-gated replay HTML. |
| GET | `/sessions/:id/stream` | Token-gated replay stream proxy. |
| GET | `/approvals/:id` | Read an approval record. |
| POST | `/approvals/:id` | Resolve an approval record. |
| GET | `/sessions/:id/approvals/open` | Token-gated list of open approvals for a session. |

## MCP tools

The MCP server exposes the four coding lifecycle tools plus three read-only
specialist workflow tools. Hermes sees them with its MCP server prefix (for
example, `mcp_control_plan_spawn_coding_task`).

| Tool | Purpose |
|---|---|
| `spawn_coding_task` | Verify GitHub App installation access and repository branch, allocate an isolated task branch, persist an idempotent task, and asynchronously dispatch Flue under the concurrency lease. |
| `get_coding_task` | Reconcile Flue run/history settlements and return durable task state, lifecycle guidance, repository/branch, summary, replay URL, result metadata, and open approvals. `dispatched` and `publishing` are active; poll until terminal. |
| `respond_coding_approval` | Resolve a pending ApprovalDO record belonging to the task; non-deny requests first invoke native MCP `elicitation/create` in Hermes, then require further task polling. |
| `cancel_coding_task` | Persist cancellation, asynchronously request Flue abort, and block later GitHub publication; if `publishing` is already active, report that publication is in progress. Poll until terminal `cancelled`. |
| `start_pr_review` | Start a PR review Workflow from a caller-supplied bounded diff snapshot; it does not fetch GitHub and never writes to GitHub. |
| `start_sentry_triage` | Start a Sentry triage Workflow from a caller-supplied bounded issue/event snapshot; it does not query or modify Sentry. |
| `get_specialist_workflow` | Poll only `pr-review` or `sentry-triage` runs; coding-task runs are rejected. |

See [`HERMES-AGENT-INTEGRATION.md`](HERMES-AGENT-INTEGRATION.md) for schemas,
authentication, GitHub App installation configuration, and Hermes client setup.
