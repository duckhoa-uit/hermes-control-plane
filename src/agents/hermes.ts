import { defineAgent, defineTool, registerProvider, type AgentRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";
import { requireApproval } from "../approval";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export const route: AgentRouteHandler = async (_c, next) => next();

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
      const token = env.GITHUB_WRITE_TOKEN;
      const owner = env.GITHUB_OWNER;
      const repo = env.GITHUB_REPO;
      const authUrl = `https://${env.GITHUB_USER_LOGIN}:${token}@github.com/${owner}/${repo}.git`;

      // ── 1. Snapshot the commit as a patch BEFORE asking for approval ────
      // This way the container can sleep during the wait without losing work.
      const preSandbox = getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "5m" });
      const preFind = await preSandbox.exec(
        `bash -c "ls -d /workspace/*/.git 2>/dev/null | head -1 | xargs -r dirname"`,
      );
      const preCwd = (preFind.stdout || "").trim();
      if (!preCwd) throw new Error("No git repo found under /workspace. Did you clone?");

      // Capture: HEAD sha, base sha (where branch diverged from origin), patch bytes
      const shaRes = await preSandbox.exec(`bash -c "cd ${preCwd} && git rev-parse HEAD"`);
      const headSha = (shaRes.stdout || "").trim();
      const baseRes = await preSandbox.exec(
        `bash -c "cd ${preCwd} && git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null"`,
      );
      const baseSha = (baseRes.stdout || "").trim();
      // Build a patch from base..HEAD (covers all commits on this branch)
      const patchRange = baseSha ? `${baseSha}..HEAD` : "HEAD~1..HEAD";
      const patchRes = await preSandbox.exec(
        `bash -c "cd ${preCwd} && git format-patch ${patchRange} --stdout | base64 -w 0"`,
      );
      const patchBase64 = (patchRes.stdout || "").trim();
      const patchKB = Math.round(patchBase64.length / 1024);

      const snapshot = {
        cwd: preCwd,
        headSha,
        baseSha,
        branch,
        patchBase64,
        patchKB,
      };

      // ── 2. Request approval (container free to sleep during wait) ───────
      const decision = await requireApproval(
        { signal: ctx.signal, emitData: ctx.emitData },
        {
          type: "git_push",
          title: `Push to branch ${branch}`,
          command: `git push origin ${branch}${force ? " --force" : ""}`,
          pattern: "git.push",
          metadata: { headSha, baseSha, patchKB },
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

      // ── 3. After approval: resume container, restore work if needed ────
      const sandbox = getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "5m" });
      const findRepo = await sandbox.exec(
        `bash -c "ls -d /workspace/*/.git 2>/dev/null | head -1 | xargs -r dirname"`,
      );
      let cwd = (findRepo.stdout || "").trim();

      if (!cwd) {
        // Container died during wait — restore from patch snapshot
        console.log(
          `[git_push] Container restarted, restoring from patch (${snapshot.patchKB} KB)`,
        );
        const restoreCmd = [
          `set -e`,
          `mkdir -p /workspace`,
          `cd /workspace`,
          `git config --global http.postBuffer 524288000`,
          `git config --global http.postBuffer 524288000`,
          `git clone '${authUrl}' ${repo}`,
          `cd ${repo}`,
          `git config user.email "hermes@agent.local"`,
          `git config user.name "Hermes"`,
          // Reset to the base where branch was forked, then apply patch
          snapshot.baseSha ? `git checkout ${snapshot.baseSha}` : `git checkout origin/main`,
          `git checkout -b ${branch}`,
          `echo '${snapshot.patchBase64}' | base64 -d | git am --3way`,
          `git remote set-url origin https://github.com/${owner}/${repo}.git`,
        ].join(" && ");

        const restore = await sandbox.exec(`bash -c "${restoreCmd.replace(/"/g, '\\"')}"`);
        if (restore.exitCode !== 0) {
          const out = (restore.stdout || "").replace(token, "***");
          throw new Error(
            `Container died during wait. Patch restore failed (exit ${restore.exitCode}): ${out}`,
          );
        }
        cwd = `/workspace/${repo}`;
      }

      // ── 4. Push with retry on TLS errors ───────────────────────────────
      let pushResult: { exitCode: number; stdout: string } = { exitCode: -1, stdout: "" };
      let lastErr = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await sandbox.exec(
          `bash -c "cd ${cwd} && git config --global http.postBuffer 524288000 && git config --global http.lowSpeedLimit 1000 && git config --global http.lowSpeedTime 60 && git remote set-url origin '${authUrl}' && git -c http.version=HTTP/1.1 push ${force ? "--force " : ""}origin ${branch} 2>&1; EC=$?; git remote set-url origin https://github.com/${owner}/${repo}.git; exit $EC"`,
        );
        pushResult = r;
        if (r.exitCode === 0) break;
        const out = (r.stdout || "").replace(token, "***");
        lastErr = out;
        if (!/gnutls|handshake|TLS|connection|Could not resolve|HTTP\/2 stream/i.test(out)) break;
        await new Promise((res) => setTimeout(res, 2000 * attempt));
      }

      if (pushResult.exitCode !== 0) {
        throw new Error(`Push failed (exit ${pushResult.exitCode}) after retries: ${lastErr}`);
      }

      // Capture push output for diagnostics + verify branch actually exists on remote
      const pushOutput = (pushResult.stdout || "").replace(token, "***");

      // Verify the push actually reached GitHub by querying the API
      const head = await sandbox.exec(`bash -c "cd ${cwd} && git rev-parse HEAD"`);
      const localSha = (head.stdout || "").trim();

      // Fetch remote ref via GitHub API to confirm push really worked
      const verify = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "hermes-agent",
          },
        },
      );
      if (verify.status === 404) {
        throw new Error(
          `Push reported exit 0 but branch ${branch} not found on GitHub. ` +
            `Likely a silent TLS/network failure inside the container. ` +
            `Push output: ${pushOutput.slice(0, 500)}`,
        );
      }
      if (!verify.ok) {
        throw new Error(`Push verification failed: GitHub API ${verify.status}`);
      }
      const refData = (await verify.json()) as { object?: { sha?: string } };
      const remoteSha = refData.object?.sha;
      if (remoteSha !== localSha) {
        throw new Error(
          `Push reported success but remote SHA (${remoteSha}) != local SHA (${localSha}). ` +
            `Push output: ${pushOutput.slice(0, 500)}`,
        );
      }

      return { success: true, branch, sha: localSha, restored: !findRepo.stdout?.trim() };
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
        { signal: ctx.signal, emitData: ctx.emitData },
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
