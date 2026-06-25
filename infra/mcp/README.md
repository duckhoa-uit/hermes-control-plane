# Hermes Agent — MCP integration

`hermes-control-plane` plugs into the [NousResearch Hermes
Agent](https://github.com/NousResearch/hermes-agent) as an **MCP server**
+ **companion skill**. This is the Hermes-recommended path for external
HTTP capabilities (see `AGENTS.md` "The Footprint Ladder" §5 — MCP server,
not a core tool, not a Python plugin).

| Piece | What | Where |
|---|---|---|
| MCP server | Four tools wrapping the launcher + Worker HTTP API. Streamable HTTP transport. Bundled in the launcher (same Bun process, same port 8789). | `src/mcp/server.ts` |
| Companion skill | `SKILL.md` teaching Hermes when/how to use the four tools. Validated against Hermes' `_validate_frontmatter` + the "Skill authoring HARDLINE" rules. | `skills/hermes-control-plane/SKILL.md` |

## Install

Two edits to your Hermes setup:

### 1. Register the MCP server

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  hermes-control-plane:
    # When Hermes Agent runs on the same VPS as control-plane-launcher (the
    # default deployment shape — see docs/DEPLOYMENT.md §13.2):
    url: "http://localhost:8789/mcp"
    timeout: 300

    # When the launcher is on a different host, expose its port 8789
    # via Cloudflare Tunnel (docs/DEPLOYMENT.md §14.3) and use the tunnel
    # URL instead:
    # url: "https://launcher.<your-domain>/mcp"
```

### 2. Register the companion skill

Add to the same `~/.hermes/config.yaml`:

```yaml
skills:
  external_dirs:
    - /opt/hermes-control-plane/src/skills        # adjust to where you cloned this repo
```

(Use the absolute path Hermes will find at boot. The `install.sh` script
puts the source at `/opt/hermes-control-plane/src` by default.)

### 3. Restart Hermes

```bash
# CLI
exit             # leave the running session
hermes           # boot again

# or for the gateway / systemd installs
sudo systemctl restart hermes
```

### 4. Verify

In a Hermes chat, run:

```text
What MCP tools do you have access to?
```

You should see the four tools from `hermes-control-plane`. Then try the
real flow:

```text
In duckhoa-uit/hermes-control-plane, append 'mcp integration verified'
to README.md.
```

Hermes should call `start_coding_task` and post the resulting PR URL back
into the chat.

## Smoke test the MCP server directly (no Hermes needed)

```bash
# Start launcher locally (dummy E2B creds are fine — we only test MCP)
E2B_API_KEY=dummy ZAI_API_KEY=dummy \
CONTROL_PLANE_BASE_URL=http://localhost:8787 \
E2B_TEMPLATE=control-plane-runner bun run launcher &

# initialize
curl -sX POST http://localhost:8789/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2025-06-18",
    "capabilities":{},
    "clientInfo":{"name":"smoke","version":"0"}
  }}'

# list tools
curl -sX POST http://localhost:8789/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Should return the four tools with full input schemas.

## Why MCP and not a Hermes plugin or core tool?

From `hermes-agent/AGENTS.md` "The Footprint Ladder":

> Prefer, in order: extend existing → CLI command + skill → service-gated
> tool → plugin → **MCP server in the catalog** → new core tool (last
> resort).

`hermes-control-plane` is an external HTTP service holding long-lived
secrets (E2B API key, operator's GitHub PAT, Z.AI API key). It already
runs as a separate process. Wrapping it as an MCP server is exactly the
shape that ladder rung is designed for: zero permanent Hermes-core
schema footprint, reusable by any MCP host (not just Hermes), and
isolated from the agent process's failure modes.

A Hermes plugin (rung 4) would require an in-process Python wrapper that
just shells out HTTP calls — same effect, more layers. A core tool
(rung 6) would be paid for on every API call by every Hermes user, which
is forbidden for non-fundamental capabilities.
