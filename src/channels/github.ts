import { createGitHubChannel } from "@flue/github";
import type { GitHubWebhookHandlerResult } from "@flue/github";

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  webhook({ delivery }): GitHubWebhookHandlerResult {
    if (delivery.name === "pull_request") {
      const { action, pull_request, repository } = delivery.payload;
      if (action === "opened" || action === "synchronize") {
        console.log(`[github] PR ${action}: ${repository.full_name}#${pull_request.number}`);
      }
      if (action === "closed" && pull_request.merged) {
        console.log(`[github] PR merged: ${pull_request.html_url}`);
      }
    }
    return undefined;
  },
});
