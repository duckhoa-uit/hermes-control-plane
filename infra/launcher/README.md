# Launcher VM setup

Three files in this directory:

| File | Purpose |
|---|---|
| `install.sh` | One-shot bootstrap for a fresh Debian/Ubuntu VPS. Creates the `hermes-cp` user, installs bun + cloudflared, clones this repo, builds `launcher.js`, drops the systemd unit, copies `env.example` to `/etc/hermes-control-plane/launcher.env`. Idempotent — re-run to update the bundle from the latest `main`. |
| `hermes-launcher.service` | systemd unit. Loads `/etc/hermes-control-plane/launcher.env`, runs `bun /opt/hermes-control-plane/launcher.js` as the `hermes-cp` user, restarts on crash. |
| `env.example` | Template for `/etc/hermes-control-plane/launcher.env`. Copy + fill in real values. |

See `docs/SETUP.md` §10.2 for the env block this file documents, and
§10.5 for locking the launcher behind a Cloudflare Tunnel.

## Quick install (on the VM, as root)

One command (skip cloning by hand — `install.sh` does it):

```bash
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo bash
```

Or pin a tag (recommended for repeatable installs):

```bash
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo HERMES_REPO_REF=v0.4.0 bash
```

`install.sh` is idempotent: re-run to refresh `launcher.js` from the latest
`main`. The `env.example` file is only copied on first run — your filled-in
`/etc/hermes-control-plane/launcher.env` is preserved on re-runs.

After it finishes, the script prints the 7 remaining manual steps:

1. Edit `/etc/hermes-control-plane/launcher.env` with real secrets.
2. Drop GitHub App PEM at `/etc/hermes-control-plane/app.pkcs8.pem`.
3. `sudo systemctl enable --now hermes-launcher`.
4. Smoke-test: `curl http://localhost:8789/health`.
5. Set up Cloudflare Tunnel for `launcher.<your-domain>` → `localhost:8789`.
6. From your dev machine: `wrangler secret put HERMES_LAUNCHER_URL`, then `bun run deploy`.
7. Wire Hermes Agent → MCP server + skill: edit `~/.hermes/config.yaml` with `mcp_servers.hermes-control-plane.url: http://localhost:8789/mcp` and `skills.external_dirs: [/opt/hermes-control-plane/src/skills]`. Full runbook: [`infra/mcp/README.md`](../mcp/README.md).

You should see:

```
[launcher] startup sweep: scanned=0 killed=0 kept=0
[launcher] hermes-launcher listening on http://localhost:8789
[launcher]   worker = https://hermes-control-plane.<your-sub>.workers.dev
[launcher]   public = https://hermes-control-plane.<your-sub>.workers.dev
```

## Reachability from the Worker

The Worker DO posts to the launcher when resuming a paused sandbox. The
launcher's `8789` therefore needs to be reachable from Cloudflare-owned
IPs. Three options, from simplest to most locked-down:

1. **Open port 8789 on the VM, no auth.** Quick and dirty. Anyone on
   the internet who guesses the URL can `POST /sessions` and burn your
   credits. **Don't do this.**
2. **Cloudflare Tunnel** (recommended). Run `cloudflared tunnel run`
   on the VM bound to `localhost:8789`; the launcher binds to
   `127.0.0.1` only. Put the tunnel behind the same Zero Trust app as
   the Worker, with `/sessions/*/resume` as a Bypass path so the DO can
   reach it without a human cookie. Free.
3. **Tailscale + private IP.** Both the Worker and the launcher live
   on a Tailscale net; the launcher binds to its Tailscale IP. Cleanest
   when both ends are yours.

Option 2 is documented in `docs/SETUP.md` §10.5 "Locking the launcher
too". Option 3 requires reaching the launcher from the Worker, which
needs a Cloudflare-side Tailscale subnet router — out of scope for the
1-user release.
