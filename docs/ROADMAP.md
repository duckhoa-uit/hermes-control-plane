# Roadmap

## Done (2026-07-12)

- [x] Migrate from E2B/OpenCode/Bun Launcher to Flue + Cloudflare Sandbox.
- [x] Establish the Hermes → remote HTTP MCP → Control Plan boundary.
- [x] Persist idempotent coding-task records and reconcile paged Flue events.
- [x] Upgrade Sandbox to `0.12.3` with RPC transport and default sessions disabled.
- [x] Verify a real Docker-backed task against `duckhoa-uit/lawn` through MCP.
- [x] Bind GitHub publication to each task's repository/base branch and deterministic branch.
- [x] Add scoped private-repository clone access and durable concurrency admission.
- [x] Verify MCP tasks against both `duckhoa-uit/lawn` and `NousResearch/hermes-agent` locally.

## Next

- [ ] Configure and smoke-test a real Hermes host against the deployed MCP URL.
- [ ] Stage the Worker rename/state-preserving Durable Object migration.
- [ ] Run a staged approval, GitHub push, and PR smoke test with production secrets.
- [x] Keep GitHub webhook events acknowledgement-only; Hermes owns triage and task creation.
- [ ] Add PR lifecycle follow-up and profile-scoped repository policy management.
