import {
  createGitHubChannel,
  type GitHubWebhookHandlerInput,
  type GitHubWebhookHandlerResult,
} from "@flue/github";

export function prKeyFromUrl(prUrl: string): string {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Cannot parse PR URL: ${prUrl}`);
  return `${m[1]}#${m[2]}`;
}

export function handleGitHubWebhook(
  input: GitHubWebhookHandlerInput<{ Bindings: Env }>,
): GitHubWebhookHandlerResult {
  const { delivery } = input;

  if (delivery.name === "pull_request") {
    const pr = delivery.payload as {
      action: string;
      pull_request?: { html_url: string; merged?: boolean };
    };
    if (pr.action === "closed" && pr.pull_request?.merged) {
      // PR was merged — lifecycle tracking deferred
    }
  }

  return undefined; // empty 200 response
}

export function createGithubChannel(webhookSecret: string) {
  return createGitHubChannel({
    webhookSecret,
    webhook: handleGitHubWebhook as any,
  });
}
