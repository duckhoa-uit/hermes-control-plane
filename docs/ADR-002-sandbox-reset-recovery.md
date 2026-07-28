# ADR-002: Add bounded Sandbox reset recovery

Status: Proposed

## Context

A real Hermes-host smoke task against `duckhoa-uit/lawn` reached the coding
Workflow and successfully created and verified a small test fixture. Before
`finalize_change` ran, Cloudflare Sandbox operations began failing repeatedly
with an internal Durable Object storage reset. A diagnostic command may also
have moved the verified file out of the repository before its paired restore
command could run. The task correctly failed closed without publishing an
uncertain workspace.

The incident exposed an availability and recoverability gap, not a publication
integrity failure. Control Plan already has task idempotency, a publication
lease, deterministic push manifests, and `prepared`/`pushed`/`completed`
finalize checkpoints. Flue persists conversation and completed tool records,
but does not make sandbox files durable or resume arbitrary finite Workflow
execution from its last TypeScript statement.

## Decision

Keep the current product architecture and add the minimum recovery behavior at
the Sandbox adapter boundary. Do not add a second workflow engine, per-command
workspace snapshots, or a mandatory second verifier sandbox.

The first implementation will:

1. Classify Sandbox failures into transient reset/session failures, timeouts,
   unknown command outcomes, and terminal failures.
2. Lazily resolve the explicit task session and invalidate/reacquire its handle
   after a classified transient reset.
3. Retry only operations whose effects are known to be idempotent or safely
   verifiable:
   - retry `readFile`, `readFileBuffer`, `exists`, `stat`, and `readdir`;
   - retry recursive `mkdir`;
   - retry full-replacement `writeFile` only with read-back verification;
   - do not blindly retry arbitrary `exec`, removal, move, commit, or compound
     mutation commands after an interrupted RPC response.
4. Surface interrupted arbitrary commands as an explicit unknown-outcome error
   so the agent reconciles with read-only commands rather than repeating the
   mutation.
5. Limit recovery to a small retry budget with short backoff and a circuit
   breaker. Persistent failure remains fail-closed.
6. Strengthen the coding-agent instructions:
   - call `finalize_change` immediately after relevant checks pass;
   - do not move or delete modified files for diagnostics;
   - do not use multi-command manual rollback sequences;
   - reconcile uncertain command outcomes with `git status`, `git diff`, and
     file existence checks before any further mutation.
7. Emit structured recovery telemetry for error kind, operation, attempt,
   session reacquisition, and unknown command outcome.

This phase does not add new MCP tools, lifecycle states, Durable Object
migrations, R2 bindings, or changes to the Hermes integration contract.

## Why this is sufficient now

Comparable systems use bounded, explicit recovery rather than attempting to
make every workspace mutation transactional:

- Flue treats workspace persistence separately from durable conversation and
  tool records. Interrupted finite Workflows are retried as new invocations
  when the application determines that retry is safe.
- Open SWE checks sandbox reachability, recreates stale sandboxes, and uses a
  circuit breaker. Recreation does not preserve uncommitted changes.
- OpenHands can archive a workspace as a git delta or tarball at lifecycle
  boundaries before sandbox deletion; it does not archive after every tool
  call.
- Cloudflare Sandbox supports R2-backed point-in-time backups, recommended at
  explicit checkpoints or before risky operations rather than on every file
  edit.
- Temporal-style activity heartbeats and resumable orchestration are useful
  patterns, but introducing another workflow system would duplicate Flue and
  Control Plan's existing durable coordination.

The observed incident was made worse by a post-verification diagnostic
mutation. Adapter recovery plus stricter agent behavior addresses the highest
probability failure mode without adding a durable artifact subsystem.

## Explicit non-goals

The initial work will not:

- introduce Temporal or another orchestration service;
- snapshot `/workspace` after every command or file edit;
- add an event-sourced filesystem;
- automatically rotate through multiple sandbox generations;
- run every task again in a fresh verifier sandbox;
- retain every failed sandbox for an extended forensic window;
- add `recovering`, `checkpointing`, or `restoring` task states;
- automatically retry arbitrary commands with unknown side effects.

## Implementation scope

Expected implementation files:

- `src/agent/cloudflare-session-sandbox.ts`
- `src/agent/control-plan-agent-config.ts`
- `src/agents/control-plan.md`
- `tests/cloudflare-session-sandbox.test.ts`
- focused tests for coding-agent instruction and error-contract behavior

Required fault-injection coverage:

1. A read operation fails once with a reset and succeeds after session
   reacquisition.
2. A stale explicit session is reacquired without changing task identity.
3. Arbitrary `exec` is not repeated after an unknown-outcome reset.
4. Full-replacement `writeFile` is read back before being reported successful.
5. Retry stops after the configured attempt limit.
6. Recovery telemetry identifies the operation and classified failure.
7. Repeated infrastructure failures still produce a concrete fail-closed
   result without publication.

## Validation

After deployment, run production smoke tasks covering:

1. a normal additive fixture change that reaches a draft PR;
2. an injected transient read failure that recovers;
3. an interrupted mutation whose unknown outcome is reconciled without
   duplicate execution;
4. a persistent Sandbox failure that terminates safely without branch or PR
   duplication.

The change is successful if normal task latency does not materially increase,
transient read/session failures recover within the bounded budget, arbitrary
mutations are never blindly repeated, and publication remains idempotent and
fail-closed.

## Deferred options and decision gates

### Clean-sandbox task retry

Add one new Workflow attempt from a clean clone only if at least one of these is
true:

- two or more Sandbox reset incidents occur within 30 days;
- more than one percent of coding tasks terminate because of retryable
  infrastructure failures;
- the production SLO requires automatic recovery without operator retry.

A retry must use a new attempt-scoped sandbox identity, retain the same domain
task and publication branch, stop after one automatic retry, and never run
after publication has started.

### Durable change checkpoint

Persist a verified push manifest or one `/workspace` backup only if clean reruns
prove materially expensive or progress loss remains operationally significant.
Prefer the existing push-manifest format for normal text changes. Consider a
Cloudflare Sandbox R2 backup only for large/binary workspaces, expensive setup,
or explicit forensic requirements. Do not checkpoint after every agent step.

### Fresh verifier sandbox

Use a second clean verifier only if the product requires independent
reproducibility or distrusts verification performed in the editing workspace.
It is not justified by the current incident alone because it duplicates clone,
dependency installation, and test cost.

## References

- [Flue durable execution](https://flueframework.com/docs/concepts/durable-execution/)
- [Flue Cloudflare Sandbox integration](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
- [Cloudflare Sandbox backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)
- [Cloudflare Sandbox sessions](https://developers.cloudflare.com/sandbox/api/sessions/)
- [Cloudflare Durable Objects troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/)
- [Open SWE](https://github.com/langchain-ai/open-swe)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
