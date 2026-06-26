<!-- AUTO-GENERATED FILE. Do not edit by hand.
     Source: src/worker/index.ts, src/launcher/server.ts
     Regenerate: bun run docs:gen
-->


# HTTP API reference

Auto-generated from the route dispatcher source. For a richer machine-readable contract see [`docs/openapi.yaml`](./openapi.yaml).

## Worker (Cloudflare)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Top-level fixed paths. |
| GET | `/` | Top-level fixed paths. |
| GET | `/pr-index` |  |
| POST | `/webhooks/github` |  |
| POST | `/sessions` |  |
| GET | `/sessions/{id}` |  |

## Launcher (Bun sidecar)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | /health: unauthenticated so operators can probe without provisioning a secret. Returns no sensitive state. |
| GET | `/mcp` | /mcp: served on the same port for transport reasons, but its trust boundary is the gateway (Hermes Agent) which carries its own auth. We intentionally do NOT gate /mcp with LAUNCHER_SHARED_SECRET — the gateway and the worker reach the launcher over separate paths. |
| POST | `/sessions` |  |
