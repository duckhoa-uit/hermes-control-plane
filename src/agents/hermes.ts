import { defineAgent, defineTool, registerProvider, type AgentRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";
import { requireApproval } from "../approval";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export const route: AgentRouteHandler = async (_c, next) => next();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const INSTRUCTIONS = `
You are Hermes, a PR coding agent. You work autonomously to complete coding tasks and open pull requests.

1. Read the task and understand what needs to be done.
2. Clone the repository: git clone <url>
3. Read relevant files, understand the codebase.
4. Make changes using read, write, edit, and bash tools.
5. Run install_deps after cloning (bash: cd repo && npm install).
6. Run tests to verify (bash: cd repo && npm test).
7. When satisfied, commit (bash: git add -A && git commit -m "...")
8. Push using git_push and create a PR using create_pr.

## RULES
- Do NOT commit unless tests pass.
- Do NOT create a PR without pushing first.
- Keep changes narrow. Do not refactor unrelated code.
- Run tests BEFORE pushing.
- Write clean, conventional commit messages.

## APPROVAL
Some powerful operations (git_push, create_pr) may require human approval.
- If error says "denied by operator": user explicitly denied. DO NOT retry. Stop and explain.
- If error says "blocked by hardline policy": never allowed. DO NOT retry under any circumstance.
- If error says "no approval received within 1 hour" (timeout): user may have been AFK. Stop, report the issue, mention that the user can re-run when ready. DO NOT retry automatically.
Always include the replay URL so the operator can review.
`;

export default defineAgent<Env>(({ id, env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  const baseUrl = env.WORKER_URL || "";
  // Cast to handle generic variance issues
  const approvalDO = env.APPROVAL_DO as unknown as DurableObjectNamespace;

  const gitPush = defineTool({
    name: "git_push",
    description:
      "Push local commits to GitHub. REQUIRES HUMAN APPROVAL before executing. Call after git add + git commit.",
    input: v.object({
      branch: v.string(),
      force: v.optional(v.boolean(), false),
    }),
    async run(ctx) {
      const { branch, force } = ctx.input;

      // ── 1. Snapshot the commit as a manifest BEFORE asking for approval ─
      // This way the container can sleep during the wait without losing work.
      const preSandbox = getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "5m" });
      const preFind = await preSandbox.exec(
        `bash -c "ls -d /workspace/*/.git 2>/dev/null | head -1 | xargs -r dirname"`,
      );
      const preCwd = (preFind.stdout || "").trim();
      if (!preCwd) throw new Error("No git repo found under /workspace. Did you clone?");

      // Capture HEAD/base metadata and the final changed-file contents.
      const shaRes = await preSandbox.exec(
        `bash -c "cd ${shellQuote(preCwd)} && git rev-parse HEAD"`,
      );
      const headSha = (shaRes.stdout || "").trim();
      const baseRes = await preSandbox.exec(
        `bash -c "cd ${shellQuote(preCwd)} && git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null"`,
      );
      const baseSha = (baseRes.stdout || "").trim();
      if (!baseSha) throw new Error("Could not determine base commit from origin/HEAD/main/master");

      const baseTreeRes = await preSandbox.exec(
        `bash -c "cd ${shellQuote(preCwd)} && git rev-parse ${baseSha}^{tree}"`,
      );
      const baseTreeSha = (baseTreeRes.stdout || "").trim();
      const messageRes = await preSandbox.exec(
        `bash -c ${shellQuote(`cd ${shellQuote(preCwd)} && if [ "$(git rev-list --count ${baseSha}..HEAD)" = "1" ]; then git log -1 --format=%B HEAD; else echo "Hermes changes"; echo; git log --reverse --format="- %s" ${baseSha}..HEAD; fi`)}`,
      );
      const commitMessage = (messageRes.stdout || "").trim() || `Hermes changes for ${branch}`;
      const manifestRes = await preSandbox.exec(
        `bash -c ${shellQuote(`cd ${shellQuote(preCwd)} && node - ${baseSha} <<'NODE'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const base = process.argv[2];
const diff = execFileSync("git", ["diff", "--name-status", "-z", base + "..HEAD"]);
const parts = diff.toString("utf8").split("\\0").filter(Boolean);
const changes = [];
function modeFor(path) {
  const out = execFileSync("git", ["ls-files", "-s", "--", path], { encoding: "utf8" });
  const mode = out.split(/\\s+/, 1)[0];
  if (mode === "100755" || mode === "120000") return mode;
  return "100644";
}
function contentFor(path, mode) {
  if (mode === "120000") return Buffer.from(fs.readlinkSync(path), "utf8").toString("base64");
  return fs.readFileSync(path).toString("base64");
}
for (let i = 0; i < parts.length; i++) {
  const status = parts[i];
  if (status.startsWith("R")) {
    const oldPath = parts[++i];
    const newPath = parts[++i];
    changes.push({ action: "delete", path: oldPath });
    const mode = modeFor(newPath);
    changes.push({ action: "upsert", path: newPath, mode, contentBase64: contentFor(newPath, mode) });
    continue;
  }
  if (status.startsWith("C")) {
    i++;
    const newPath = parts[++i];
    const mode = modeFor(newPath);
    changes.push({ action: "upsert", path: newPath, mode, contentBase64: contentFor(newPath, mode) });
    continue;
  }
  const path = parts[++i];
  if (status === "D") {
    changes.push({ action: "delete", path });
    continue;
  }
  const mode = modeFor(path);
  changes.push({ action: "upsert", path, mode, contentBase64: contentFor(path, mode) });
}
process.stdout.write(JSON.stringify(changes));
NODE`)}`,
      );
      if (manifestRes.exitCode !== 0) {
        throw new Error(`Failed to build push manifest: ${manifestRes.stdout || ""}`);
      }
      const changes = JSON.parse((manifestRes.stdout || "").trim()) as unknown[];
      if (changes.length === 0) throw new Error(`No changes found between ${baseSha} and HEAD`);
      const manifestKB = Math.round(JSON.stringify(changes).length / 1024);

      const snapshot = {
        headSha,
        baseSha,
        baseTreeSha,
        branch,
        commitMessage,
        changes,
        force,
      };

      // ── 2. Request approval (container free to sleep during wait) ───────
      const decision = await requireApproval(
        { signal: ctx.signal },
        {
          type: "git_push",
          title: `Push to branch ${branch}`,
          command: `Publish ${changes.length} file change(s) to ${branch}${force ? " with force" : ""}`,
          pattern: "git.push",
          metadata: { headSha, baseSha, baseTreeSha, changes: changes.length, manifestKB },
        },
        {
          mode: (env.APPROVAL_MODE || "manual") as "manual" | "smart" | "off",
          sessionId: id,
          workerUrl: baseUrl,
          approvalDOBinding: approvalDO,
        },
      );

      if (decision.denied) {
        let reason: string;
        if (decision.decision === "hardline_blocked")
          reason = "blocked by hardline policy (never allowed)";
        else if (decision.decision === "timeout") reason = "no approval received within 1 hour";
        else reason = "denied by operator";
        throw new Error(
          `Push to ${branch} was ${reason}. ` + `Operator can approve at ${baseUrl}/replay/${id}.`,
        );
      }

      // ── 3. Publish through the control plane; sandbox never receives the token.
      const resp = await fetch(`${baseUrl}/proxy/git-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
        signal: ctx.signal,
      });
      if (!resp.ok) throw new Error(`Push failed: ${resp.status} ${await resp.text()}`);
      const result = (await resp.json()) as { success?: boolean; error?: string };
      if (!result.success) throw new Error(`Push failed: ${result.error || "unknown error"}`);
      return result;
    },
  });

  const createPR = defineTool({
    name: "create_pr",
    description:
      "Create a GitHub Pull Request. REQUIRES HUMAN APPROVAL before executing. Only call after git_push succeeded.",
    input: v.object({
      title: v.string(),
      body: v.string(),
      branch: v.string(),
      baseBranch: v.optional(v.string(), "main"),
    }),
    async run(ctx) {
      const { title, body, branch, baseBranch } = ctx.input;

      const decision = await requireApproval(
        { signal: ctx.signal },
        {
          type: "create_pr",
          title: `Create PR: "${title}"`,
          command: `Create PR from ${branch} to ${baseBranch || "main"}`,
          diff: body?.slice(0, 2000),
          pattern: "pr.create",
        },
        {
          mode: (env.APPROVAL_MODE || "manual") as "manual" | "smart" | "off",
          sessionId: id,
          workerUrl: baseUrl,
          approvalDOBinding: approvalDO,
        },
      );

      if (decision.denied) {
        let reason: string;
        if (decision.decision === "hardline_blocked")
          reason = "blocked by hardline policy (never allowed)";
        else if (decision.decision === "timeout") reason = "no approval received within 1 hour";
        else reason = "denied by operator";
        throw new Error(
          `PR creation was ${reason}. ` + `Operator can approve at ${baseUrl}/replay/${id}.`,
        );
      }

      const resp = await fetch(`${baseUrl}/proxy/create-pr`, {
        method: "POST",
        body: JSON.stringify({ title, body, branch, baseBranch }),
        signal: ctx.signal,
      });
      if (!resp.ok) throw new Error(`PR creation failed: ${resp.status} ${await resp.text()}`);
      return (await resp.json()) as any;
    },
  });

  return {
    model: env.LLM_MODEL || "anthropic/claude-sonnet-4-6",
    instructions: INSTRUCTIONS,
    tools: [gitPush, createPR],
    sandbox: cloudflareSandbox(getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "5m" }), {
      cwd: "/workspace",
    }),
    durability: {
      maxAttempts: 10,
      // 2 hours: enough for 1h HITL approval wait + agent work
      timeoutMs: 2 * 60 * 60 * 1000,
    },
  };
});
