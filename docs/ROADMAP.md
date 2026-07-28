# Roadmap

## Done (2026-07-14)

- [x] Migrate from E2B/OpenCode/Bun Launcher to Flue + Cloudflare Sandbox.
- [x] Establish the Hermes → remote HTTP MCP → Control Plan boundary.
- [x] Persist idempotent coding-task records and reconcile paged Flue events.
- [x] Upgrade Sandbox to `0.12.4` with RPC transport, explicit persistent sessions, and non-secret Container labels (implicit default sessions disabled).
- [x] Verify a real Docker-backed task against `duckhoa-uit/lawn` through MCP.
- [x] Bind GitHub publication to each task's repository/base branch and deterministic branch.
- [x] Add scoped private-repository clone access and durable concurrency admission.
- [x] Verify MCP tasks against both `duckhoa-uit/lawn` and `NousResearch/hermes-agent` locally.
- [x] Route exceptional publication approvals through native Hermes MCP elicitation and fail closed when ApprovalDO is unavailable.
- [x] Add policy-mode publication boundaries: task-branch commits and draft PRs may run autonomously; force/sensitive/non-draft operations require approval.

## Done (2026-07-21)

- [x] Make the coding executor Flue-native: packaged Markdown instructions and skill, task workspace provisioning before harness init, and a single `finalize_change` Action for publication.
- [x] Move MCP coding tasks to a finite Flue Workflow with persisted `runId` reconciliation and workflow replay.
- [x] Keep sandbox/session/action policy in one Workflow-native coding harness.

## Done (2026-07-28)

- [x] Add a Docker-backed Wrangler `createTestHarness()` smoke suite for the
  built Flue Worker, covering health and MCP authorization.
- [x] Route coding and specialist Flue lifecycle calls through an injectable
  `WorkflowRuntime` seam.
- [x] Enable Cloudflare Worker traces and remove mutable module-global
  PostHog configuration from approval telemetry.
- [x] Close the cancellation/publication TOCTOU race with an atomic task-owned GitHub publication lease.
- [x] Expose bounded PR review and Sentry triage Workflows through separate read-only MCP start/poll tools.
- [x] Remove the second same-Worker orchestration hop: MCP work uses ambient Flue `invoke()` and `getRun()`.
- [x] Extract the internal `PublicationService`; Flue publication no longer self-fetches `/proxy/*`, while signed proxy routes remain compatible.
- [x] Add custom Cloudflare spans for admission, Flue lifecycle, Sandbox setup/prepare, and publication operations.
- [x] Update architecture, integration, API, deployment, setup, observability, and roadmap docs to describe the Flue-native boundary.

## Next

- [ ] Configure and smoke-test a real Hermes host against the deployed MCP URL.
- [ ] Stage the Worker rename/state-preserving Durable Object migration.
- [x] Run a production policy-mode disposable draft-publication smoke test; close the PR and delete its branch after verification.
- [ ] Run the exceptional native-approval smoke test with production secrets.
- [x] Keep GitHub webhook events acknowledgement-only; Hermes owns triage and task creation.
- [x] Use GitHub App installation access for dynamic multi-repository policy and short-lived tokens.
- [ ] Bind exceptional approval grants to a one-use manifest hash at the proxy boundary for defense in depth beyond the current task/session capability checks.
- [ ] Run the separate [Vitest 4 + `@cloudflare/vitest-pool-workers` migration spike](ADR-001-vitest-pool-workers.md); compare native workerd coverage, DO isolation, runtime startup, and CI cost before changing the canonical test runner.
- [ ] Implement the bounded [Sandbox reset recovery plan](ADR-002-sandbox-reset-recovery.md): reacquire transiently reset sessions, retry only safe operations, preserve unknown command outcomes, and harden post-verification agent behavior before considering clean-sandbox retries or R2 checkpoints.
- [x] Verify Workflow cancellation in production; cancellation now settles to terminal `cancelled` and blocks the publication proxy.
