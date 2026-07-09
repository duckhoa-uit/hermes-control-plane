import type { PushManifest } from "./github-api-push";
import type { JsonValue } from "@flue/runtime";
import { withTimeout } from "./watchdog";

export type SandboxExecResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type SandboxLike = {
  exec(command: string, options?: { timeout?: number }): Promise<SandboxExecResult>;
};

export type FinalizeSnapshot = PushManifest & {
  headSha: string;
  repoPath: string;
  manifestKB: number;
};

export type FinalizeRequest = {
  branch: string;
  commitMessage: string;
  prTitle?: string;
  prBody: string;
  baseBranch: string;
  createPr: boolean;
  force: boolean;
};

export type FinalizeCheckpoint = {
  request: FinalizeRequest;
  phase: "prepared" | "pushed" | "completed";
  snapshot: FinalizeSnapshot;
  push?: JsonValue;
  pr?: JsonValue;
};

export type FinalizeDependencies = {
  loadCheckpoint(): Promise<FinalizeCheckpoint | null>;
  saveCheckpoint(checkpoint: FinalizeCheckpoint): Promise<void>;
  prepare(): Promise<FinalizeSnapshot>;
  approvePush(snapshot: FinalizeSnapshot): Promise<void>;
  push(snapshot: FinalizeSnapshot): Promise<JsonValue>;
  createPr(input: {
    title: string;
    body: string;
    branch: string;
    baseBranch: string;
  }): Promise<JsonValue>;
};

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCommitCommand(
  repoPath: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string,
): string {
  return [
    `cd ${shellQuote(repoPath)}`,
    `git config user.name ${shellQuote(authorName)}`,
    `git config user.email ${shellQuote(authorEmail)}`,
    "git add -A",
    `if git diff --cached --quiet; then echo "NO_CHANGES_TO_COMMIT"; else git commit -m ${shellQuote(commitMessage)}; fi`,
  ].join(" && ");
}

export async function execSandboxChecked(
  sandbox: SandboxLike,
  command: string,
  label: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<SandboxExecResult> {
  const result = await withTimeout(sandbox.exec(command, { timeout: timeoutMs }), timeoutMs, label);
  if (result.exitCode && result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${label} failed with exit ${result.exitCode}: ${output}`);
  }
  return result;
}

export async function runDeterministicFinalize(
  request: FinalizeRequest,
  dependencies: FinalizeDependencies,
): Promise<{ success: true; push: JsonValue; pr: JsonValue | null; recovered: boolean }> {
  let checkpoint = await dependencies.loadCheckpoint();
  const recovered = Boolean(checkpoint && sameFinalizeRequest(checkpoint.request, request));

  if (checkpoint && checkpoint.phase !== "completed") {
    if (!sameFinalizeRequest(checkpoint.request, request)) {
      throw new Error(
        `An unfinished finalize checkpoint already exists for ${request.branch}. Retry it with the original inputs before starting another finalize operation.`,
      );
    }
  } else if (checkpoint && sameFinalizeRequest(checkpoint.request, request)) {
    return {
      success: true,
      push: checkpoint.push ?? null,
      pr: checkpoint.pr ?? null,
      recovered: true,
    };
  } else {
    checkpoint = {
      request,
      phase: "prepared",
      snapshot: await dependencies.prepare(),
    };
    await dependencies.saveCheckpoint(checkpoint);
  }

  if (checkpoint.phase === "prepared") {
    await dependencies.approvePush(checkpoint.snapshot);
    checkpoint = {
      ...checkpoint,
      phase: "pushed",
      push: await dependencies.push(checkpoint.snapshot),
    };
    await dependencies.saveCheckpoint(checkpoint);
  }

  if (checkpoint.phase === "pushed") {
    const pr = request.createPr
      ? await dependencies.createPr({
          title: request.prTitle || request.commitMessage,
          body: request.prBody || `Automated Hermes changes for ${request.branch}.`,
          branch: request.branch,
          baseBranch: request.baseBranch,
        })
      : null;
    checkpoint = { ...checkpoint, phase: "completed", pr };
    await dependencies.saveCheckpoint(checkpoint);
  }

  return {
    success: true,
    push: checkpoint.push ?? null,
    pr: checkpoint.pr ?? null,
    recovered,
  };
}

function sameFinalizeRequest(left: FinalizeRequest, right: FinalizeRequest): boolean {
  return (
    left.branch === right.branch &&
    left.commitMessage === right.commitMessage &&
    left.prTitle === right.prTitle &&
    left.prBody === right.prBody &&
    left.baseBranch === right.baseBranch &&
    left.createPr === right.createPr &&
    left.force === right.force
  );
}

export async function findWorkspaceRepo(sandbox: SandboxLike): Promise<string> {
  const result = await execSandboxChecked(
    sandbox,
    `bash -c "ls -d /workspace/*/.git 2>/dev/null | head -1 | xargs -r dirname"`,
    "find workspace repo",
  );
  const repoPath = (result.stdout || "").trim();
  if (!repoPath) throw new Error("No git repo found under /workspace. Did you clone?");
  return repoPath;
}

export async function ensureWorkspaceCommitted(
  sandbox: SandboxLike,
  repoPath: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string,
): Promise<void> {
  await execSandboxChecked(
    sandbox,
    `bash -c ${shellQuote(buildCommitCommand(repoPath, commitMessage, authorName, authorEmail))}`,
    "commit workspace",
  );
}

export async function buildPushSnapshot(
  sandbox: SandboxLike,
  repoPath: string,
  branch: string,
  force = false,
): Promise<FinalizeSnapshot> {
  const shaRes = await execSandboxChecked(
    sandbox,
    `bash -c "cd ${shellQuote(repoPath)} && git rev-parse HEAD"`,
    "read HEAD sha",
  );
  const headSha = (shaRes.stdout || "").trim();

  const baseRes = await execSandboxChecked(
    sandbox,
    `bash -c "cd ${shellQuote(repoPath)} && git rev-parse origin/HEAD 2>/dev/null || git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null"`,
    "read base sha",
  );
  const baseSha = (baseRes.stdout || "").trim();
  if (!baseSha) throw new Error("Could not determine base commit from origin/HEAD/main/master");

  const baseTreeRes = await execSandboxChecked(
    sandbox,
    `bash -c "cd ${shellQuote(repoPath)} && git rev-parse ${baseSha}^{tree}"`,
    "read base tree",
  );
  const baseTreeSha = (baseTreeRes.stdout || "").trim();

  const messageRes = await execSandboxChecked(
    sandbox,
    `bash -c ${shellQuote(`cd ${shellQuote(repoPath)} && git log -1 --format=%B HEAD`)}`,
    "read commit message",
  );
  const commitMessage = (messageRes.stdout || "").trim() || `Hermes changes for ${branch}`;

  const manifestScript = `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const base = process.argv[1];
const diff = execFileSync("git", ["diff", "--name-status", "-z", base + "..HEAD"]);
const parts = diff.toString("utf8").split(String.fromCharCode(0)).filter(Boolean);
const changes = [];
function modeFor(path) {
  const out = execFileSync("git", ["ls-files", "-s", "--", path], { encoding: "utf8" });
  const mode = out.split(/\\s+/, 1)[0];
  if (mode === "100755" || mode === "120000") return mode;
  return "100644";
}
function contentFor(path, mode) {
  if (!path) throw new Error("Missing path while building push manifest");
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
`;
  const manifestRes = await execSandboxChecked(
    sandbox,
    `bash -c ${shellQuote(`cd ${shellQuote(repoPath)} && node -e ${shellQuote(manifestScript)} ${shellQuote(baseSha)}`)}`,
    "build push manifest",
  );
  const changes = JSON.parse((manifestRes.stdout || "").trim()) as PushManifest["changes"];
  if (changes.length === 0) throw new Error(`No changes found between ${baseSha} and HEAD`);
  const manifestKB = Math.round(JSON.stringify(changes).length / 1024);

  return {
    repoPath,
    headSha,
    branch,
    baseSha,
    baseTreeSha,
    commitMessage,
    changes,
    force,
    manifestKB,
  };
}
