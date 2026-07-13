<!-- AUTO-GENERATED FILE. Do not edit by hand.
     Source of truth: src/app.ts, src/agents/control-plan.ts, src/channels/github.ts
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
| POST | `/agents/control-plan/:id` | Internal Flue dispatch only; requires a short-lived internal capability. |
| GET | `/agents/control-plan/:id` | Internal Flue history/updates only; requires a short-lived internal capability. |
| POST | `/channels/github/webhook` | HMAC-verified GitHub webhook acknowledgement; it does not dispatch through Hermes. |
| POST | `/proxy/git-push` | Credential-isolated GitHub push; requires a short-lived proxy capability and active task binding. |
| POST | `/proxy/create-pr` | Credential-isolated PR creation; requires a short-lived proxy capability and active task binding. |
| GET | `/replay/:id` | Token-gated replay HTML. |
| GET | `/sessions/:id/stream` | Token-gated replay stream proxy. |
| GET | `/approvals/:id` | Read an approval record. |
| POST | `/approvals/:id` | Resolve an approval record. |
| GET | `/sessions/:id/approvals/open` | Token-gated list of open approvals for a session. |

## MCP tools

The MCP server exposes exactly four tools. Hermes sees them with its MCP
server prefix (for example, `mcp_control_plan_spawn_coding_task`).

| Tool | Purpose |
|---|---|
| `spawn_coding_task` | Verify GitHub App installation access and repository branch, allocate an isolated task branch, persist an idempotent task, and dispatch Flue under the concurrency lease. |
| `get_coding_task` | Reconcile Flue history settlements and return durable task state, repository/branch, summary, replay URL, result metadata, and open approvals. |
| `respond_coding_approval` | Resolve a pending ApprovalDO record belonging to the task; non-deny requests first invoke native MCP `elicitation/create` in Hermes. |
| `cancel_coding_task` | Persist cancellation, request Flue abort, and block later GitHub publication. |

See [`HERMES-AGENT-INTEGRATION.md`](HERMES-AGENT-INTEGRATION.md) for schemas,
authentication, GitHub App installation configuration, and Hermes client setup.
