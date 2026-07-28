# Observability runbook

This runbook covers the current Control Plan runtime: one Cloudflare Worker,
Flue Durable Objects, Cloudflare Sandbox containers, the Hermes MCP boundary,
and the GitHub webhook acknowledgement path. There is no VPS launcher or E2B
runner in the active architecture.

For the structured logger and redaction contract, see
[`CONTRIBUTING.md` §Observability](../CONTRIBUTING.md#observability). For the
route contract, see [`api-reference.md`](api-reference.md).

## 1. Dashboards and signals

| Service | Where | What it shows |
|---|---|---|
| Cloudflare Worker | Cloudflare dashboard → Workers → `hermes-control-plane` → Metrics | Request rate, CPU time, error rate, and egress. |
| Worker traces | Cloudflare dashboard → Worker → Traces | Sampled request traces, including automatic propagation across Worker subrequests and Durable Objects. Control Plan adds `control_plan.admission.*`, `control_plan.flue.*`, `control_plan.sandbox.*`, and `control_plan.publication.*` spans. |
| Worker logs | Cloudflare dashboard → Worker → Logs → Live | Structured logs from `src/core/logger.ts`; filter by `service`, `requestId`, `sessionId`, and task ID. |
| Durable Objects | Cloudflare dashboard → Worker → Settings → Durable Objects | Storage and activity for Flue-generated Workflow classes, `ControlPlanTaskDurableObject`, `ApprovalDurableObject`, and `Sandbox`. |
| Hermes MCP calls | Worker logs for `/mcp` plus Hermes MCP client logs | Authentication failures, tool latency, dispatch errors, and task IDs. |
| GitHub Actions | Repository Actions | Typecheck, tests, Flue build, and deployment history. |
| GitHub webhook deliveries | Repository Settings → Webhooks → Recent Deliveries | HMAC-verified acknowledgement. The current handler acknowledges events only; it does not start a coding task. |

## 2. Alerts

At minimum, alert on:

- sustained Worker 5xx responses;
- repeated `/mcp` 401 responses or dispatch failures;
- task records whose `dispatched` state remains unchanged
  beyond the expected task duration (a short-lived `dispatched` state is normal);
- Sandbox/container startup or command failures;
- failed deployment checks.

Keep the alert payloads correlated with `requestId`, `sessionId`, and the
Control Plan task ID so an operator can follow a task across MCP, Flue, and
Sandbox logs.

## 3. Runbooks

### Worker error rate is high

1. Open Worker Logs → Live and filter `level:error`.
2. Follow the `requestId` and task/session ID through the failing request.
3. For GitHub `401`/`403`, verify `GITHUB_APP_ID`, the PEM
   `GITHUB_APP_PRIVATE_KEY`, and that the App installation includes the task
   repository with the required permissions.
4. For `/mcp` `401`, verify the Hermes `Authorization` header matches
   `CONTROL_PLAN_MCP_TOKEN`; do not reuse the GitHub webhook secret.
5. For a deployment or binding error, rerun the CI deploy checks after fixing
   configuration rather than changing task data in the Durable Object.

### A task is stuck or Sandbox commands fail

1. Call `get_coding_task` with the task ID and record its `state` and replay URL.
2. Open the replay URL and inspect the Flue event stream around the first
   failed command or approval request. For an exceptional publication, also
   inspect the Hermes gateway log for the matching MCP `elicitation/create`.
3. Check the `Sandbox` Durable Object and container logs for startup, RPC, or
   command timeout errors. The current runtime uses RPC transport with one
   explicit persistent session per Flue harness and disables the default
   Sandbox session.
4. If the task is still running, use `respond_coding_approval` for a real
   pending ApprovalDO record; a non-deny call must complete native Hermes
   elicitation. A task in `publishing` has already acquired the atomic GitHub
   write lease, so cancellation reports that publication is in progress and
   waits for settlement. Otherwise `cancel_coding_task` records a request, asks
   and blocks the publication boundary before the lease. Once the run settles,
   the task becomes terminal `cancelled`.

### Hermes cannot call the MCP server

1. Verify the public HTTPS URL ends in `/mcp` and accepts both
   `application/json` and `text/event-stream` in the `Accept` header.
2. Verify `CONTROL_PLAN_MCP_TOKEN` is present on the Worker and configured in
   Hermes as a secret header.
3. Confirm the GitHub App installation includes the repository and that the
   requested base branch exists. If `baseBranch` was omitted, inspect the
   repository's current default branch.
4. Check that the Hermes tool filter includes the coding lifecycle tools and,
   when specialist automation is enabled, the three read-only specialist tools
   documented in
   [`HERMES-AGENT-INTEGRATION.md`](HERMES-AGENT-INTEGRATION.md).

### GitHub webhook is not starting work

That is expected in the current Hermes-driven mode. The webhook verifies and
acknowledges the event only. Hermes must receive or otherwise decide on the
coding request and call `spawn_coding_task`; do not add a direct dispatch path
without updating the architecture and security contract.

### Deployment failed

1. Run `bun run typecheck`, `bun run test`, `bun run lint`, and
   `npx flue build --target cloudflare` locally.
2. Run `npx wrangler deploy --dry-run` to validate Worker bindings and the
   Sandbox image without publishing traffic.
3. Run `bun run test:worker` with Docker enabled to execute the built Flue
   Worker through Wrangler's `createTestHarness()` and workerd.
4. Inspect the failed CI step and rerun only after correcting the source or
   configuration issue.

## 4. Source of truth

- HTTP routes and MCP boundary: `src/app.ts`, `src/mcp/control-plan.ts`.
- Task persistence: `src/do/coding-task-do.ts`.
- Task reconciliation: `src/mcp/control-plan.ts` uses ambient Flue `getRun()`
  for coding and specialist Workflow runs.
- Approval persistence: `src/do/approval-do.ts` and `src/approval/index.ts`.
- GitHub writes: `src/agent/publication-service.ts`,
  `src/agent/github-api-push.ts`, `src/agent/control-plan-finalize-action.ts`,
  and the signed compatibility routes in `src/app.ts`.
- Structured logs and redaction: `src/core/logger.ts`.
