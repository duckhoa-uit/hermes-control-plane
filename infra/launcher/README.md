# Launcher VM setup

Three files in this directory:

| File | Purpose |
|---|---|
| `install.sh` | One-shot bootstrap for a fresh Debian/Ubuntu VPS. Creates the `hermes-cp` user, installs bun + cloudflared, clones this repo, builds `launcher.js`, drops the systemd unit, and writes `/etc/hermes-control-plane/launcher.env` (prompts interactively for the 6 secrets, or reads them from env vars if already exported, or just drops the template when run non-interactively / with `CONTROL_PLANE_NO_PROMPT=1`). Idempotent — re-run to update the bundle from the latest `main`. |
| `control-plane-launcher.service` | systemd unit. Loads `/etc/hermes-control-plane/launcher.env`, runs `bun /opt/hermes-control-plane/launcher.js` as the `hermes-cp` user, restarts on crash. |
| `env.example` | Template for `/etc/hermes-control-plane/launcher.env`. Copy + fill in real values. |

See [`docs/DEPLOYMENT.md §13.2`](../../docs/DEPLOYMENT.md#132-launcher-any-always-on-host)
for the env block this file documents, and [`§14.3`](../../docs/DEPLOYMENT.md#143-locking-the-launcher-too-recommended)
for locking the launcher behind a Cloudflare Tunnel.

## Quick install (on the VM, as root)

One command (skip cloning by hand — `install.sh` does it):

```bash
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo bash
```

Or pin a tag (recommended for repeatable installs):

```bash
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo CONTROL_PLANE_REPO_REF=v0.4.0 bash
```

`install.sh` is idempotent: re-run to refresh `launcher.js` from the latest
`main`. Your filled-in `/etc/hermes-control-plane/launcher.env` is
preserved on re-runs (the prompts only fire when the file is missing
or still contains `REPLACE_ME` placeholders).

Three ways to provide the secrets:

```bash
# 1. Interactive (default when you `ssh` in and run the script with a TTY)
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo bash
# install.sh asks for E2B_API_KEY, ZAI_API_KEY, GITHUB_WRITE_TOKEN,
# GITHUB_READ_TOKEN, GITHUB_USER_LOGIN, GITHUB_USER_EMAIL (optional),
# WORKER_URL (default: the deployed Worker URL).

# 2. Pre-exported env vars (good when piping into bash):
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo E2B_API_KEY=... ZAI_API_KEY=... GITHUB_WRITE_TOKEN=... \
         GITHUB_READ_TOKEN=... GITHUB_USER_LOGIN=duckhoa-uit \
         WORKER_URL=https://hermes-control-plane.duckhoa-dev.workers.dev \
         bash

# 3. Skip prompts entirely — drop the env.example template and edit by hand later:
curl -fsSL .../install.sh | sudo CONTROL_PLANE_NO_PROMPT=1 bash
```


After it finishes, the script prints the 6 remaining manual steps:

1. Edit `/etc/hermes-control-plane/launcher.env` with real secrets.
2. `sudo systemctl enable --now control-plane-launcher`.
3. Smoke-test: `curl http://localhost:8789/health`.
4. Set up Cloudflare Tunnel for `launcher.<your-domain>` → `localhost:8789`.
5. From your dev machine: mirror the launcher secrets onto the Worker:
   ```bash
   echo "<tunnel-url>" | bun x wrangler secret put LAUNCHER_URL
   ssh <vps> 'sudo grep ^LAUNCHER_SHARED_SECRET= /etc/hermes-control-plane/launcher.env | cut -d= -f2-' \
     | bun x wrangler secret put LAUNCHER_SHARED_SECRET
   bun run deploy
   ```
   `LAUNCHER_SHARED_SECRET` MUST be byte-identical on both sides; the Worker uses it to authenticate `POST /sessions` and `POST /sessions/:id/resume` calls to the launcher, and the launcher uses it on the inbound `x-hermes-launcher-secret` header check. A mismatch surfaces as `dispatched: false, reason: "launcher_401"` in webhook responses.
6. Wire Hermes Agent → MCP server + skill: edit `~/.hermes/config.yaml` with `mcp_servers.hermes-control-plane.url: http://localhost:8789/mcp` and `skills.external_dirs: [/opt/hermes-control-plane/src/skills]`. Full runbook: [`infra/mcp/README.md`](../mcp/README.md).

You should see:

```
[launcher] startup sweep: scanned=0 killed=0 kept=0
[launcher] control-plane-launcher listening on http://localhost:8789
[launcher]   worker = https://hermes-control-plane.<your-sub>.workers.dev
[launcher]   public = https://hermes-control-plane.<your-sub>.workers.dev
```

## Quick tunnel (no domain, no CF account)

Need a public URL for `LAUNCHER_URL` before you own a domain?
Pass `CONTROL_PLANE_QUICK_TUNNEL=1` to `install.sh` — it installs and
starts a TryCloudflare quick tunnel as a second systemd unit:

```bash
curl -fsSL https://raw.githubusercontent.com/duckhoa-uit/hermes-control-plane/main/infra/launcher/install.sh \
  | sudo CONTROL_PLANE_QUICK_TUNNEL=1 \
         E2B_API_KEY=... ZAI_API_KEY=... GITHUB_WRITE_TOKEN=... \
         GITHUB_READ_TOKEN=... \
         GITHUB_USER_LOGIN=... WORKER_URL=https://...workers.dev \
         bash
```

The installer waits up to 30 s for cloudflared to emit the URL and prints
it. To re-fetch later:

```bash
sudo /opt/hermes-control-plane/quick-tunnel-url.sh           # current URL
sudo /opt/hermes-control-plane/quick-tunnel-url.sh --wait 60 # block 60s
```

**Caveats** — TryCloudflare is for bootstrapping only:

- URL is random and **changes every cloudflared restart**. After a restart
  you must re-run `wrangler secret put LAUNCHER_URL` + `bun
  run deploy` for the Worker DO's resume path to keep working.
- No Cloudflare Access wall — anyone who guesses the URL can `POST
  /sessions` against your launcher. Treat the URL as a (weak) secret.
- Cloudflare documents `trycloudflare.com` as "for testing only, not
  production". Upgrade to a named tunnel + Access (`docs/DEPLOYMENT.md §14`)
  once you own a domain.

The unit is installed even without `CONTROL_PLANE_QUICK_TUNNEL=1` (so you
can start it later with `sudo systemctl enable --now
control-plane-quick-tunnel`); it just isn't auto-started.

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

Option 2 is documented in [`docs/DEPLOYMENT.md §14.3`](../../docs/DEPLOYMENT.md#143-locking-the-launcher-too-recommended)
"Locking the launcher too". Option 3 requires reaching the launcher from the Worker, which
needs a Cloudflare-side Tailscale subnet router — out of scope for the
1-user release.
