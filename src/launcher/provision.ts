// Provision an E2B sandbox for a hermes session and start the runner inside it.
// Shared by the sidecar (src/launcher/server.ts) and the offline CLI
// (scripts/launch-session.ts).

import { Sandbox } from "e2b";

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`cannot parse GitHub repo URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

export interface ProvisionInput {
  sessionId: string;
  runnerToken: string;
  controlWsUrl: string; // public URL the runner inside the sandbox dials
  repoUrl: string;
  baseBranch?: string;

  // E2B
  e2bApiKey: string;
  e2bTemplate: string;

  // Agent / model env
  // M4: model is selected per-prompt via the SDK (runner builds the
  // request body); the launcher only forwards the API key.
  zaiApiKey?: string;

  // P1.1 single-user OAuth: the human's GitHub PAT (or OAuth user token).
  // The runner uses this for `git push` + PR creation so the PR `author`
  // is the real user. Required for the launcher entry-point (server.ts
  // fails fast if unset); kept optional here for unit tests and the
  // offline CLI (scripts/launch-session.ts).
  githubUserToken?: string;
  githubUserLogin?: string;
  githubUserEmail?: string;

  // Amend mode (follow-up to an already-open PR). When set, the sandbox
  // checks out the PR's branch instead of creating a fresh hermes/<n>
  // branch, and the runner skips POST /pulls (it just pushes the new
  // commit and emits pr.updated). Optional; when unset, behaviour is the
  // pre-existing "new PR" flow.
  prMode?: {
    branch: string;     // existing branch on origin (PR head)
    prNumber: number;   // existing PR number on origin
    prUrl: string;      // PR html_url, re-emitted on pr.updated
  };
}

export interface ProvisionResult {
  sandboxId: string;
  /** Force-kill the sandbox. Idempotent on already-killed. */
  kill(): Promise<void>;
}

const START_CONFIG_PATH = "/opt/control-plane/start.json";
const REPO_DIR = "/home/user/repo";
const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;

export async function provisionSession(input: ProvisionInput): Promise<ProvisionResult> {
  // 1. Spawn from snapshot. Tag with hermes session id so the orphan sweeper
  //    can map a stray sandbox back to a session later.
  const sbx = await Sandbox.create(input.e2bTemplate, {
    apiKey: input.e2bApiKey,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: { onTimeout: "pause", autoResume: true },
    metadata: {
      hermes_session_id: input.sessionId,
      hermes_repo: input.repoUrl,
    },
    envs: {
      ZAI_API_KEY: input.zaiApiKey ?? "",
    },
  });

  const killOnce = (() => {
    let killed = false;
    return async () => {
      if (killed) return;
      killed = true;
      try {
        await sbx.kill();
      } catch {
        // best-effort
      }
    };
  })();

  try {
    // 2. Clone repo (per-session). Capture exit via shell suffix because the
    //    E2B SDK throws on non-zero exit by default.
    const clone = await sbx.commands.run(
      `rm -rf ${REPO_DIR} && (git clone --depth 1 ${input.repoUrl} ${REPO_DIR} 2>&1; echo "__exit=$?")`,
      { timeoutMs: 120_000 },
    );
    const exitMatch = clone.stdout.match(/__exit=(\d+)/);
    const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
    if (exitCode !== 0) {
      await killOnce();
      throw new Error(
        `git clone failed (exit ${exitCode}): ${clone.stdout.trim().split("\n").slice(-3).join(" | ")}`,
      );
    }

    // 3. Bake P1.1 single-user OAuth credentials into the cloned repo so
    //    the agent's own `git push` works directly (Option A). The token
    //    only lives inside .git/config of this ephemeral sandbox.
    let owner = "";
    let repo = "";
    try {
      ({ owner, repo } = parseRepoUrl(input.repoUrl));
    } catch {
      // non-GitHub repo URL — runner's PR step will surface a clear error.
    }
    const userToken = input.githubUserToken ?? "";
    const userLogin = input.githubUserLogin ?? "";
    if (owner && repo && userToken && userLogin) {
      const gitEmail = input.githubUserEmail || `${userLogin}@users.noreply.github.com`;
      const remoteUrl = `https://${userToken}:x-oauth-basic@github.com/${owner}/${repo}.git`;
      const setupCmds: string[] = [
        `cd ${REPO_DIR}`,
        `git config user.name '${userLogin.replace(/'/g, "'\\''")}'`,
        `git config user.email '${gitEmail.replace(/'/g, "'\\''")}'`,
        `git remote set-url origin '${remoteUrl}'`,
      ];
      if (input.prMode) {
        // Amend: fetch the PR branch and check it out. We cloned with
        // --depth 1 --single-branch so the remote refspec only tracks
        // HEAD; we have to fetch the PR branch by its full ref AND
        // unshallow it (push will fail without enough history). The
        // explicit refspec also creates the origin/<branch> tracking
        // ref the subsequent checkout points at.
        const br = input.prMode.branch.replace(/'/g, "'\\''");
        setupCmds.push(
          `git fetch --depth 50 origin '+refs/heads/${br}:refs/remotes/origin/${br}'`,
        );
        setupCmds.push(`git checkout -B '${br}' 'origin/${br}'`);
      } else {
        // Fresh session: create a new hermes/<short-session-id> branch.
        const branch = `hermes/${input.sessionId.slice(-8)}`;
        setupCmds.push(`git checkout -B ${branch}`);
      }
      const setup = await sbx.commands.run(
        // Suffix with `; echo __exit=$?` so we capture the real exit code
        // from the chain — E2B SDK throws on non-zero, so wrap in `(... ; true)`
        // and grep the exit ourselves to get a useful error message.
        `(${setupCmds.join(" && ")}; echo "__setup_exit=$?") 2>&1`,
        { timeoutMs: 30_000 },
      );
      const setupExitMatch = setup.stdout.match(/__setup_exit=(\d+)/);
      const setupExit = setupExitMatch ? Number(setupExitMatch[1]) : 0;
      if (setupExit !== 0) {
        await killOnce();
        throw new Error(
          `git setup failed (exit ${setupExit}): ${setup.stdout.trim().split("\n").slice(-10).join(" | ")}`,
        );
      }
    }

    // 4. Drop the per-session start config. The supervisor (baked into the
    //    template, already running in the snapshot) is polling this path and
    //    will exec the runner with these env vars.
    const startConfig: Record<string, string> = {
      CONTROL_PLANE_SESSION_ID: input.sessionId,
      CONTROL_PLANE_RUNNER_TOKEN: input.runnerToken,
      CONTROL_PLANE_WS: input.controlWsUrl,
      ZAI_API_KEY: input.zaiApiKey ?? "",
      GITHUB_USER_TOKEN: userToken,
      GITHUB_USER_LOGIN: userLogin,
      GITHUB_USER_EMAIL: input.githubUserEmail ?? "",
      GITHUB_OWNER: owner,
      GITHUB_REPO: repo,
      GITHUB_BASE_BRANCH: input.baseBranch ?? "main",
    };
    if (input.prMode) {
      // Runner reads these to switch into amend mode: skips POST /pulls
      // and emits pr.updated instead of pr.created on push.
      startConfig.CONTROL_PLANE_PR_MODE_BRANCH = input.prMode.branch;
      startConfig.CONTROL_PLANE_PR_MODE_NUMBER = String(input.prMode.prNumber);
      startConfig.CONTROL_PLANE_PR_MODE_URL = input.prMode.prUrl;
    }
    await sbx.files.write(START_CONFIG_PATH, JSON.stringify(startConfig));

    return { sandboxId: sbx.sandboxId, kill: killOnce };
  } catch (err) {
    await killOnce();
    throw err;
  }
}

/** Connect-and-kill helper used by the orphan sweeper. */
export async function killSandbox(apiKey: string, sandboxId: string): Promise<void> {
  try {
    const sbx = await Sandbox.connect(sandboxId, { apiKey });
    await sbx.kill();
  } catch {
    // best-effort
  }
}
