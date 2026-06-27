# Dev container

This directory configures a reproducible development environment for
the repo. Anything that opens a [Development Container]
(https://containers.dev) — VS Code with the **Remote – Containers**
extension, Cursor, GitHub Codespaces, JetBrains Gateway, or an
autonomous agent that boots a container to work on the repo — will get:

- **Debian + Node 22** (the base image
  `mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm`).
  Node 22 matches the E2B sandbox interior runtime.
- **Bun** (latest) — the canonical package manager. The lockfile is
  `bun.lock`; CI uses `bun install --frozen-lockfile`.
- **GitHub CLI** (`gh`) — used by the deployment runbook and several
  scripts that open PRs / inspect runs.
- Editor extensions for Biome (formatter), Oxlint (linter),
  EditorConfig, and the Cloudflare Workers runtime.
- Format-on-save with Biome and Oxlint autofix-on-save.

## What runs automatically

- `postCreateCommand` — once after the container builds:
  `bun install --frozen-lockfile`.
- `postAttachCommand` — every time the workspace is attached:
  `bun run setup`. This is the idempotent bootstrap defined in
  `package.json`; it verifies tooling, copies `.dev.vars.example` →
  `.dev.vars` if missing, and runs lint + typecheck + tests so the
  first thing you see in the terminal is the project's actual state.

## Ports forwarded

| Port | Service | Started by |
|---|---|---|
| 8787 | Worker | `bun run dev` (`wrangler dev`) |
| 8789 | Launcher sidecar | `bun run launcher` |

## Using it

### VS Code / Cursor

1. Install the **Dev Containers** extension.
2. Open the repo folder.
3. Command Palette → **Dev Containers: Reopen in Container**.

### GitHub Codespaces

Click the green **Code** button → **Codespaces** → **Create
codespace on main**. Codespaces reads `.devcontainer/devcontainer.json`
automatically.

### Direct container

```bash
docker run -it --rm \
  -v "$PWD":/workspaces/hermes-control-plane \
  -w /workspaces/hermes-control-plane \
  mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm \
  bash -lc "curl -fsSL https://bun.sh/install | bash && exec bash"
```

(The dev container features / editor extensions only apply when a
Dev-Containers-aware client is driving — `docker run` directly skips
them. Use Codespaces / VS Code for the full experience.)

## Secrets

The container doesn't ship secrets. Fill in `.dev.vars` after the
first attach — see `.dev.vars.example` for the annotated list. In
Codespaces, prefer the
[encrypted Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-secrets-for-your-codespaces)
UI over committing values.
