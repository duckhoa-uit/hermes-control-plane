# Roadmap

## Done (2026-07-14)

- [x] Migrate from E2B/OpenCode/Bun Launcher to Flue + Cloudflare Sandbox.
- [x] Establish the Hermes → remote HTTP MCP → Control Plan boundary.
- [x] Persist idempotent coding-task records and reconcile Flue Workflow runs through stored `runId` pointers.
- [x] Upgrade Sandbox to `0.12.4` with RPC transport, explicit persistent sessions, and non-secret Container labels (implicit default sessions disabled).
- [x] Verify a real Docker-backed task against `duckhoa-uit/lawn` through MCP.
- [x] Bind GitHub publication to each task's repository/base branch and deterministic branch.
- [x] Add GitHub App installation-based dynamic multi-repository access, scoped short-lived clone tokens, and durable concurrency admission.
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
- [x] Configure a real Hermes Agent `v2026.7.20` host against the production MCP URL and verify bearer authentication plus discovery of all seven allowlisted tools.
- [x] Verify end-to-end Hermes-host dispatch and terminal reconciliation against `duckhoa-uit/lawn`; publication remains pending because the latest task failed closed during a Cloudflare Sandbox/Durable Object reset.
- [x] Run and clean up a production policy-mode disposable draft-publication smoke test.
- [x] Verify production Workflow cancellation settles to terminal `cancelled` and blocks the publication proxy.
- [x] Keep GitHub webhook ingress acknowledgement-only so Hermes remains responsible for triage and task creation.
- [x] Update architecture, integration, API, deployment, setup, observability, and roadmap docs to describe the Flue-native boundary.

## Next

- [ ] Implement the bounded [Sandbox reset recovery plan](ADR-002-sandbox-reset-recovery.md): reacquire transiently reset sessions, retry only safe operations, preserve unknown command outcomes, and harden post-verification agent behavior before considering clean-sandbox retries or R2 checkpoints.
- [ ] Re-run the real Hermes-host `duckhoa-uit/lawn` smoke after Sandbox recovery lands and require a verified additive change, successful checks, and an automatically published draft PR.
- [ ] Run the exceptional native-approval smoke test with production secrets and confirm Hermes renders `elicitation/create` before the exceptional publication is resolved.
- [ ] Bind exceptional approval grants to a one-use manifest hash at the proxy boundary for defense in depth beyond the current task/session capability checks.
- [ ] Decide whether a Worker rename is still required; if retained, design and stage the state-preserving Worker/Durable Object migration before changing the deployed name.
- [ ] Run the separate [Vitest 4 + `@cloudflare/vitest-pool-workers` migration spike](ADR-001-vitest-pool-workers.md); compare native workerd coverage, DO isolation, runtime startup, and CI cost before changing the canonical test runner.
