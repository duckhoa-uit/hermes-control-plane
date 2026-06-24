// ============================================================
// API Client - helper for testing Hermes Worker API
// ============================================================

const BASE_URL = process.argv[2] ?? "http://localhost:8787";

async function main() {
  const cmd = process.argv[3] ?? "help";

  switch (cmd) {
    case "health": {
      const r = await fetch(`${BASE_URL}/health`);
      console.log(await r.json());
      break;
    }

    case "create": {
      const taskDescription = process.argv[4] ?? "Fix failing tests";
      const repoUrl = process.argv[5] ?? "https://github.com/duckhoa-uit/hermes-control-plane";
      const projectId = process.argv[6] ?? "test-project";

      const r = await fetch(`${BASE_URL}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, taskDescription, repoUrl }),
      });
      const data = await r.json() as { id?: string; status?: string };
      console.log("Created session:", JSON.stringify(data, null, 2));
      console.log(`\nSession ID: ${data.id ?? "unknown"}`);
      console.log(`Status: ${data.status ?? "unknown"}`);
      break;
    }

    case "get": {
      const sessionId = process.argv[4];
      if (!sessionId) {
        console.error("Usage: get <session-id>");
        process.exit(1);
      }
      const r = await fetch(`${BASE_URL}/sessions/${sessionId}`);
      const data = await r.json() as { id?: string; status?: string };
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "approve": {
      const sessionId = process.argv[4];
      const requestId = process.argv[5];
      if (!sessionId || !requestId) {
        console.error("Usage: approve <session-id> <request-id>");
        process.exit(1);
      }
      const r = await fetch(`${BASE_URL}/sessions/${sessionId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      console.log(await r.json());
      break;
    }

    case "abort": {
      const sessionId = process.argv[4];
      if (!sessionId) {
        console.error("Usage: abort <session-id>");
        process.exit(1);
      }
      const r = await fetch(`${BASE_URL}/sessions/${sessionId}/abort`, {
        method: "POST",
      });
      console.log(await r.json());
      break;
    }

    case "create-pr": {
      const sessionId = process.argv[4];
      if (!sessionId) {
        console.error("Usage: create-pr <session-id>");
        process.exit(1);
      }
      const r = await fetch(`${BASE_URL}/sessions/${sessionId}/create-pr`, {
        method: "POST",
      });
      console.log(await r.json());
      break;
    }

    case "events": {
      const sessionId = process.argv[4];
      if (!sessionId) {
        console.error("Usage: events <session-id>");
        process.exit(1);
      }
      const wsUrl = `${BASE_URL.replace("http", "ws")}/sessions/${sessionId}/stream`;
      console.log(`Connecting to ${wsUrl}...`);
      const ws = new WebSocket(wsUrl);

      ws.addEventListener("open", () => console.log("[ws] Connected"));
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data as string);
        if (msg.type === "replay") {
          console.log(`[replay] ${msg.events.length} events:`);
          for (const ev of msg.events) {
            console.log(`  [${ev.seq}] ${ev.type} (${ev.source})`);
          }
        } else if (msg.type === "event") {
          const ev = msg.event;
          console.log(`  [${ev.seq}] ${ev.type} (${ev.source}) ${JSON.stringify(ev.payload).slice(0, 80)}`);
        } else if (msg.type === "session_state") {
          console.log(`[state] ${msg.session.status} (branch: ${msg.session.branch})`);
        }
      });
      ws.addEventListener("close", () => console.log("[ws] Disconnected"));
      break;
    }

    default:
      console.log(`Hermes API Client
Usage: bun run src/testing/api-client.ts <base-url> <command> [args]

Commands:
  health                          Check API health
  create <task> <repo> <project>  Create session
  get <session-id>                Get session state
  approve <session-id> <req-id>   Approve action
  abort <session-id>              Abort session
  create-pr <session-id>          Create PR
  events <session-id>             Stream events via WebSocket
`);
  }
}

main();
