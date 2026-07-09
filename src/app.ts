// ============================================================
// Hermes Control Plane — Hono app (Flue user app)
// ============================================================
//
// Routes:
//   GET  /health                     → health check
//   POST /proxy/git-push             → credential-isolated git push
//   POST /proxy/create-pr            → credential-isolated PR creation
//   GET  /sessions/:id/replay        → static replay HTML
//   GET  /sessions/:id/stream        → proxy Flue agent event stream (SSE)
//   GET  /approvals/:id              → pending approval payload
//   POST /approvals/:id              → approve/deny decision
//   GET  /sessions/:id/approvals/open → list open approvals
//
// Flue auto-mounts (via `flue()` + src/channels/github.ts):
//   POST /channels/github/webhook    → GitHub webhook (HMAC verified)
//   POST /agents/hermes/:id          → Agent dispatch
//   GET  /agents/hermes/:id          → Agent event stream

import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { Octokit } from "@octokit/rest";
import { verifyToken, signToken } from "./core/auth";
import { isPushManifest, pushManifestWithGitHubApi } from "./agent/github-api-push";
import { installModelProgressWatchdog } from "./agent/runtime-watchdog";

type AppEnv = { Bindings: Env };
const app = new Hono<AppEnv>();

installModelProgressWatchdog();

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", ts: Date.now() }));

// ─── Flue routes ───────────────────────────────────────────────────────────

app.route("/", flue());

// ─── Proxy: Git Push ───────────────────────────────────────────────────────

app.post("/proxy/git-push", async (c) => {
  if (!(await isAuthorizedProxyRequest(c.req.raw, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  if (!isPushManifest(body)) return c.json({ error: "valid push manifest required" }, 400);
  const token = c.env.GITHUB_WRITE_TOKEN;
  const owner = c.env.GITHUB_OWNER;
  const repo = c.env.GITHUB_REPO;
  if (!token || !owner || !repo) return c.json({ error: "GitHub not configured" }, 500);
  try {
    const octokit = new Octokit({ auth: token });
    const result = await pushManifestWithGitHubApi(octokit, owner, repo, body);
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 502);
  }
});

// ─── Proxy: Create PR ──────────────────────────────────────────────────────

app.post("/proxy/create-pr", async (c) => {
  if (!(await isAuthorizedProxyRequest(c.req.raw, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const { title, body: prBody, branch, baseBranch } = body as Record<string, unknown>;
  if (!title || !branch) return c.json({ error: "title and branch required" }, 400);
  const token = c.env.GITHUB_WRITE_TOKEN;
  const owner = c.env.GITHUB_OWNER;
  const repo = c.env.GITHUB_REPO;
  if (!token || !owner || !repo) return c.json({ error: "GitHub not configured" }, 500);
  try {
    const octokit = new Octokit({ auth: token });
    const existing = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch as string}`,
      base: (baseBranch as string) ?? "main",
      state: "open",
      per_page: 1,
    });
    if (existing.data[0]) {
      return c.json({
        success: true,
        prUrl: existing.data[0].html_url,
        prNumber: existing.data[0].number,
        existing: true,
      });
    }

    const pr = await octokit.rest.pulls.create({
      owner,
      repo,
      title: title as string,
      body: (prBody as string) ?? "",
      head: branch as string,
      base: (baseBranch as string) ?? "main",
    });
    return c.json({
      success: true,
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
      existing: false,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 502);
  }
});

// ─── Session Replay ────────────────────────────────────────────────────────

app.get("/replay/:id", async (c) => {
  const sessionId = c.req.param("id");
  const token = c.req.query("token") || "";
  const secret = c.env.GITHUB_WEBHOOK_SECRET;

  const valid = await verifyToken(secret, sessionId, token);
  if (!valid) {
    return c.text("Unauthorized: invalid or missing token", 401);
  }

  return c.html(REPLAY_HTML);
});

// ─── Session Stream proxy ──────────────────────────────────────────────────
// FLUE-STREAM-SEAM: this route + the long-poll client in REPLAY_HTML are the
// ONLY places coupled to Flue's stream wire format (?offset=&live= +
// Stream-Next-Offset). When upgrading to beta.10, port this seam to
// history()/observe() and keep the browser-facing contract unchanged.
// See docs/FLUE-BETA10-MIGRATION.md.
//
// Auth-gated SSE proxy that forwards to Flue's agent stream.
// The replay HTML connects here instead of directly to /agents/hermes/:id
// so we can enforce token access. Uses raw ReadableStream to avoid buffering.

app.get("/sessions/:id/stream", async (c) => {
  const sessionId = c.req.param("id");
  const token = c.req.query("token") || "";
  const secret = c.env.GITHUB_WEBHOOK_SECRET;

  const valid = await verifyToken(secret, sessionId, token);
  if (!valid) return c.text("Unauthorized", 401);

  const offset = c.req.query("offset") || "-1";
  const live = c.req.query("live") || "sse";
  const tail = c.req.query("tail") || "";

  let fluePath = `/agents/hermes/${sessionId}?offset=${encodeURIComponent(offset)}&live=${encodeURIComponent(live)}`;
  if (tail) fluePath += `&tail=${encodeURIComponent(tail)}`;

  // We use a raw fetch to the Flue route so Hono doesn't buffer SSE
  const req = new Request(new URL(fluePath, c.req.url), {
    headers: { Accept: "text/event-stream, application/json" },
  });

  try {
    const resp = await app.fetch(req, c.env, c.executionCtx);
    const headers = new Headers(resp.headers);
    headers.set("Cache-Control", "no-cache");
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(resp.body, { status: resp.status, headers });
  } catch {
    return new Response("stream unavailable", { status: 502 });
  }
});

// ─── Approval endpoints ────────────────────────────────────────────────────

app.get("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  const doId = c.env.APPROVAL_DO.idFromName("approvals");
  const stub = c.env.APPROVAL_DO.get(doId);
  const resp = await stub.fetch(new URL(`/get?id=${encodeURIComponent(id)}`, c.req.url));
  if (!resp.ok) return c.json({ error: "not found" }, 404);
  return c.json(await resp.json());
});

app.post("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { decision, actor } = body as { decision?: string; actor?: string };

  if (!decision || !["once", "session", "always", "deny", "timeout"].includes(decision)) {
    return c.json({ error: "decision must be once|session|always|deny|timeout" }, 400);
  }

  const doId = c.env.APPROVAL_DO.idFromName("approvals");
  const stub = c.env.APPROVAL_DO.get(doId);
  const resp = await stub.fetch(new URL("/resolve", c.req.url), {
    method: "POST",
    body: JSON.stringify({ id, decision, actor: actor || "web" }),
  });
  return c.json(await resp.json());
});

app.get("/sessions/:id/approvals/open", async (c) => {
  const sessionId = c.req.param("id");
  const token = c.req.query("token") || "";
  const secret = c.env.GITHUB_WEBHOOK_SECRET;

  if (!(await verifyToken(secret, sessionId, token))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const doId = c.env.APPROVAL_DO.idFromName("approvals");
  const stub = c.env.APPROVAL_DO.get(doId);
  const resp = await stub.fetch(
    new URL(`/list-open?session_id=${encodeURIComponent(sessionId)}`, c.req.url),
  );
  return c.json(await resp.json());
});

// ─── Helpers ───────────────────────────────────────────────────────────────

export async function generateReplayUrl(env: Env, sessionId: string): Promise<string> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  const token = await signToken(secret, sessionId);
  const base = env.WORKER_URL || "";
  return `${base}/replay/${sessionId}?token=${token}`;
}

async function isAuthorizedProxyRequest(request: Request, env: Env): Promise<boolean> {
  const sessionId = request.headers.get("X-Hermes-Session-Id") || "";
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return verifyToken(env.GITHUB_WEBHOOK_SECRET, sessionId, token);
}

// ─── Inlined Replay HTML ──────────────────────────────────────────────────

const REPLAY_HTML = (() => {
  // Read the replay index.html at module init time if available
  // In production, the HTML is embedded here via a build step.
  // For dev, we serve a working minimal version inline.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Replay — Hermes</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px; }
  .header { border-bottom: 1px solid #21262d; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 20px; color: #f0f6fc; }
  .header .meta { font-size: 13px; color: #8b949e; margin-top: 4px; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .status-badge.running { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
  .status-badge.completed { background: #23863633; color: #3fb950; border: 1px solid #238636; }
  .status-badge.failed { background: #da363333; color: #f85149; border: 1px solid #da3633; }
  .status-badge.needs_approval { background: #d2992233; color: #d29922; border: 1px solid #d29922; }
  .status-badge.connecting { background: #8b949e33; color: #8b949e; border: 1px solid #8b949e; }
  .timeline { position: relative; padding-left: 24px; }
  .timeline::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 2px; background: #21262d; }
  .event { position: relative; margin-bottom: 16px; }
  .event::before { content: ''; position: absolute; left: -20px; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: #30363d; border: 2px solid #21262d; }
  .event.turn::before { background: #58a6ff; border-color: #1f6feb; }
  .event.tool::before { background: #7ee787; border-color: #238636; }
  .event.approval::before { background: #d29922; border-color: #9e6a03; }
  .event.error::before { background: #f85149; border-color: #da3633; }
  .event.data-event::before { background: #bc8cff; border-color: #8957e5; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px 16px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .card-type { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-type.turn { color: #58a6ff; } .card-type.tool { color: #7ee787; }
  .card-type.approval { color: #d29922; } .card-type.error { color: #f85149; }
  .card-type.data-event { color: #bc8cff; }
  .card-time { font-size: 11px; color: #484f58; }
  .card-body { font-size: 13px; line-height: 1.5; }
  .card-body pre { background: #0d1117; border: 1px solid #21262d; border-radius: 4px; padding: 8px 12px; overflow-x: auto; margin: 8px 0; font-size: 12px; }
  .card-body code { background: #0d1117; border-radius: 3px; padding: 1px 4px; font-size: 12px; }
  .tool-duration { font-size: 11px; color: #8b949e; }
  .tool-result summary { cursor: pointer; font-size: 12px; color: #8b949e; }
  .tool-result pre { max-height: 200px; overflow-y: auto; margin-top: 4px; }
  .approval-card { border-color: #9e6a03; }
  .btn { padding: 6px 14px; border: 1px solid; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .btn-approve-once { background: #238636; color: #fff; border-color: #238636; }
  .btn-approve-once:hover { background: #2ea043; }
  .btn-approve-session { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .btn-approve-session:hover { background: #388bfd; }
  .btn-approve-always { background: #6e7681; color: #fff; border-color: #6e7681; }
  .btn-approve-always:hover { background: #848d97; }
  .btn-deny { background: #da3633; color: #fff; border-color: #da3633; }
  .btn-deny:hover { background: #f85149; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .resolved-badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 4px; }
  .resolved-badge.approved { background: #23863633; color: #3fb950; }
  .resolved-badge.denied { background: #da363333; color: #f85149; }
  .resolved-badge.timeout { background: #6e768133; color: #8b949e; }
  .empty-state { text-align: center; padding: 48px 0; color: #8b949e; }
  .loading-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .text-delta-stream { white-space: pre-wrap; word-break: break-word; margin-top: 8px; padding: 8px 12px; background: #0d1117; border-radius: 4px; font-size: 13px; max-height: 400px; overflow-y: auto; }
  .thinking-block { background: #1c2128; border-left: 3px solid #8b949e; padding: 8px 12px; margin: 8px 0; border-radius: 0 4px 4px 0; color: #8b949e; font-size: 12px; cursor: pointer; }
  .thinking-block summary { font-style: italic; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Session Replay</h1>
    <div class="meta">
      <span>Session: <strong id="session-id">—</strong></span>
      <span style="margin-left:16px">Status: <span id="status-badge" class="status-badge connecting">connecting</span></span>
      <span style="margin-left:16px" id="event-count">0 events</span>
    </div>
  </div>
  <div id="timeline" class="timeline">
    <div class="empty-state"><span class="loading-spinner"></span> Connecting to event stream...</div>
  </div>
</div>
<script>
(function() {
  var SID = (function() { var parts = window.location.pathname.split("/"); var i = parts.indexOf("replay"); return i >= 0 && parts[i+1] ? parts[i+1] : ""; })();
  var TOKEN = new URLSearchParams(window.location.search).get('token') || '';

  if (!SID) { document.getElementById('timeline').innerHTML = '<div class="empty-state" style="color:#f85149">Missing session id.</div>'; return; }
  document.getElementById('session-id').textContent = SID;

  var timeline = document.getElementById('timeline');
  var firstEvent = true, eventCount = 0;
  var turnMap = {}, approvalMap = {}, toolEls = {};
  var lastTime = '';

  function postDecision(aid, dec) {
    return fetch('/approvals/' + aid, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({decision: dec, token: TOKEN, actor:'web'})
    }).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); });
  }

  window.decide = function(aid, dec) {
    var entry = approvalMap[aid];
    if (!entry || !entry.pending) return;
    var btns = entry.el.querySelectorAll('.btn');
    for (var i=0;i<btns.length;i++) btns[i].disabled = true;
    var statusDiv = entry.el.querySelector('.decision-status');
    if (statusDiv) statusDiv.textContent = 'Submitting...';
    postDecision(aid, dec).then(function() {
      resolveUI(aid, dec);
    }).catch(function(err) {
      if (statusDiv) statusDiv.innerHTML = '<span style="color:#f85149">Error: ' + esc(err.message) + '</span>';
      for (var i=0;i<btns.length;i++) btns[i].disabled = false;
    });
  };

  function resolveUI(aid, dec) {
    var entry = approvalMap[aid];
    var el = entry ? entry.el : document.getElementById('approval-' + aid);
    if (!el) return;
    if (entry) entry.pending = false;
    var card = el.querySelector('.card'), btns = card.querySelectorAll('.btn');
    for (var i=0;i<btns.length;i++) btns[i].disabled = true;
    var sd = el.querySelector('.decision-status');
    if (sd) sd.innerHTML = '<span class="resolved-badge ' + (dec==='deny'?'denied':dec==='timeout'?'timeout':'approved') + '">' + dec.toUpperCase() + '</span>';
    document.getElementById('status-badge').textContent = 'running';
    document.getElementById('status-badge').className = 'status-badge running';
  }

  function renderApproval(id, payload) {
    var el = mkEvent('approval');
    el.id = 'approval-' + id;
    var type = payload.type || 'command';
    var title = payload.title || 'Unknown';
    var cmd = payload.command || payload.cmd || '';
    var diff = payload.diff || '';
    el.innerHTML = '<div class="card approval-card">' +
      '<div class="card-header"><span class="card-type approval">APPROVAL REQUIRED</span><span class="card-time">' + now() + '</span></div>' +
      '<div class="card-body">' +
        '<div style="margin-bottom:8px"><strong>' + esc(type.toUpperCase()) + ':</strong> ' + esc(title) + '</div>' +
        (cmd ? '<pre>' + esc(trunc(cmd,500)) + '</pre>' : '') +
        (diff ? '<pre>' + esc(trunc(diff,2000)) + '</pre>' : '') +
        '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-approve-once" data-aid="' + id + '" data-dec="once">Allow once</button>' +
          '<button class="btn btn-approve-session" data-aid="' + id + '" data-dec="session">Allow session</button>' +
          '<button class="btn btn-approve-always" data-aid="' + id + '" data-dec="always">Allow always</button>' +
          '<button class="btn btn-deny" data-aid="' + id + '" data-dec="deny">Deny</button>' +
        '</div>' +
        '<div class="decision-status" style="margin-top:8px;font-size:12px;color:#8b949e"></div>' +
      '</div></div>';
    timeline.appendChild(el);
    approvalMap[id] = {el: el, pending: true};
    var btns = el.querySelectorAll('.btn');
    for (var bi = 0; bi < btns.length; bi++) {
      btns[bi].addEventListener('click', function(e) {
        var t = e.currentTarget;
        decide(t.getAttribute('data-aid'), t.getAttribute('data-dec'));
      });
    }
    document.getElementById('status-badge').textContent = 'needs_approval';
    document.getElementById('status-badge').className = 'status-badge needs_approval';
  }

  // ── Approval poller ─────────────────────────────────────────────────
  // ApprovalDO is the source of truth for approvals. We poll the open list
  // instead of relying on stream data events (Flue removes emitData()/data-*
  // parts in beta.8). handleData() below stays only as a legacy fallback.
  function pollApprovals() {
    fetch('/sessions/' + SID + '/approvals/open?token=' + encodeURIComponent(TOKEN))
      .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(res) {
        var open = (res && res.approvals) || [];
        var openIds = {};
        for (var i = 0; i < open.length; i++) {
          var a = open[i];
          openIds[a.id] = true;
          if (!approvalMap[a.id]) {
            if (firstEvent) { timeline.innerHTML = ''; firstEvent = false; }
            var p = a.payload || {};
            renderApproval(a.id, { type: a.type, title: a.title, command: p.command, diff: p.diff, metadata: p.metadata });
          }
        }
        // Locally-pending approval no longer open → resolved elsewhere; fetch decision
        for (var aid in approvalMap) {
          if (approvalMap[aid].pending && !openIds[aid]) fetchDecision(aid);
        }
      })
      .catch(function() { /* transient; retry next tick */ })
      .then(function() { setTimeout(pollApprovals, 4000); });
  }

  function fetchDecision(aid) {
    fetch('/approvals/' + aid)
      .then(function(r) { return r.json(); })
      .then(function(row) {
        if (row && row.status && row.status !== 'pending') {
          resolveUI(aid, row.decision || row.status);
        }
      })
      .catch(function() { /* retry on next poll */ });
  }

  function handleData(ev) {
    // Legacy fallback (pre-beta.8 data events); approvals now come from pollApprovals()
    // Flue data event shape: { type:'data', name:'X', id:'...', data:{...payload}, timestamp, ... }
    var name = ev.name || 'unknown';
    var data = ev.data || {};
    if (name === 'approval_requested' || name === 'approval_request') {
      renderApproval(data.id || ev.id || ('ar-' + eventCount), data);
      return;
    }
    if (name === 'approval_resolved') {
      resolveUI(data.id || ev.id, data.decision || 'unknown');
      return;
    }
    var el = mkEvent('data-event');
    el.innerHTML = '<div class="card"><div class="card-header"><span class="card-type data-event">DATA: ' + esc(name) + '</span><span class="card-time">' + fmt(ev.timestamp) + '</span></div>' +
      '<div class="card-body"><pre>' + esc(trunc(JSON.stringify(data,null,2),1000)) + '</pre></div></div>';
    timeline.appendChild(el);
  }

  function handleEvent(ev) {
    eventCount++; document.getElementById('event-count').textContent = eventCount + ' events';
    if (firstEvent) { timeline.innerHTML = ''; firstEvent = false; }
    var type = ev.type || ev.eventType;
    switch (type) {
      case 'agent_start': addEv('turn', 'Agent started', ''); setBadge('running'); break;
      case 'agent_end': addEv('turn', 'Agent ended', ''); setBadge('completed'); break;
      case 'turn_start': turnStart(ev); break;
      case 'turn': turnEnd(ev); break;
      case 'tool_start': toolStart(ev); break;
      case 'tool': toolEnd(ev); break;
      case 'text_delta': textD(ev); break;
      case 'thinking_start': case 'thinking_delta': case 'thinking_end': thinkD(ev); break;
      case 'message_start': /* silent */ break;
      case 'message_end': msgEnd(ev); break;
      case 'turn_messages': /* silent — covered by message_end */ break;
      case 'operation_start': case 'operation': case 'idle': case 'submission_settled': /* silent */ break;
      case 'data': handleData(ev); break;
      case 'log': addEv('data-event', 'Log', ev.attributes?.message || ev.level || ''); break;
      default: if (type) addEv(ev.error?'error':'data-event', type, ev.error || ''); break;
    }
  }

  function turnStart(ev) {
    var el = mkEvent('turn');
    el.innerHTML = '<div class="card"><div class="card-header"><span class="card-type turn">TURN</span><span class="card-time">' + fmt(ev.timestamp) + '</span></div>' +
      '<div class="card-body"><strong>' + (ev.purpose || 'agent') + '</strong> turn started' +
      (ev.request?.model ? ' <span style="color:#8b949e">· model: ' + ev.request.model + '</span>' : '') +
      '<div class="deltas"></div></div></div>';
    timeline.appendChild(el);
    if (ev.turnId) turnMap[ev.turnId] = {el:el, card: el.querySelector('.card'), deltas: el.querySelector('.deltas')};
  }

  function turnEnd(ev) {
    var t = turnMap[ev.turnId];
    if (t && t.card) {
      var h = t.card.querySelector('.card-header');
      if (h) h.innerHTML += '<span class="tool-duration">' + (ev.durationMs ? (ev.durationMs/1000).toFixed(1)+'s' : '') + '</span>';
    }
  }

  function toolStart(ev) {
    var el = mkEvent('tool');
    el.id = 't-' + (ev.toolCallId || eventCount);
    el.innerHTML = '<div class="card"><div class="card-header"><span class="card-type tool">TOOL: ' + esc(ev.toolName||'?') + '</span><span class="card-time">' + fmt(ev.timestamp) + '</span></div>' +
      '<div class="card-body"><div style="color:#8b949e;font-size:12px">args: ' + esc(trunc(JSON.stringify(ev.args),300)) + '</div><div class="tres"></div></div></div>';
    timeline.appendChild(el);
    toolEls[ev.toolCallId] = el;
  }

  function toolEnd(ev) {
    var el = toolEls[ev.toolCallId];
    if (!el) { var e2 = mkEvent('tool'); e2.innerHTML = '<div class="card"><div class="card-header"><span class="card-type ' + (ev.isError?'error':'tool') + '">TOOL: ' + esc(ev.toolName||'?') + '</span><span class="card-time">' + fmt(ev.timestamp) + '</span></div><div class="card-body"></div></div>'; timeline.appendChild(e2); return; }
    var h = el.querySelector('.card-header'); if (h) h.innerHTML += '<span class="tool-duration">' + (ev.durationMs?(ev.durationMs/1000).toFixed(1)+'s':'') + '</span>';
    if (ev.isError && h) h.querySelector('.card-type').className = 'card-type error';
    var tres = el.querySelector('.tres');
    if (tres && ev.result !== undefined) {
      var str = typeof ev.result==='string' ? ev.result : JSON.stringify(ev.result);
      if (str.length > 0) tres.innerHTML = '<details class="tool-result"><summary>Result (' + str.length + ' chars)</summary><pre>' + esc(trunc(str,2000)) + '</pre></details>';
    }
  }

  function textD(ev) {
    if (!ev.turnId || !ev.text) return;
    var t = turnMap[ev.turnId]; if (!t || !t.deltas) return;
    var se = t.deltas.querySelector('.text-stream');
    if (!se) { se = document.createElement('div'); se.className = 'text-delta-stream'; t.deltas.appendChild(se); }
    se.textContent += ev.text;
  }

  function thinkD(ev) {
    if (!ev.turnId) return;
    var t = turnMap[ev.turnId]; if (!t || !t.deltas) return;
    var idx = ev.contentIndex || 0;
    var te = t.deltas.querySelector('.think-' + idx);
    if (!te) {
      te = document.createElement('details');
      te.className = 'thinking-block think-' + idx;
      te.open = true;
      te.innerHTML = '<summary>Thinking...</summary><div class="tc" style="white-space:pre-wrap;padding:4px 0;font-style:normal;color:#c9d1d9"></div>';
      t.deltas.appendChild(te);
    }
    var tc = te.querySelector('.tc');
    if (!tc) return;
    if (ev.type === 'thinking_start') { tc.textContent = ev.text || ''; return; }
    if (ev.type === 'thinking_delta') { tc.textContent += ev.text || ''; return; }
    // thinking_end may contain final 'content' or 'text'
    if (ev.type === 'thinking_end') {
      if (ev.content) tc.textContent = ev.content;
      else if (ev.text) tc.textContent = ev.text;
    }
  }

  function msgEnd(ev) {
    if (!ev.turnId || ev.message?.role !== 'assistant') return;
    var t = turnMap[ev.turnId]; if (!t || !t.card) return;
    var body = t.card.querySelector('.card-body');
    var txt = extractText(ev.message.content);
    if (txt && body && !body.querySelector('.msg-out')) {
      var div = document.createElement('div'); div.className = 'msg-out';
      div.style.cssText = 'margin-top:8px;padding:8px 12px;background:#0d1117;border-radius:4px;font-size:13px;white-space:pre-wrap;max-height:300px;overflow-y:auto';
      div.textContent = txt.slice(0,4000); body.appendChild(div);
    }
  }

  function extractText(c) {
    if (typeof c==='string') return c;
    if (Array.isArray(c)) return c.filter(function(x){return x.type==='text'}).map(function(x){return x.text||''}).join('\\n');
    return '';
  }

  function addEv(cls, type, body) {
    var el = mkEvent(cls);
    el.innerHTML = '<div class="card"><div class="card-header"><span class="card-type '+cls+'">'+esc(type)+'</span><span class="card-time">'+lastTime+'</span></div>'+(body?'<div class="card-body">'+esc(String(body))+'</div>':'')+'</div>';
    timeline.appendChild(el);
  }

  function mkEvent(cls) { var d = document.createElement('div'); d.className = 'event ' + cls; return d; }
  function fmt(ts) { if(!ts)return''; try{return new Date(ts).toLocaleTimeString()}catch(e){return String(ts)} }
  function now() { return new Date().toLocaleTimeString(); }
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function trunc(s,n) { return s&&s.length>n ? s.slice(0,n)+'...' : s; }
  function setBadge(s) { document.getElementById('status-badge').textContent = s; }

  // Connect via long-poll
  // FLUE-STREAM-SEAM: offset/Stream-Next-Offset protocol — changes with beta.10
  var offset = '-1';
  var dbg = document.getElementById('timeline');

  function log(msg) {
    var d = document.createElement('div');
    d.textContent = '[dbg] ' + msg;
    d.style.cssText = 'color:#58a6ff;font-size:11px;padding:4px 0';
    dbg.appendChild(d);
  }

  function pollEvents() {
    var url = '/sessions/' + SID + '/stream?token=' + encodeURIComponent(TOKEN) + '&offset=' + offset + '&live=long-poll';
    log('fetch ' + url.slice(0,80) + '...');
    fetch(url)
      .then(function(r) {
        log('status ' + r.status + ' next-offset=' + r.headers.get('Stream-Next-Offset'));
        if (r.status === 204) { setTimeout(pollEvents, 500); return; }
        if (!r.ok) { setBadge('error ' + r.status); document.getElementById('status-badge').className = 'status-badge failed'; setTimeout(pollEvents, 3000); return; }
        return r.json().then(function(events) {
          log('got ' + events.length + ' events');
          var next = r.headers.get('Stream-Next-Offset');
          if (next) offset = next;
          events.forEach(handleEvent);
          setBadge('running'); document.getElementById('status-badge').className = 'status-badge running';
          setTimeout(pollEvents, 300);
        });
      })
      .catch(function(err) {
        log('ERR: ' + (err.message || err));
        setTimeout(pollEvents, 2000);
      });
  }
  log('starting poll...');
  pollEvents();
  pollApprovals();
})();
</script>
</body>
</html>`;
})();

export default app;
