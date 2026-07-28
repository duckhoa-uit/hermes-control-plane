# Architecture

**Status:** Flue-native single Worker; coding tasks use finite Flue Workflows.
Updated 2026-07-22.

## Decision

There is one deployed application, not two independent agent runtimes. Hermes
is the conversational orchestrator. Flue owns durable model/workflow
execution. This Worker is the trusted CodeOps boundary around Flue: it owns
task idempotency, admission, approval, GitHub credentials, and publication.

“Control Plan” is the existing service and Worker name. It is not a second
AI control plane that competes with Hermes or re-implements Flue scheduling.
The same Worker contains the MCP adapter, Flue Workflows, domain Durable
Objects, GitHub boundary, and Sandbox integration.

```text
User / Slack / Hermes automation
              |
              v
        Hermes Agent
   intent, context, clarification,
   workflow selection, reporting
              |
              | authenticated remote HTTP MCP
              v
  CodeOps Worker (Hono + Flue)
   |- MCP adapter: auth, idempotency, admission
   |- coding-task Workflow (new work)
   |- pr-review / sentry-triage Workflows
   |- task + approval + admission Durable Objects
   |- trusted GitHub App / publication Actions
   `- replay and run observation adapters
              |
              v
       Flue private agent profile
              |
              v
     Cloudflare Sandbox container
       git, shell, files, tests
```

## Ownership

| Layer | Owns | Does not own |
|---|---|---|
| Hermes | User conversation, intent, planning, clarification, channel context, reporting | GitHub credentials, sandbox execution, publication lease |
| MCP adapter | Authentication, repository authorization, idempotency, task correlation, admission | Model reasoning or a second scheduler |
| Flue Workflow | Finite run lifecycle, model/tool loop, structured input/output, run events | GitHub write credentials or human approval policy |
| Task/Approval DOs | Domain correlation, publication lease, approval records, cancellation and admission bookkeeping | Full Flue event history or model context |
| Sandbox | Repository files and OS commands | GitHub writes and PR creation |
| Worker GitHub boundary | Installation tokens, commit/push/PR operations, branch and manifest checks | Untrusted model decisions |

## Workflow inventory

| Workflow | Purpose | Side effects |
|---|---|---|
| `coding-task` | Implement one bounded repository task, run checks, and optionally publish through `finalize_change` | Sandbox writes; GitHub publication only through trusted Worker policy |
| `pr-review` | Review a caller-supplied bounded PR snapshot | Read-only; no GitHub fetch/comment/approval |
| `sentry-triage` | Analyze a caller-supplied bounded Sentry issue/event snapshot | Read-only; no Sentry mutation or code publication |

Coding work is a finite Workflow because it has a clear start, bounded task
input, structured result, and terminal outcome. The private Flue Agent is an
implementation detail of that Workflow; there is no addressable Agent runtime
or compatibility dispatch path.

## Coding lifecycle

1. Hermes calls `spawn_coding_task` once with `owner/repo`, a self-contained
   prompt, and optional stable idempotency key.
2. The MCP adapter authorizes the GitHub App installation, resolves the base
   branch, creates the durable task record and deterministic
   `control-plan/<prefix>` branch, and acquires a global admission lease.
3. The adapter calls Flue's ambient `invoke(codingTaskWorkflow, { input })`.
   It does not make an HTTP request back to this Worker. The task stores the
   returned Flue `runId` as a correlation pointer.
4. Flue initializes the private coding profile, provisions the task-bound
   Sandbox workspace, loads repository instructions and the coding skill, and
   runs the model loop.
5. The model may call `finalize_change` only after checks pass. That Action
   validates the task/session/branch, approval policy, manifest, and atomic
   publication lease before the Worker performs a GitHub write through the
   internal `PublicationService`; it does not self-fetch the public Worker.
   The signed `/proxy/*` routes remain a compatibility boundary for external
   or diagnostic callers and use the same service.
6. The task record stores publication metadata. `get_coding_task` uses Flue's
   ambient `getRun(runId)` plus the task record to reconcile a validated
   terminal result. Hermes polls until `lifecycle.terminal` is true.
7. `published`, `no_change`, and `blocked` are explicit structured outcomes;
   a run ending without a valid outcome is not successful completion.

`created`, `dispatching`, `dispatched`, `publishing`, and
`cancellation_requested` are active states. `publishing` means the task-owned
GitHub lease has been acquired and cancellation cannot revoke that write.

## Specialist lifecycle

Hermes (or a future verified connector) assembles a bounded snapshot and calls
`start_pr_review` or `start_sentry_triage`. The adapter validates the snapshot
and invokes the matching Flue Workflow with ambient `invoke()`. Hermes polls
`get_specialist_workflow`, which reads the run with ambient `getRun()` and
returns only the allowlisted specialist workflows. The current GitHub webhook
is acknowledgement-only, and Sentry has no direct Worker ingress yet; neither
path silently creates coding tasks.

```text
verified event / Hermes context
          -> bounded snapshot
          -> specialist Workflow
          -> structured read-only result
          -> Hermes reports or decides whether to delegate coding
```

## Security boundary

The Sandbox is untrusted. It receives only a short-lived repository-scoped
read token for checkout. It never receives a GitHub write token, approval
decision, or direct push/PR tool. GitHub writes happen in trusted Worker code
after task binding, branch/base validation, manifest limits, publication
policy, and the task-owned atomic lease are checked. Exceptional operations
also require a real ApprovalDO record and native Hermes MCP elicitation.

MCP, replay, proxy, and Workflow capabilities use purpose-specific signed
tokens. A replay token cannot authorize a GitHub write. The current replay and
approval UI is single-operator oriented; it is not a general multi-user IAM
system.

## Durable Objects and migrations

The Worker exports `Sandbox`, `ApprovalDurableObject`,
`ControlPlanTaskDurableObject`, `ControlPlanAdmissionDurableObject`, the PR
index, and Flue-generated Workflow classes. The task class is the coding-job
domain record, not a second workflow engine.

Migration `v8-remove-addressable-agent` deletes the old `FlueControlPlanAgent`
namespace. It is a destructive pre-release cleanup, not a compatibility
adapter; no new or existing task is routed through that class.

Do not rename the deployed Worker or Durable Object classes casually. A new
Worker name would create a separate deployment and orphan state. A future
rename requires an explicit state-preserving migration and staged smoke test.

## External surfaces

Hermes uses the authenticated `/mcp` endpoint. Flue HTTP routes and `/runs` are
internal/diagnostic surfaces protected by scoped capabilities; application code
uses ambient Flue primitives for same-Worker invocation and inspection. The
replay stream proxy is intentionally the only browser-facing seam coupled to
Flue's stream wire format.

GitHub webhooks currently verify and acknowledge only. If direct event-driven
automation is enabled later, it must normalize and deduplicate the event,
invoke an explicit Workflow, and document whether Hermes remains in the loop.
It must not bypass the GitHub write boundary.

## Source map

- MCP adapter: `src/mcp/control-plan.ts`, `src/mcp/specialist-workflows.ts`
- Workflows: `src/workflows/coding-task.ts`, `src/workflows/pr-review.ts`,
  `src/workflows/sentry-triage.ts`
- Domain state: `src/do/coding-task-do.ts`, `src/do/approval-do.ts`,
  `src/do/admission-do.ts`
- Coding profile and skill: `src/agent/control-plan-agent-config.ts`,
  `src/agents/control-plan.md`, `src/skills/control-plan-coding-task/SKILL.md`
- Trusted publication: `src/agent/control-plan-finalize-action.ts`,
  `src/agent/publication-service.ts`, `src/app.ts`,
  `src/agent/github-api-push.ts`
- Custom trace spans: `src/core/tracing.ts` around admission, Flue invoke/run
  inspection, Sandbox setup/prepare, and GitHub publication.
- Verified event ingress: `src/channels/github.ts`
