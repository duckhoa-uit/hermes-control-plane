// ============================================================
// Hermes Control Plane — Hono app (Flue user app)
// ============================================================
// Flue CLI generates `.flue-vite/_entry.ts` which imports this as
// the user-defined HTTP handler. DO routing + Pi harness is handled
// by Flue's generated `FlueHermesAgent`.
//
// Routes:
//   GET  /health                 → health check
//   POST /agents/:name/:id       → handled by Flue's flue() middleware
//   GET  /agents/:name/:id       → SSE stream (Flue)
//   POST /proxy/git-push         → credential-isolated git push
//   POST /proxy/create-pr        → credential-isolated PR creation

import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { Octokit } from "@octokit/rest";

const app = new Hono<{ Bindings: Env }>();

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// ─── Flue agent router ─────────────────────────────────────────────────────
// Mounts agent dispatch + event stream routes:
//   POST /agents/:name/:id → dispatch agent (202)
//   GET  /agents/:name/:id → DS event stream

app.route("/", flue());

// ─── Proxy: Git Push ───────────────────────────────────────────────────────
// Credential isolation: agent calls this endpoint, Worker injects token.

app.post("/proxy/git-push", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { branch, headSha, force } = body as Record<string, unknown>;
  if (!branch || !headSha) return c.json({ error: "branch and headSha required" }, 400);
  const token = c.env.GITHUB_WRITE_TOKEN;
  const owner = c.env.GITHUB_OWNER;
  const repo = c.env.GITHUB_REPO;
  if (!token || !owner || !repo) return c.json({ error: "GitHub not configured" }, 500);
  try {
    const octokit = new Octokit({ auth: token });
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: headSha as string,
      force: Boolean(force),
    });
    return c.json({ success: true, branch, sha: headSha });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 502);
  }
});

// ─── Proxy: Create PR ──────────────────────────────────────────────────────

app.post("/proxy/create-pr", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { title, body: prBody, branch, baseBranch } = body as Record<string, unknown>;
  if (!title || !branch) return c.json({ error: "title and branch required" }, 400);
  const token = c.env.GITHUB_WRITE_TOKEN;
  const owner = c.env.GITHUB_OWNER;
  const repo = c.env.GITHUB_REPO;
  if (!token || !owner || !repo) return c.json({ error: "GitHub not configured" }, 500);
  try {
    const octokit = new Octokit({ auth: token });
    const pr = await octokit.rest.pulls.create({
      owner,
      repo,
      title: title as string,
      body: (prBody as string) ?? "",
      head: branch as string,
      base: (baseBranch as string) ?? "main",
    });
    return c.json({ success: true, prUrl: pr.data.html_url, prNumber: pr.data.number });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 502);
  }
});

export default app;
