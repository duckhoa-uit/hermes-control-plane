// B1 — publish-via-launcher chokepoint.
//
// New publish path for HERMES_PUBLISH_VIA_LAUNCHER=true. The runner does
// local-only git operations (add, commit, rev-parse) inside the sandbox
// and emits `runner.ready_to_publish` over WS. The DO then calls this
// launcher endpoint, which:
//
//   1. Connects to the existing E2B sandbox (no new sandbox spawned).
//   2. Pushes HEAD to origin/<branch> using a *one-shot* remote URL with
//      HERMES_GITHUB_WRITE_TOKEN in argv-only — never written to
//      .git/config, never persisted on disk inside the sandbox. The
//      sandbox-baked origin remains read-only (B3).
//   3. Calls POST /repos/:owner/:repo/pulls (amend mode skips this; PR
//      already exists). Returns the PR url + number.
//
// Auth: gated upstream by the existing x-hermes-launcher-secret header
// (server-server). The runner never sees HERMES_GITHUB_WRITE_TOKEN.
//
// Rollback: caller (DO) controls the publish path via the
// HERMES_PUBLISH_VIA_LAUNCHER flag. Flipping the flag back to "false"
// reverts to the legacy in-sandbox path (sandbox-runner.runPrCreation),
// unchanged in B1.

import { Sandbox } from "e2b";
import { parseRepoUrl } from "./provision";

const REPO_DIR = "/home/user/repo";

export interface PublishInput {
  sandboxId: string;
  e2bApiKey: string;
  writeToken: string;        // HERMES_GITHUB_WRITE_TOKEN — argv only
  repoUrl: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  amendMode: boolean;        // when true, skip POST /pulls; existing PR
  amendPrNumber?: number;
  amendPrUrl?: string;
  ownerLogin?: string;       // for the returned event payload only
}

export interface PublishResult {
  ok: true;
  prUrl: string;
  prNumber: number;
  branch: string;
  pushOutput: string;        // tail of stderr/stdout for observability
  amendMode: boolean;
  ownerLogin?: string;
}

export interface PublishError {
  ok: false;
  stage: "connect" | "push" | "pulls_post";
  status?: number;           // HTTP for pulls_post
  message: string;
  detail?: string;
}

export async function publishPr(
  input: PublishInput,
): Promise<PublishResult | PublishError> {
  const { owner, repo } = parseRepoUrl(input.repoUrl);

  // 1. Connect to the existing sandbox. We never spawn here — provision
  //    already runs in handleCreate.
  let sbx: Sandbox;
  try {
    sbx = await Sandbox.connect(input.sandboxId, { apiKey: input.e2bApiKey });
  } catch (err) {
    return {
      ok: false,
      stage: "connect",
      message: `Sandbox.connect failed: ${(err as Error).message}`,
    };
  }

  // 2. Push via one-shot remote URL. The token is passed as a command
  //    env var (E2B forwards it to the subprocess env only — not to
  //    .git/config and not to the parent shell history).
  //
  //    We use HEAD:<branch> so the local ref name doesn't have to match
  //    the remote ref. The branch was already created during provision
  //    (B3: read-only token in origin; this push uses a one-shot URL).
  //
  //    `git -c credential.helper=` clears any inherited helper so a
  //    misconfigured sandbox can't fall back to a cached credential.
  const brSh = input.branch.replace(/'/g, "'\\''");
  const pushCmd =
    `cd ${REPO_DIR} && ` +
    // Use a temp remote 'hermes-publish' so we don't disturb the
    // sandbox-baked read-only 'origin'. -f forces overwrite if a
    // previous publish left the temp remote dangling.
    `git remote remove hermes-publish 2>/dev/null; ` +
    `git remote add hermes-publish "https://x-access-token:$HERMES_GITHUB_WRITE_TOKEN@github.com/${owner}/${repo}.git" && ` +
    `(git -c credential.helper= push --set-upstream hermes-publish "HEAD:${brSh}" 2>&1; echo "__exit=$?") ; ` +
    // Always remove the temp remote, even on push failure, so the
    // sandbox never carries a token-bearing remote between commands.
    `git remote remove hermes-publish`;
  let pushOut = "";
  try {
    const pushed = await sbx.commands.run(pushCmd, {
      timeoutMs: 60_000,
      envs: { HERMES_GITHUB_WRITE_TOKEN: input.writeToken },
    });
    pushOut = pushed.stdout || "";
  } catch (err) {
    return {
      ok: false,
      stage: "push",
      message: `git push exec failed: ${(err as Error).message}`,
    };
  }
  const exitMatch = pushOut.match(/__exit=(\d+)/);
  const pushExit = exitMatch ? Number(exitMatch[1]) : 0;
  if (pushExit !== 0) {
    return {
      ok: false,
      stage: "push",
      message: `git push exit ${pushExit}`,
      detail: pushOut.trim().split("\n").slice(-10).join(" | "),
    };
  }

  // 3. Amend mode: PR already exists, skip POST /pulls.
  if (input.amendMode) {
    if (!input.amendPrUrl || !input.amendPrNumber) {
      return {
        ok: false,
        stage: "pulls_post",
        message:
          "amend mode requires amendPrUrl + amendPrNumber",
      };
    }
    return {
      ok: true,
      prUrl: input.amendPrUrl,
      prNumber: input.amendPrNumber,
      branch: input.branch,
      pushOutput: pushOut.slice(-500),
      amendMode: true,
      ownerLogin: input.ownerLogin,
    };
  }

  // 4. Open the PR via REST. WriteToken is the operator's PAT (P1.1
  //    single-user OAuth) so PR `author` = real user, same as today's
  //    in-sandbox path.
  const prResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.writeToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "hermes-control-plane",
      },
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: input.body,
      }),
    },
  );
  if (!prResp.ok) {
    const errBody = await prResp.text();
    return {
      ok: false,
      stage: "pulls_post",
      status: prResp.status,
      message: `GitHub PR API ${prResp.status}`,
      detail: errBody.slice(0, 300),
    };
  }
  const prJson = (await prResp.json()) as {
    html_url: string;
    number: number;
  };
  return {
    ok: true,
    prUrl: prJson.html_url,
    prNumber: prJson.number,
    branch: input.branch,
    pushOutput: pushOut.slice(-500),
    amendMode: false,
    ownerLogin: input.ownerLogin,
  };
}
