import { createGitHubChannel } from "@flue/github";
import type { GitHubWebhookHandlerResult } from "@flue/github";
import { createLogger } from "../core/logger";

const logger = createLogger({ service: "control-plan.github" });

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  webhook({ delivery }): GitHubWebhookHandlerResult {
    if (delivery.name === "pull_request") {
      const { action, pull_request, repository } = delivery.payload;
      if (action === "opened" || action === "synchronize") {
        logger.info("github pull request event", {
          event: "github.pull_request",
          action,
          repository: repository.full_name,
          pullRequest: pull_request.number,
        });
      }
      if (action === "closed" && pull_request.merged) {
        logger.info("github pull request merged", {
          event: "github.pull_request.merged",
          repository: repository.full_name,
          pullRequest: pull_request.number,
          url: pull_request.html_url,
        });
      }
    }
    return undefined;
  },
});
