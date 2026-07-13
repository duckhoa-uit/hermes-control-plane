# Hermes Agent Integration

Control Plan is a coding-agent execution service for the external
[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) platform. Hermes is
the orchestrator; it decides when a task needs code changes and calls Control
Plan to run the coding agent.

## Decision

Expose Control Plan as a remote HTTP MCP server. Hermes connects to that server
with a service token and calls a small, allowlisted tool surface:

| MCP tool | Input | Result |
|---|---|---|
| `spawn_coding_task` | repository, task, optional base branch, idempotency key | Control Plan task ID, state, replay URL |
| `get_coding_task` | task ID | state, current summary, pending approval, PR/result when available |
| `respond_coding_approval` | task ID, approval ID, decision hint | starts a native Hermes elicitation; only the gateway's accept/decline result is recorded |
| `cancel_coding_task` | task ID | cancellation-requested state plus Flue abort request |

Hermes presents these as MCP tools (for example,
`mcp_control_plan_spawn_coding_task`). Hermes remains responsible for task
interpretation and clarification. For privileged publication, Control Plan
issues MCP `elicitation/create`; the Hermes gateway renders that request in
its native approval surface and returns the operator's accept/decline result.
The model's `decision` argument is never treated as proof of human approval.

Do **not** use the Hermes HTTP Runs API for this boundary. It lets an external
client start and monitor Hermes runs, which reverses the desired ownership. ACP
and the TUI gateway are also unnecessary: this integration is a remote service
call, not an IDE or process-host protocol.

## Runtime ownership

| Concern | Owner |
|---|---|
| User request, planning, delegation, memory, and communication | Hermes Agent |
| Coding task lifecycle, idempotency, repository policy, and task correlation | Control Plan |
| Durable model/tool loop | Flue `FlueControlPlanAgent` Durable Object |
| Git, shell, dependency install, and tests | Cloudflare Sandbox container |
| Approval persistence and enforcement | Control Plan ApprovalDO |
| GitHub App installation authorization, token minting, commit publication, and PR creation | Control Plan Worker |

Hermes never receives the GitHub App private key or installation tokens; the
sandbox receives only a short-lived repository-scoped read token for cloning.
Hermes only receives task state and approved result metadata from Control Plan.

## Hermes configuration

On the Hermes host, configure Control Plan as an HTTP MCP server with bearer
authentication and an explicit tool allowlist. Use the public HTTPS origin in
production and a local Docker origin only for development.

```yaml
mcp_servers:
  control_plan:
    url: "https://control-plan.khoa.lol/mcp"
    headers:
      Authorization: "Bearer <Control Plan MCP service token>"
```

The current Hermes config schema does not support `tools.include`,
`resources`, or `prompts` nested under an `mcp_servers` entry. Hermes discovers
the four tools and prefixes them as `mcp_control_plan_*`; filter/disable tools
at the Hermes tool-policy layer if needed.

Use a dedicated `CONTROL_PLAN_MCP_TOKEN` secret. Do not reuse the GitHub
webhook secret, signed replay tokens, or a GitHub token for this boundary.

## Task flow

```text
Hermes receives a coding request
  -> Hermes calls spawn_coding_task
  -> Control Plan validates GitHub App access and dispatches Flue
  -> Flue works in its per-task Cloudflare Sandbox
  -> Control Plan applies publication policy and, when required, sends native MCP elicitation
  -> Control Plan writes the commit/PR through its GitHub API boundary
  -> Hermes polls get_coding_task and reports the result to the user
```

`get_coding_task` is the reconciliation source of truth. Replay/SSE is a
diagnostic and operator interface, not the only record of task completion.

## Security and rollout requirements

1. Authenticate every MCP request with `CONTROL_PLAN_MCP_TOKEN`; reject missing
   or invalid credentials before parsing a tool call.
2. Let the GitHub App installation determine repository access. When
   `baseBranch` is omitted, Control Plan uses the repository default branch;
   when supplied, it must exist. Validate an idempotency key before dispatching
   a second Flue session.
3. Persist the task record before dispatch. Store the Control Plan task ID,
   Flue session ID, repository, base branch, deterministic publication branch,
   and lifecycle state. The task branch is enforced at both the agent tool and
   GitHub proxy boundaries, so profiles cannot cross-publish repositories.
4. Require `respond_coding_approval` to identify a still-open ApprovalDO record.
   Any non-deny decision must complete native MCP elicitation; a model-supplied
   `once`, `session`, or `always` value alone cannot authorize a write.
5. Use `APPROVAL_MODE=policy` in production. Normal task-branch pushes and
   draft PRs run autonomously after checks pass. Force pushes, non-task
   branches, sensitive paths, and non-draft PRs require the native approval.
   `manual` remains available for an all-publications approval gate; `off` is
   an explicit unsafe development mode.
6. Test the MCP protocol and tool schemas against a pinned Hermes Agent release.
7. Run one real Docker-backed task against `duckhoa-uit/lawn` before staging or
   production deployment. The task must clone the repository, make a narrow
   change, run its repository checks, request/receive any needed approval, and
   return a verifiable result.

Control Plan currently pins `@cloudflare/sandbox` and its Docker base image to
`0.12.3`. Every task sandbox uses RPC transport with default sessions disabled,
which is required by Cloudflare's post-2026-07-09 Sandbox SDK migration.

Private repositories require the GitHub App to be installed on the repository.
Control Plan mints a read installation token scoped to that repository and
passes it only to the task-bound clone command; it is not persisted in the task
record or placed in the model shell or clone URL. `MAX_CONCURRENT_SESSIONS` is
enforced by a Durable Object admission lease, not only by the Sandbox container
`max_instances` setting. Capacity failures are retryable and do not dispatch a
second Flue session for the same idempotency key.

## GitHub webhook mode

The existing GitHub webhook endpoint currently verifies and acknowledges events
only. That is correct for the first Hermes-driven path. If direct GitHub events
later initiate coding work, the routing policy must either deliver a normalized
request to Hermes or explicitly document a separate direct Control Plan mode;
it must not bypass Hermes by accident.

## References

- [Hermes Agent MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Hermes Agent MCP configuration reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
- [Using MCP with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes)
