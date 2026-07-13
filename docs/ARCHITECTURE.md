# Architecture

**Status:** Production-candidate Control Plan execution service; Hermes MCP
integration audited 2026-07-14.

## Current deployment

The code is a single Cloudflare Worker using Flue. Hermes remains the upstream
orchestrator and calls Control Plan through remote HTTP MCP after it has already
triaged an issue and produced a coding prompt.

```text
GitHub webhook
    |
    v
Control Plan Worker (Hono + Flue)
    |- FlueControlPlanAgent Durable Object
    |- ApprovalDurableObject
    |- ControlPlanTaskDurableObject
    |- ControlPlanAdmissionDurableObject
    |- PrIndexDurableObject
    |- GitHub App auth + credential-isolated GitHub write routes
    |
    v
Cloudflare Sandbox container
    |- git and shell
    `- dependency install, build, and tests
```

## Current components

| Component | Responsibility | Location |
|---|---|---|
| Flue coding agent | Durable model/tool loop and deterministic finalize call | `src/agents/control-plan.ts` |
| GitHub channel | Verify and acknowledge GitHub webhooks; no direct task dispatch policy yet | `src/channels/github.ts` |
| Approval store | Durable approval decisions and finalize checkpoints | `src/do/approval-do.ts` |
| Task store | Repository/base-branch/isolated-branch correlation, result metadata, stream offset | `src/do/coding-task-do.ts` |
| Admission store | Global concurrent-task limit with expiring leases | `src/do/admission-do.ts` |
| PR index | Durable pull-request lookup | `src/do/pr-index-do.ts` |
| GitHub App/write boundary | Resolve installation access and publish manifests/create PRs without exposing a write token to the sandbox | `src/agent/github-app.ts`, `src/app.ts`, `src/agent/github-api-push.ts` |
| Sandbox | Isolated repository checkout and command execution | `src/cf-sandbox/Dockerfile` |

The Worker currently exports these Durable Object classes:

- `Sandbox`
- `PrIndexDurableObject`
- `ApprovalDurableObject`
- `ControlPlanTaskDurableObject`
- `ControlPlanAdmissionDurableObject`
- `FlueRegistry`
- `FlueControlPlanAgent`

`FLUE_REGISTRY` and `FlueRegistry` are two bindings for the same generated Flue
class, not two independent classes.

## Current lifecycle

1. Hermes calls `spawn_coding_task` with a repository, optional base branch,
   idempotency key, and the root-cause coding prompt.
2. Control Plan verifies that a GitHub App installation grants access to the
   repository, resolves/verifies the base branch, then persists the task and
   allocates `control-plan/<task-prefix>`, then admits it under the global
   concurrency lease.
3. Control Plan dispatches `/agents/control-plan/:id`; Flue runs the model/tool
   loop in its Durable Object.
4. `clone_repository` mints a short-lived GitHub App installation token scoped
   to the task repository and performs a task-bound clone into Sandbox.
5. The agent prepares a validated file manifest. `APPROVAL_MODE=policy` allows
   normal `control-plan/*` pushes and draft PRs after checks; force pushes,
   sensitive paths, non-task branches, and non-draft PRs pause for native
   Hermes MCP elicitation. `manual` pauses every publication.
6. When approval is required, the Hermes gateway receives the server-initiated
   `elicitation/create` request. Control Plan records only the gateway result,
   never a model-supplied approval hint.
7. The Worker resolves the task's repository and branch before publishing the
   commit through GitHub's Git Database API.
8. The Worker creates or reuses the draft pull request and persists commit/PR result
   metadata for Hermes polling.
9. GitHub webhooks remain acknowledgement-only; they do not bypass Hermes.

## Security boundary

Sandbox code is untrusted. It receives only a short-lived, repository-scoped
GitHub App read token for the clone command and never receives a write token.
Privileged GitHub writes happen only in the Worker after a purpose-bound,
short-lived proxy capability, task binding, installation authorization,
base-branch validation, and manifest limits are validated. Approval is an
additional policy gate for exceptional publication; normal policy-mode draft
publication is intentionally autonomous but remains restricted to the task
branch. Replay and internal Flue capabilities use different secrets and cannot
be exchanged.

The replay and approval UI uses signed session URLs. This is sufficient for the
current single-operator model, but it is not a multi-user authorization model.

## Hermes Agent target boundary

Hermes Agent is the upstream orchestrator. It owns request interpretation,
planning, user interaction, and the decision to delegate coding work. Control
Plan remains the coding-agent execution service: it creates a Flue session,
holds durable task and approval state, and performs credential-isolated GitHub
writes. Flue and the Cloudflare Sandbox remain part of the execution path.

```text
User, channel, or automation
             |
             v
        Hermes Agent
             |
             | remote HTTP MCP tool call
             v
Control Plan Worker (Hono + Flue)
    |- task/approval correlation
    |- FlueControlPlanAgent Durable Object
    |- Approval DO and PR index
    `- GitHub App auth + credential-isolated GitHub write boundary
             |
             v
 Cloudflare Sandbox container
```

Control Plan exposes a remote HTTP MCP server; Hermes configures that server as
an MCP client and calls only its allowlisted tools. Hermes automatically
discovers remote MCP tools, so no Hermes core fork or in-Worker Hermes client is
needed. The Hermes HTTP Runs API is for the inverse topology—an external client
starts and monitors Hermes work—and is not used here. The detailed contract and
rollout gates are in
[`HERMES-AGENT-INTEGRATION.md`](./HERMES-AGENT-INTEGRATION.md).

### Initial MCP surface

| Tool | Responsibility |
|---|---|
| `spawn_coding_task` | Verify GitHub App repository access, create a Control Plan task ID, and dispatch a Flue coding session |
| `get_coding_task` | Read durable task status, replay URL, and pending approval summary |
| `respond_coding_approval` | Require native Hermes elicitation for non-deny decisions, then resolve the ApprovalDO record |
| `cancel_coding_task` | Abort the Flue submission and block publication for the task |

The task ID is the stable correlation key across Hermes, Flue, ApprovalDO, and
GitHub. MCP responses are intentionally small; the replay stream remains the
detailed operational record.

## Deployment identity

The source/package name is `control-plan`. The existing Cloudflare Worker name
remains `hermes-control-plane` until a deliberate cutover transfers Durable
Object classes and re-creates secrets/routes for the new Worker script. Changing
`wrangler.name` alone would create a separate deployment and orphan live state.

## Release gates from the 2026-07-14 audit

The architecture passes its local test/type/lint/build gates and a
Docker-backed Lawn task. The remaining release gates are environment and
operations checks, not an alternate issue-trigger architecture:

1. Configure a real Hermes profile with the production `/mcp` URL, service
   token, GitHub App-installed repository scope, and tool allowlist; run one
   smoke task.
2. Set the production `WORKER_URL` to the public HTTPS origin and configure the
   three purpose-specific capability secrets plus the GitHub App credentials.
   GitHub installation access and task-bound routing are both enforced at
   runtime.
3. Sandbox uses `@cloudflare/sandbox` and `docker.io/cloudflare/sandbox`
   `0.12.3`, with RPC transport and default sessions disabled. The migrated
   Docker path passed the Lawn task; production rollout still needs its
   Cloudflare environment smoke test.
4. The rename and local routes pass the Wrangler dry run, but the
   state-preserving Durable Object rename and live route still need a staged
   deploy and a real session/approval/PR smoke test before traffic is moved.

Primary platform references:

- [Hermes Agent programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Hermes Agent API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Cloudflare Sandbox 2026 migration guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/)
- [Cloudflare Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
