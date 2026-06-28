import { defineAgent, defineTool, registerProvider, type AgentRouteHandler } from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { getSandbox } from "@cloudflare/sandbox";
import * as v from "valibot";

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
`;

export default defineAgent<Env>(({ id, env }) => {
  if (env.ZAI_API_KEY) registerProvider("zai", { apiKey: env.ZAI_API_KEY });
  const baseUrl = env.WORKER_URL || "";

  const gitPush = defineTool({
    name: "git_push",
    description: "Push local commits to GitHub. Call after git add + git commit.",
    input: v.object({
      branch: v.string(),
      force: v.optional(v.boolean(), false),
    }),
    async run(ctx) {
      const { branch, force } = ctx.input;
      const resp = await fetch(`${baseUrl}/proxy/git-push`, {
        method: "POST",
        body: JSON.stringify({ branch, force }),
        signal: ctx.signal,
      });
      if (!resp.ok) throw new Error(`Push failed: ${resp.status} ${await resp.text()}`);
      return (await resp.json()) as any;
    },
  });

  const createPR = defineTool({
    name: "create_pr",
    description: "Create a GitHub Pull Request. Only call after git_push succeeded.",
    input: v.object({
      title: v.string(),
      body: v.string(),
      branch: v.string(),
      baseBranch: v.optional(v.string(), "main"),
    }),
    async run(ctx) {
      const { title, body, branch, baseBranch } = ctx.input;
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
    sandbox: cloudflareSandbox(getSandbox(env.Sandbox, `hermes-${id}`, { sleepAfter: "10m" }), {
      cwd: "/workspace",
    }),
  };
});
