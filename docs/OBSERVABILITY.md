# Observability runbook

How to see what the control plane is doing in production, and what to do
when it goes wrong. Aimed at an on-call engineer (or an autonomous
agent) responding to a page, not at a developer reading docs cold.

For the structured logger + redaction + request-id contract, see
[`CONTRIBUTING.md` §Observability](../CONTRIBUTING.md#observability). For the
HTTP API + event-type vocabulary referenced below, see
[`docs/api-reference.md`](api-reference.md) and
[`docs/events-reference.md`](events-reference.md).

---

## 1. Dashboards

| Service | URL | What it shows |
|---|---|---|
| Cloudflare Workers | https://dash.cloudflare.com/?to=workers — pick `hermes-control-plane` → **Metrics** | Request rate, CPU time p50/p99, error rate (4xx + 5xx), bytes egressed. The default panels are sufficient for the "is the Worker up" question. |
| Cloudflare Worker Logs (live) | https://dash.cloudflare.com/?to=workers — pick the Worker → **Logs** → **Live** | Tail of NDJSON log lines from `src/core/logger.ts`. Filter by `service`, `requestId`, `sessionId`. |
| Cloudflare Worker Logpush | https://dash.cloudflare.com/?to=workers → **Logs** → **Logpush** | Optional sink to S3 / R2 / GCS / Datadog / Splunk / New Relic / Sumo for long-term retention. Today we sample 10 % (`head_sampling_rate: 0.1` in `wrangler.jsonc`); bump that to 1.0 in production if you need full-fidelity tracing. |
| Durable Object storage usage | Same Worker → **Settings** → **Durable Objects** | Per-class storage bytes; spot a runaway session that's pinning event log rows. |
| Launcher VPS — systemd | `ssh launcher && journalctl -u hermes-launcher -f -o cat \| jq` | NDJSON from the Bun sidecar. Same `service`/`requestId` fields as the Worker, so an `X-Request-Id` from a Worker log line can be grepped here. |
| GitHub Actions | https://github.com/duckhoa-uit/hermes-control-plane/actions | Build/deploy history, deploy markers, the auto-doc-refresh + flag-audit cron runs. |
| GitHub webhook deliveries | Repo → **Settings** → **Webhooks** → click the row → **Recent Deliveries** | When auto-amend doesn't fire, this is the first place to look. Each delivery shows the `X-GitHub-Event`, `X-Hub-Signature-256`, and the Worker's response body. |

If you're using an external sink (Datadog / Axiom / Better Stack), add
its URL into this table in the same PR that wires up the Logpush
destination — agents read this table first.

---

## 2. Alerts

The repo ships two configurable notification channels driven by the
deploy workflow + the alert-rules file:

| Channel | Secret | Used by |
|---|---|---|
| Slack incoming webhook | `SLACK_DEPLOY_WEBHOOK` | `.github/workflows/deploy-worker.yml` posts on deploy start / success / failure. |
| PagerDuty Events V2 routing key | `PAGERDUTY_ROUTING_KEY` | Triggered on deploy failure with `event_action: trigger` and a `dedup_key` of `deploy-worker-<sha>`. |

The actual alert thresholds live in
[`infra/observability/alerts.yaml`](../infra/observability/alerts.yaml) so
they're version-controlled, code-reviewable, and inspectable by an agent
that doesn't have console access. The file declares what should page
and at what threshold; an operator wires it into Cloudflare Notifications
(workers-rule sources) and/or PagerDuty service rules manually.

### Configuring Slack

1. Create a Slack channel — `#hermes-deploys` is the convention.
2. Add an Incoming Webhook integration; copy the URL.
3. `gh secret set SLACK_DEPLOY_WEBHOOK --body 'https://hooks.slack.com/services/...'`.
4. Trigger a `workflow_dispatch` run of `deploy-worker.yml` to confirm.

### Configuring PagerDuty

1. Create a **PagerDuty service** "Hermes Control Plane — deploys".
2. Add an **Events API V2** integration; copy the routing key.
3. `gh secret set PAGERDUTY_ROUTING_KEY --body '<routing-key>'`.
4. Optional: also wire the same routing key to Cloudflare Notifications
   for the rules in `infra/observability/alerts.yaml`.

When both secrets are unset, the deploy workflow still runs — the
notification steps no-op via `if: env.X != ''` guards. Useful for forks
and local PR testing.

---

## 3. Runbooks

### Deploy failed

1. Open the GH Actions run linked in the Slack / PagerDuty payload.
2. Look at the failing step: `bunx wrangler deploy`, `bun run lint`,
   `bun run typecheck`, or `bun run bundle:size`. Each fails with a
   distinct payload — typecheck dumps the `tsc` errors inline.
3. If the cause is a runtime regression caught by `wrangler deploy`
   (e.g. an invalid binding), revert with
   `git revert -m 1 <merge-sha> && git push`. The next push triggers
   a redeploy.
4. If the cause is `wrangler` rate-limiting or a transient CF outage,
   re-run the job (`Actions → Re-run failed jobs`). Don't touch code.
5. After resolution: add a postmortem note to `docs/ROADMAP.md` if the
   failure mode is novel.

### Worker error rate > 5 % over 5 min

1. Open the **Logs → Live** view in Cloudflare; filter by `level: error`.
2. The `requestId` on each line gives you a stable correlation key.
   Grep the launcher's `journalctl` for the same id to follow the
   request across the boundary.
3. Common causes by error class:
   - `request.failed` with `error: HTTP 401|503` from GitHub → check
     the PAT secret has not been rotated. Rotate it via the launcher's
     systemd unit env (`infra/launcher/`) and `wrangler secret put`.
   - `request.failed` with `error: HTTP 5xx` from E2B → check
     https://status.e2b.dev. The launcher's circuit breaker
     (`src/core/resilience.ts`) will already be failing fast — wait for
     it to half-open.
   - `request.failed` with `error: webhook unauthorized` → GitHub
     webhook secret mismatch (likely from a stale `GITHUB_WEBHOOK_SECRET`
     vs the repo's webhook config).

### Launcher down

1. SSH to the VPS; `systemctl status hermes-launcher`.
2. `journalctl -u hermes-launcher -n 200 -o cat | jq` for the last
   batch of NDJSON.
3. Restart with `systemctl restart hermes-launcher`. The DO will
   re-resume any paused sessions on the next prompt.
4. If `systemctl status` says "active (running)" but the Worker still
   gets connection-refused on `LAUNCHER_URL`, check the Cloudflare
   Tunnel — `cloudflared tunnel list` on the VPS.

### Sandbox sweeper killing too aggressively

1. Symptom: PRs failing intermittently because the sandbox vanished
   mid-publish.
2. Read the launcher logs for `e2b.list` retries + breaker trips. A
   stale Worker that's returning 404 on `/sessions/:id` causes the
   sweeper to kill anything tied to that id — verify the Worker is
   reachable.
3. Mitigation: set `FF_SWEEPER_DISABLED=1` on the launcher (kill
   switch wired through `src/core/feature-flags.ts`) and restart.
   Investigate while the killer is off.

### Auto-amend session not spawning

1. Open **Repo Settings → Webhooks → hermes-control-plane** → click
   the most recent `pull_request_review` delivery.
2. Verify the response was `200`. If `401` → HMAC mismatch (see
   §"Worker error rate" #c above). If `2xx` but no session appeared,
   check the Worker logs for `[webhook]` lines — a `skip` decision
   (e.g. `cap_exceeded`, `single_flight_locked`) tells you what
   blocked it.
3. Cap raised by `AUTOFIX_CAP_PER_PR` (default 3 amend sessions per
   PR). Bump in `wrangler.jsonc` `vars` if necessary.

---

## 4. Where the signals come from (source of truth)

- HTTP-level logs/metrics → `src/core/logger.ts` + Worker entrypoint at
  `src/worker/index.ts:fetch`.
- Session-state-machine events → `src/core/state-machine.ts` (allowed
  transitions) + `src/core/event-log.ts` (per-event storage). Vocabulary
  in `docs/events-reference.md`.
- External call failures → wrapped via `src/core/resilience.ts`
  (circuit breaker + retry). Breaker trips emit `breaker.open` log
  lines tagged with `name`.
- Deploy markers → `.github/workflows/deploy-worker.yml`.
- Webhook deliveries → `src/worker/github-webhook.ts` + GitHub UI.

---

## 5. Adding a new alert

1. Append the rule to
   [`infra/observability/alerts.yaml`](../infra/observability/alerts.yaml).
   Include the metric / log selector, the threshold, and a one-line
   runbook pointer that links back to this file.
2. Mirror it into Cloudflare Notifications or PagerDuty in the same PR.
3. Open a PR; the lint workflow has no schema for alerts.yaml today —
   if it tightens later, document the new gate here.

Keep alerts boring: if it doesn't have a runbook entry above, it should
not page. Pages without runbooks turn into noise.
