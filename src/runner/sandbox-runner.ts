// Standalone runner that runs inside the E2B sandbox. Bundled into
// /opt/control-plane/runner.js by infra/e2b/build-template.ts and execed by the
// supervisor once per-session secrets arrive.
//
// M4 shape:
//   - Connects WS back to the SessionDurableObject (unchanged).
//   - Owns an OpencodeClient against the locally-running `opencode serve`
//     (the supervisor already started it; URL is OPENCODE_BASE_URL).
//   - On agent.prompt command:
//       1. Lazily creates an opencode session bound to /home/user/repo
//          (first turn) or reuses the same id (follow-up turns).
//       2. Spawns an SSE subscriber against /event?directory=REPO_DIR;
//          maps OpenCode events to Hermes event types and bridges them
//          over WS to the DO.
//       3. Calls `session.prompt` (blocking HTTP) — when it returns, the
//          turn is done; emits `runner.complete` with the AssistantMessage
//          tokens/cost as agent.usage.
//   - On pr.create command: unchanged (git push + REST).

import { WebSocket } from "ws";
import { exec as execCb } from "child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createEventMapper } from "./event-mapper";
import { parsePrMetadata, renderPrBody, type PrMetadata } from "./pr-metadata";

const SESSION_ID = process.env.CONTROL_PLANE_SESSION_ID;
const RUNNER_TOKEN = process.env.CONTROL_PLANE_RUNNER_TOKEN;
const CONTROL_WS = process.env.CONTROL_PLANE_WS;
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";
const MODEL_ID = process.env.OPENCODE_MODEL_ID || "glm-5.2";
const PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID || "zai-coding-plan";
const REPO_DIR = "/home/user/repo";

// §12.17 — Hermes runs unattended; pre-declare every tool as allowed so
// opencode never blocks on permission.asked. The default "build" agent
// allows "*" but adds edge-case asks (.env files, external_directory).
// Passing `tools` in session.prompt body builds explicit allow rules per
// tool with pattern "*", overriding the agent default + any user
// opencode.json in the cloned repo (per packages/opencode/src/session/prompt.ts:1163).
const ALLOW_ALL_TOOLS: Record<string, boolean> = {
  read: true,
  edit: true,
  write: true,
  bash: true,
  grep: true,
  glob: true,
  list: true,
  webfetch: true,
  websearch: true,
  todowrite: true,
  task: true,
};

if (!SESSION_ID || !RUNNER_TOKEN || !CONTROL_WS) {
  console.error("Missing required env vars (CONTROL_PLANE_SESSION_ID, CONTROL_PLANE_RUNNER_TOKEN, CONTROL_PLANE_WS)");
  process.exit(1);
}

const wsBaseUrl = CONTROL_WS
  .replace(/^http:\/\//, "ws://")
  .replace(/^https:\/\//, "wss://")
  .replace(/\/$/, "");
const wsUrl = wsBaseUrl + "/sessions/" + SESSION_ID + "/runner?token=" + RUNNER_TOKEN;

console.log("[runner] Initial connect to:", wsUrl);

// WebSocket manager — owns reconnect loop. Spec (M5 §12.14):
//   - exp backoff 500ms, 1s, 2s, 4s, 8s, cap 15s, total budget 60s
//   - re-read /opt/control-plane/start.json on each retry so a rotated runner
//     token (M5 follow-up) is picked up
//   - if budget exhausts, exit(1) so the supervisor babysit chain tears
//     the sandbox down cleanly
import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from "fs";
const RECONNECT_BACKOFFS_MS = [500, 1000, 2000, 4000, 8000, 15000];
const RECONNECT_TOTAL_BUDGET_MS = 60000;
let ws: WebSocket = new WebSocket(wsUrl);
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
let shuttingDown = false;

function refreshWsUrl(): string {
  // Re-read start.json so a rotated runner token (post-resume) is used.
  try {
    if (fsExistsSync("/opt/control-plane/start.json")) {
      const cfg = JSON.parse(fsReadFileSync("/opt/control-plane/start.json", "utf-8")) as Record<string, string>;
      const tok = cfg.CONTROL_PLANE_RUNNER_TOKEN;
      const cws = cfg.CONTROL_PLANE_WS;
      if (tok && cws) {
        const base = cws.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\/$/, "");
        return `${base}/sessions/${SESSION_ID}/runner?token=${tok}`;
      }
    }
  } catch {}
  return wsUrl; // fall back to initial
}

async function reconnect(): Promise<void> {
  if (reconnecting || shuttingDown) return;
  reconnecting = true;
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < RECONNECT_TOTAL_BUDGET_MS) {
    const delay = RECONNECT_BACKOFFS_MS[Math.min(attempt, RECONNECT_BACKOFFS_MS.length - 1)];
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
    const url = refreshWsUrl();
    console.log(`[runner] reconnect attempt ${attempt} -> ${url.slice(0, 80)}…`);
    try {
      const next = new WebSocket(url);
      const ok = await new Promise<boolean>((resolve) => {
        const onOpen = () => { cleanup(); resolve(true); };
        const onErr = () => { cleanup(); resolve(false); };
        const onClose = () => { cleanup(); resolve(false); };
        const cleanup = () => {
          next.off("open", onOpen);
          next.off("error", onErr);
          next.off("close", onClose);
        };
        next.on("open", onOpen);
        next.on("error", onErr);
        next.on("close", onClose);
      });
      if (ok) {
        console.log(`[runner] reconnect succeeded on attempt ${attempt} (${Date.now() - startedAt}ms)`);
        ws = next;
        attachHandlers();
        reconnecting = false;
        return;
      }
    } catch (err) {
      console.log(`[runner] reconnect attempt ${attempt} threw: ${(err as Error).message}`);
    }
  }
  console.error(`[runner] reconnect budget exhausted after ${attempt} attempts; exiting`);
  reconnecting = false;
  process.exit(1);
}

const opencode = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
let opencodeSessionId: string | null = null;
let sseAbort: AbortController | null = null;
// Track the *opencode* turn currently in flight, so SSE events outside it
// can be ignored (e.g. plugin.added bursts on first boot).
// We accumulate the most recent text/tool part state so we can emit
// transition events without re-sending payloads.
const seenToolCalls = new Set<string>();
// Sum tokens across turns; emitted as artifacts.usage at terminal.
const usageRollup: {
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; cost: number;
} = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

function sendEvent(eventType: string, eventPayload: Record<string, unknown>): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "runner.event",
    sessionId: SESSION_ID,
    payload: { eventType, eventPayload },
  }));
}

function sendComplete(payload: Record<string, unknown>): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "runner.complete", sessionId: SESSION_ID, payload }));
}

function sendError(error: string): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "runner.error", sessionId: SESSION_ID, payload: { error } }));
}

function execCmd(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { cwd: REPO_DIR }, (_err, stdout) => resolve(stdout || ""));
  });
}

function execStrict(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execCb(cmd, { cwd: REPO_DIR }, (err, stdout, stderr) => {
      if (err) reject(new Error(`exec failed (${cmd}): ${stderr || stdout || err.message}`));
      else resolve((stdout || "") + (stderr ? `\n${stderr}` : ""));
    });
  });
}

async function startSseSubscriber(): Promise<void> {
  if (sseAbort) return;
  sseAbort = new AbortController();
  const mapper = createEventMapper((e) => sendEvent(e.eventType, e.eventPayload));
  const url = `${OPENCODE_BASE_URL}/event?directory=${encodeURIComponent(REPO_DIR)}`;
  console.log("[runner] SSE subscribe:", url);

  // Use raw fetch with streaming body to read SSE frames. The SDK exposes
  // the same endpoint via client.event.subscribe(), but we want explicit
  // abort control + simple parsing without buffering an AsyncGenerator.
  fetch(url, { signal: sseAbort.signal, headers: { accept: "text/event-stream" } })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines; each frame has
        // `data: <json>` (single line).
        let nl;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const obj = JSON.parse(line.slice(5).trim()) as { type: string; properties?: Record<string, unknown> };
              mapper(obj);
            } catch {}
          }
        }
      }
    })
    .catch((err: Error) => {
      if (err.name !== "AbortError") {
        console.error("[runner] SSE error:", err.message);
      }
    });
}

async function ensureOpencodeSession(taskTitle: string): Promise<string> {
  if (opencodeSessionId) return opencodeSessionId;
  const resp = await opencode.session.create({
    body: { title: taskTitle.slice(0, 80) },
    query: { directory: REPO_DIR },
    throwOnError: true,
  });
  opencodeSessionId = resp.data.id;
  console.log("[runner] opencode session created:", opencodeSessionId);
  return opencodeSessionId;
}

interface AssistantMessageInfo {
  id?: string;
  modelID?: string;
  providerID?: string;
  finish?: string;
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  error?: { name?: string; message?: string } | unknown;
}

function rollUsage(info: AssistantMessageInfo | undefined): void {
  if (!info) return;
  const t = info.tokens || {};
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const reasoning = t.reasoning ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheWrite = t.cache?.write ?? 0;
  const total = t.total ?? input + output + reasoning;
  const cost = info.cost ?? 0;
  usageRollup.input += input;
  usageRollup.output += output;
  usageRollup.reasoning += reasoning;
  usageRollup.cacheRead += cacheRead;
  usageRollup.cacheWrite += cacheWrite;
  usageRollup.total += total;
  usageRollup.cost += cost;
  sendEvent("agent.usage", {
    modelID: info.modelID,
    providerID: info.providerID,
    tokens: { input, output, reasoning, total, cache: { read: cacheRead, write: cacheWrite } },
    cost,
    cumulative: { ...usageRollup },
  });
}

async function runPromptTurn(taskDescription: string, context: string): Promise<void> {
  await startSseSubscriber();
  const sid = await ensureOpencodeSession(taskDescription);
  // Hermes passes the user's task as `context` (already includes task body
  // per docs/ROADMAP.md §M1). Send it verbatim.
  let text = context || taskDescription;
  // Amend mode: prepend a directive so the agent does not try to open a
  // new PR. The runner enforces this in runPrCreation regardless, but
  // telling the model up-front avoids wasted turns talking about it.
  const amendBr = process.env.CONTROL_PLANE_PR_MODE_BRANCH || "";
  const amendNum = process.env.CONTROL_PLANE_PR_MODE_NUMBER || "";
  const amendUrl = process.env.CONTROL_PLANE_PR_MODE_URL || "";
  if (amendBr && amendNum && amendUrl) {
    // A5: choose a preamble tailored to the trigger class. Falls back
    // to the generic manual-follow-up text when no structured trigger
    // is supplied (which is the case for operator-driven follow-up
    // prompts via send_followup_prompt).
    const triggerKind = process.env.CONTROL_PLANE_AMEND_TRIGGER_KIND || "";
    const triggerJson = process.env.CONTROL_PLANE_AMEND_TRIGGER_JSON || "";
    let trigger: Record<string, unknown> = {};
    try { trigger = triggerJson ? JSON.parse(triggerJson) : {}; } catch { trigger = {}; }

    const sharedFooter =
      `\n---\n\n` +
      `Operating rules for this amend turn:\n` +
      `- Keep the change as narrow as possible. Address only the trigger; ` +
      `do not refactor, reformat, or "improve" adjacent code.\n` +
      `- Treat the existing commits on this branch as someone else's work — ` +
      `do not revert, squash, or rewrite them.\n` +
      `- Run the relevant tests / lint after editing. If you cannot make the ` +
      `check pass, say so explicitly in your final message.\n` +
      `- Do NOT open a new PR. The runner will push your commit onto the ` +
      `existing branch and the PR updates automatically.\n\n` +
      `---\n\n`;

    let preamble: string;
    if (triggerKind === "review_changes_requested") {
      const reviewer = (trigger.reviewerLogin as string) || "(unknown reviewer)";
      const review = ((trigger.reviewBody as string) || "(reviewer left no body — check inline comments on the PR)").trim();
      preamble =
        `# Hermes amend — address review feedback\n\n` +
        `You are continuing work on an EXISTING open pull request:\n` +
        `- Branch: ${amendBr}\n` +
        `- PR #${amendNum}: ${amendUrl}\n` +
        `- Reviewer: @${reviewer}\n\n` +
        `## Reviewer feedback\n\n${review}\n\n` +
        `## How to handle this\n` +
        `1. Read the PR diff and the reviewer feedback above.\n` +
        `2. Apply the requested change. If multiple files are affected, group them in a single coherent commit.\n` +
        `3. If the feedback is ambiguous, do the conservative interpretation — the reviewer can ping you again if needed.\n` +
        sharedFooter;
    } else if (triggerKind === "ci_failure") {
      const checkName = (trigger.checkName as string) || "(unknown check)";
      const detailsUrl = (trigger.detailsUrl as string) || "";
      const conclusion = (trigger.conclusion as string) || "failure";
      preamble =
        `# Hermes amend — fix failing CI\n\n` +
        `You are continuing work on an EXISTING open pull request:\n` +
        `- Branch: ${amendBr}\n` +
        `- PR #${amendNum}: ${amendUrl}\n` +
        `- Failing check: ${checkName} (${conclusion})\n` +
        (detailsUrl ? `- Details: ${detailsUrl}\n` : ``) +
        `\n## How to handle this\n` +
        `1. Diff against the base branch to understand the PR's intent.\n` +
        `2. Reproduce the failing check LOCALLY first (run the same command). Do not push speculative fixes.\n` +
        `3. Once you have a fix that turns the check green locally, commit and stop.\n` +
        sharedFooter;
    } else {
      // Manual follow-up (operator-driven). Today's behaviour.
      preamble =
        `# Hermes amend mode\n` +
        `You are continuing work on an EXISTING open pull request:\n` +
        `- Branch: ${amendBr}\n` +
        `- PR #${amendNum}: ${amendUrl}\n\n` +
        `Make the requested change on this branch. Do NOT open a new PR — ` +
        `the runner will push your commits onto the existing branch and ` +
        `the PR will update automatically.\n\n` +
        `---\n\n`;
    }
    text = preamble + text;
  }
  sendEvent("agent.started", { taskDescription });

  try {
    const resp = await opencode.session.prompt({
      path: { id: sid },
      query: { directory: REPO_DIR },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: "text", text }],
        // §12.17 — pre-declare every tool as allowed so opencode never emits
        // permission.asked. Hermes runs unattended; there is no UI to reply.
        // Overrides default "build" agent's edge-case asks (.env, external_directory)
        // and any user-supplied opencode.json in the cloned repo.
        tools: ALLOW_ALL_TOOLS,
      },
      throwOnError: true,
    });
    const info = resp.data?.info as AssistantMessageInfo | undefined;
    rollUsage(info);

    // Compute diff + changed files (still useful for downstream PR step).
    const diff = await execCmd("git diff");
    const changedFiles = (await execCmd("git diff --name-only")).trim().split("\n").filter(Boolean);

    if (diff) sendEvent("git.diff.ready", { diff });
    sendEvent("agent.done", { summary: "Task completed" });
    sendComplete({
      summary: `Completed: ${taskDescription}`,
      diff,
      changedFiles,
      usage: { ...usageRollup },
    });
    console.log("[runner] Task completed; usage=", JSON.stringify(usageRollup));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent("agent.error", { error: msg });
    sendError(msg);
  }
}

// A2 — agent-authored PR title + body.
//
// After the main turn produces a diff, we ask opencode for a strict-JSON
// summary of what changed. The PR body is rendered from a fixed template
// so reviewers see consistent structure regardless of the model's mood.
// Any parse failure (model went prose, hallucinated JSON, etc.) falls
// back to today's hardcoded title + body so the publish path never
// blocks on prompt unreliability.
async function generatePrMetadata(
  taskDescription: string,
  changedFiles: string[],
  diffPreview: string,
): Promise<PrMetadata | null> {
  if (!opencodeSessionId) return null;
  const askText = [
    `Write the pull-request title and body for the changes you just made.`,
    ``,
    `Task: ${taskDescription}`,
    `Files changed (${changedFiles.length}): ${changedFiles.slice(0, 20).join(", ")}${changedFiles.length > 20 ? ", ..." : ""}`,
    ``,
    `Diff preview (first 4 KB):`,
    "```",
    diffPreview.slice(0, 4096),
    "```",
    ``,
    `Respond as STRICT JSON only — no prose, no code fences, no commentary.`,
    `Shape:`,
    `{`,
    `  "title": "<= 72 chars, imperative mood, no period",`,
    `  "summary": ["1-3 short bullets, what changed and why"],`,
    `  "verification": "what you ran + what passed (or 'none' if you ran nothing)",`,
    `  "outOfScope": "anything intentionally not done (or 'none')"`,
    `}`,
  ].join("\n");
  try {
    const resp = await opencode.session.prompt({
      path: { id: opencodeSessionId },
      query: { directory: REPO_DIR },
      body: {
        model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
        parts: [{ type: "text", text: askText }],
        tools: ALLOW_ALL_TOOLS,
      },
      throwOnError: true,
    });
    rollUsage(resp.data?.info as AssistantMessageInfo | undefined);
    const parts = (resp.data?.parts ?? []) as Array<{ type?: string; text?: string }>;
    const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
    const raw = textPart?.text ?? "";
    const parsed = parsePrMetadata(raw);
    if (parsed) {
      sendEvent("agent.pr_metadata", {
        title: parsed.title,
        summaryCount: parsed.summary.length,
        verificationLen: parsed.verification.length,
        outOfScopeLen: parsed.outOfScope.length,
      });
    }
    return parsed;
  } catch (err) {
    console.error("[runner] generatePrMetadata failed:", (err as Error).message);
    return null;
  }
}

async function runPrCreation(payload: Record<string, unknown>): Promise<void> {
  // B2 — split into local-prep + publish phases.
  //
  //   Phase 1 (always): generate PR metadata, stage + commit any
  //   uncommitted changes, verify ahead-count. Runs locally in the
  //   sandbox; no network.
  //
  //   Phase 2 (publish): two paths gated by HERMES_PUBLISH_VIA_LAUNCHER
  //   env. Default `false` = legacy in-sandbox path (git push + REST,
  //   unchanged). `true` = emit `runner.ready_to_publish` over WS and
  //   stop; the DO drives publish via the launcher's
  //   POST /sessions/:id/publish-pr endpoint and replies on the same WS.
  //
  // The flag is read at the runner side from process.env to keep the
  // command-payload shape stable across the rollout.
  const userLogin = process.env.GITHUB_USER_LOGIN || "";
  const owner = process.env.GITHUB_OWNER || "";
  const repo = process.env.GITHUB_REPO || "";
  const baseBranch = process.env.GITHUB_BASE_BRANCH || "main";

  // Amend mode: launcher passes the existing PR's branch / number / URL via
  // CONTROL_PLANE_PR_MODE_*. When set, we skip `POST /pulls` (the PR already
  // exists) and emit pr.updated instead of pr.created.
  const amendBranch = process.env.CONTROL_PLANE_PR_MODE_BRANCH || "";
  const amendNumber = process.env.CONTROL_PLANE_PR_MODE_NUMBER || "";
  const amendUrl = process.env.CONTROL_PLANE_PR_MODE_URL || "";
  const amendMode = Boolean(amendBranch && amendNumber && amendUrl);

  const publishViaLauncher =
    (process.env.HERMES_PUBLISH_VIA_LAUNCHER || "").toLowerCase() === "true";

  const branch = amendMode
    ? amendBranch
    : ((payload.branch as string) || `hermes/${Date.now()}`);
  const brSh = branch.replace(/'/g, "'\\''");
  const fallbackTitle = `Hermes: ${payload.taskDescription ?? "automated change"}`;
  const fallbackBody = "Automated PR created by hermes-control-plane.";
  const taskDescription = (payload.taskDescription as string) || "";

  // Token is required only on the legacy path. The new path keeps the
  // write token launcher-side only (B3 will rip it from sandbox env
  // entirely; for now we only consult it when needed).
  const token = process.env.HERMES_GITHUB_WRITE_TOKEN || "";
  if (!publishViaLauncher && (!token || !owner || !repo)) {
    sendError(
      `Missing HERMES_GITHUB_WRITE_TOKEN / owner / repo ` +
        `(token=${!!token} owner=${owner} repo=${repo})`,
    );
    return;
  }
  if (publishViaLauncher && (!owner || !repo)) {
    sendError(
      `Missing GITHUB_OWNER / GITHUB_REPO env required for publish-via-launcher ` +
        `(owner=${owner} repo=${repo})`,
    );
    return;
  }

  // A2: ask the agent for title + body BEFORE staging. Diff at this point
  // reflects what the agent intended to ship; if `git add -A` later picks
  // up new untracked files, the metadata may be slightly off, but that's
  // strictly better than today's hardcoded body and the cost is one
  // extra short turn against the same opencode session.
  let prMeta: PrMetadata | null = null;
  try {
    const diffForMeta = await execCmd("git diff");
    const changedFilesForMeta = (await execCmd("git diff --name-only"))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (diffForMeta.trim().length > 0 && taskDescription) {
      prMeta = await generatePrMetadata(taskDescription, changedFilesForMeta, diffForMeta);
    }
  } catch (err) {
    console.error("[runner] PR metadata pre-gen skipped:", (err as Error).message);
  }
  const title = (payload.title as string) || prMeta?.title || fallbackTitle;
  const body = (payload.body as string)
    || (prMeta ? renderPrBody(prMeta, taskDescription) : fallbackBody);

  try {
    await execStrict(`git add -A`);
    const stagedDiff = await execCmd(`git diff --cached --name-only`);
    if (stagedDiff.trim()) {
      await execStrict(`git commit -m "${title.replace(/"/g, '\"')}"`);
    } else {
      // Agent already committed during the run. Verify HEAD has something
      // worth pushing.
      // In amend mode the comparison base is the PR branch's previous tip
      // (origin/<branch>); in fresh mode it is the project's base branch.
      const cmpBase = amendMode ? `'origin/${brSh}'` : `origin/${baseBranch}`;
      const aheadCount = (await execCmd(`git rev-list --count ${cmpBase}..HEAD`)).trim();
      if (aheadCount === "0" || aheadCount === "") {
        sendError(amendMode ? "No new commits to push" : "No changes staged for PR");
        return;
      }
    }

    // ---- Publish phase ----------------------------------------------
    if (publishViaLauncher) {
      // New path. Resolve headSha so the DO + launcher can correlate
      // the publish call with the runner's exact tip; no push happens
      // here.  The DO replies asynchronously via `pr.publish.result` /
      // `pr.publish.failed` once the launcher returns.
      const headSha = (await execCmd("git rev-parse HEAD")).trim();
      sendEvent("pr.publishing", { branch, headSha, amendMode });
      // The WS event `runner.ready_to_publish` is the canonical signal
      // for the DO. We send it as a plain runner event (eventType in
      // hermes events stream) AND mark the runner-complete with a
      // pending flag so the DO knows not to fire sendError on terminal
      // until the publish round-trip resolves.
      sendEvent("runner.ready_to_publish", {
        branch,
        headSha,
        title,
        body,
        amendMode,
        amendPrNumber: amendMode ? Number(amendNumber) : undefined,
        amendPrUrl: amendMode ? amendUrl : undefined,
        ownerLogin: userLogin,
      });
      // Stop here. We do NOT call sendComplete — the DO is the one
      // emitting pr.created / pr.updated + sendComplete equivalents
      // after the launcher publish round-trip.
      return;
    }

    // ---- Legacy path (publishViaLauncher=false) ---------------------
    const pushOut = await execStrict(`git push --set-upstream origin '${brSh}' 2>&1`);
    sendEvent("git.branch.pushed", { branch, pushOutput: pushOut.slice(-500), authorIdentity: userLogin });

    if (amendMode) {
      // PR already exists; do NOT call POST /pulls. Re-emit the existing
      // URL via pr.updated so the DO can flip into completed without
      // re-registering a different PR.
      const number = Number(amendNumber);
      sendEvent("pr.updated", { url: amendUrl, number, branch, ownerLogin: userLogin });
      sendComplete({ prUrl: amendUrl, ownerLogin: userLogin });
      return;
    }

    const prResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, head: branch, base: baseBranch, body }),
    });
    if (!prResp.ok) {
      const errBody = await prResp.text();
      sendError(`GitHub PR API ${prResp.status}: ${errBody.slice(0, 300)}`);
      return;
    }
    const prJson = (await prResp.json()) as { html_url: string; number: number };
    sendEvent("pr.created", { url: prJson.html_url, number: prJson.number, branch, ownerLogin: userLogin });
    sendComplete({ prUrl: prJson.html_url, ownerLogin: userLogin });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(`PR creation failed: ${msg}`);
  }
}

function attachHandlers(): void {
  ws.on("open", () => {
    console.log("[runner] Connected to control plane");
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "runner.heartbeat", sessionId: SESSION_ID }));
      }
    }, 10000);
  });

  ws.on("message", async (data: Buffer) => {
    const raw = data.toString();
    let msg: { type: string; command?: { commandId: string; type: string; payload: Record<string, unknown> } };
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== "command" || !msg.command) return;
    const cmd = msg.command;
    console.log("[runner] Command:", cmd.type);

    ws.send(JSON.stringify({
      type: "runner.command_ack",
      sessionId: SESSION_ID,
      payload: { commandId: cmd.commandId },
    }));

    if (cmd.type === "agent.prompt") {
      const task = cmd.payload.taskDescription as string;
      const context = (cmd.payload.context as string) || "";
      await runPromptTurn(task, context);
      return;
    }

    if (cmd.type === "pr.create") {
      await runPrCreation(cmd.payload);
      return;
    }

    if (cmd.type === "session.shutdown") {
      shuttingDown = true;
      if (heartbeat) clearInterval(heartbeat);
      if (sseAbort) sseAbort.abort();
      ws.close(1000, "shutdown");
      process.exit(0);
    }
  });

  ws.on("close", (code: number) => {
    console.log("[runner] WS closed:", code);
    if (heartbeat) clearInterval(heartbeat);
    if (shuttingDown) return;
    // M5: outbound WS dies on sandbox pause/resume (verified §12.14
    // probe — close fires with code 1006). Try to reconnect; if budget
    // exhausts, process.exit(1) so the supervisor babysit chain tears
    // down opencode serve.
    void reconnect();
  });

  ws.on("error", (err: Error) => {
    console.error("[runner] WS error:", err.message);
    // close will fire after this; reconnect happens there.
  });
}

attachHandlers();

