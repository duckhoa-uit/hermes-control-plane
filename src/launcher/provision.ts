// Provision an E2B sandbox for a hermes session and start the runner inside it.
// Shared by the sidecar (src/launcher/server.ts) and the offline CLI
// (scripts/launch-session.ts).

import { Sandbox } from "e2b";
import { readFileSync } from "fs";
import { mintInstallationToken, parseRepoUrl } from "./github-token";

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
  zaiApiKey?: string;
  opencodeModel?: string;

  // GitHub App (so the runner can push + open PRs)
  githubAppId?: string;
  githubPrivateKey?: string; // PKCS#8 PEM
  githubPrivateKeyFile?: string;
}

export interface ProvisionResult {
  sandboxId: string;
  /** Force-kill the sandbox. Idempotent on already-killed. */
  kill(): Promise<void>;
}

const START_CONFIG_PATH = "/opt/hermes/start.json";
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
      ZHIPU_API_KEY: input.zaiApiKey ?? "",
      OPENCODE_MODEL: input.opencodeModel ?? "zai-coding-plan/glm-5.2",
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

    // 3. Mint a short-lived GitHub installation token so the runner can push
    //    and open the PR. Best-effort: if creds are missing, runner will report
    //    a clear error when it tries to push.
    let githubToken = "";
    let owner = "";
    let repo = "";
    try {
      ({ owner, repo } = parseRepoUrl(input.repoUrl));
      const pk = input.githubPrivateKey
        ? input.githubPrivateKey
        : input.githubPrivateKeyFile
          ? readFileSync(input.githubPrivateKeyFile, "utf-8")
          : "";
      if (input.githubAppId && pk) {
        const tok = await mintInstallationToken(input.githubAppId, pk, owner, repo);
        githubToken = tok.token;
      }
    } catch {
      // leave token empty; runner will surface the error
    }

    // 4. Drop the per-session start config. The supervisor (baked into the
    //    template, already running in the snapshot) is polling this path and
    //    will exec the runner with these env vars.
    const startConfig: Record<string, string> = {
      HERMES_SESSION_ID: input.sessionId,
      HERMES_RUNNER_TOKEN: input.runnerToken,
      HERMES_CONTROL_WS: input.controlWsUrl,
      ZHIPU_API_KEY: input.zaiApiKey ?? "",
      OPENCODE_MODEL: input.opencodeModel ?? "zai-coding-plan/glm-5.2",
      GITHUB_TOKEN: githubToken,
      GITHUB_OWNER: owner,
      GITHUB_REPO: repo,
      GITHUB_BASE_BRANCH: input.baseBranch ?? "main",
    };
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
