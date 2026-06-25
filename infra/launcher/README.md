# Launcher VM setup

Three files in this directory:

| File | Purpose |
|---|---|
| `install.sh` | One-shot bootstrap for a fresh Debian/Ubuntu VM. Creates the `hermes` user, installs bun, lays out `/opt/hermes` and `/etc/hermes`, drops the systemd unit. |
| `hermes-launcher.service` | systemd unit. Loads `/etc/hermes/launcher.env`, runs `bun /opt/hermes/launcher.js` as the `hermes` user, restarts on crash. |
| `env.example` | Template for `/etc/hermes/launcher.env`. Copy + fill in real values. |

See `docs/SETUP.md` §10.2 for the env block this file documents, and
§10.5 for locking the launcher behind a Cloudflare Tunnel.

## Quick install (on the VM, as root)

```bash
git clone https://github.com/duckhoa-uit/hermes-control-plane.git /tmp/hcp
cd /tmp/hcp
sudo bash infra/launcher/install.sh

# Drop secrets
sudo cp infra/launcher/env.example /etc/hermes/launcher.env
sudo chmod 600 /etc/hermes/launcher.env
sudo chown hermes:hermes /etc/hermes/launcher.env
sudo $EDITOR /etc/hermes/launcher.env       # paste real values

# Paste your GitHub App PEM
sudo install -o hermes -g hermes -m 0600 /path/to/app.pkcs8.pem /etc/hermes/app.pkcs8.pem

# Ship the bundle (built on a dev machine)
#   dev:  bun build src/launcher/server.ts --target=bun --outfile dist/launcher.js
#   dev:  scp dist/launcher.js root@vm:/opt/hermes/launcher.js
sudo chown hermes:hermes /opt/hermes/launcher.js

# Light it up
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-launcher
sudo journalctl -u hermes-launcher -f
```

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
