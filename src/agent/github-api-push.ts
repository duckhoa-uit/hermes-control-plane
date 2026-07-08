export type GitTreeFileMode = "100644" | "100755" | "120000";

export type PushManifestChange =
  | {
      action: "upsert";
      path: string;
      mode: GitTreeFileMode;
      contentBase64: string;
    }
  | {
      action: "delete";
      path: string;
    };

export type PushManifest = {
  branch: string;
  baseSha: string;
  baseTreeSha: string;
  commitMessage: string;
  changes: PushManifestChange[];
  force?: boolean;
};

type GitApiClient = {
  rest: {
    git: {
      createBlob: (args: {
        owner: string;
        repo: string;
        content: string;
        encoding: "base64";
      }) => Promise<{ data: { sha: string } }>;
      createTree: (args: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: Array<{
          path: string;
          mode: GitTreeFileMode;
          type: "blob";
          sha: string | null;
        }>;
      }) => Promise<{ data: { sha: string } }>;
      createCommit: (args: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }) => Promise<{ data: { sha: string } }>;
      getRef: (args: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{ data: { object: { sha: string } } }>;
      createRef: (args: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }) => Promise<unknown>;
      updateRef: (args: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
        force: boolean;
      }) => Promise<unknown>;
    };
  };
};

export function isPushManifest(value: unknown): value is PushManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as PushManifest;
  if (!isNonEmptyString(manifest.branch)) return false;
  if (!isSha(manifest.baseSha) || !isSha(manifest.baseTreeSha)) return false;
  if (!isNonEmptyString(manifest.commitMessage)) return false;
  if (!Array.isArray(manifest.changes) || manifest.changes.length === 0) return false;
  return manifest.changes.every((change) => {
    if (!change || typeof change !== "object") return false;
    if (!isNonEmptyString(change.path) || change.path.startsWith("/")) return false;
    if (change.action === "delete") return true;
    if (change.action !== "upsert") return false;
    if (!["100644", "100755", "120000"].includes(change.mode)) return false;
    return typeof change.contentBase64 === "string";
  });
}

export async function pushManifestWithGitHubApi(
  octokit: GitApiClient,
  owner: string,
  repo: string,
  manifest: PushManifest,
): Promise<{ branch: string; sha: string; created: boolean; verified: true }> {
  const tree = [];
  for (const change of manifest.changes) {
    if (change.action === "delete") {
      tree.push({ path: change.path, mode: "100644" as const, type: "blob" as const, sha: null });
      continue;
    }

    const blob = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: change.contentBase64,
      encoding: "base64",
    });
    tree.push({
      path: change.path,
      mode: change.mode,
      type: "blob" as const,
      sha: blob.data.sha,
    });
  }

  const newTree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: manifest.baseTreeSha,
    tree,
  });

  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: manifest.commitMessage,
    tree: newTree.data.sha,
    parents: [manifest.baseSha],
  });

  const ref = `heads/${manifest.branch}`;
  const created = await upsertRef(
    octokit,
    owner,
    repo,
    ref,
    commit.data.sha,
    Boolean(manifest.force),
  );
  const verify = await octokit.rest.git.getRef({ owner, repo, ref });
  if (verify.data.object.sha !== commit.data.sha) {
    throw new Error(
      `GitHub ref verification failed: ${ref} is ${verify.data.object.sha}, expected ${commit.data.sha}`,
    );
  }

  return { branch: manifest.branch, sha: commit.data.sha, created, verified: true };
}

async function upsertRef(
  octokit: GitApiClient,
  owner: string,
  repo: string,
  ref: string,
  sha: string,
  force: boolean,
): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref });
  } catch (err) {
    if (isHttpStatus(err, 404)) {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/${ref}`, sha });
      return true;
    }
    throw err;
  }

  await octokit.rest.git.updateRef({ owner, repo, ref, sha, force });
  return false;
}

function isHttpStatus(err: unknown, status: number): boolean {
  return Boolean(err && typeof err === "object" && "status" in err && err.status === status);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
