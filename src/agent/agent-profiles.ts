import { defineAgentProfile } from "@flue/runtime";
import codingInstructions from "../agents/control-plan.md" with { type: "markdown" };
import reviewInstructions from "../agents/pr-review.md" with { type: "markdown" };
import triageInstructions from "../agents/sentry-triage.md" with { type: "markdown" };
import codingTaskSkill from "../skills/control-plan-coding-task/SKILL.md" with { type: "skill" };
import prReviewSkill from "../skills/pr-review/SKILL.md" with { type: "skill" };
import sentryTriageSkill from "../skills/sentry-triage/SKILL.md" with { type: "skill" };

export const codingTaskProfile = defineAgentProfile({
  name: "coding-task",
  description: "Implements and verifies one task-bound repository change.",
  instructions: codingInstructions,
  skills: [codingTaskSkill],
});

/** Read-only by construction: no tools, actions, or sandbox are attached. */
export const prReviewProfile = defineAgentProfile({
  name: "pr-reviewer",
  description: "Reviews a supplied PR snapshot and reports evidence-backed findings.",
  instructions: reviewInstructions,
  skills: [prReviewSkill],
});

/** Read-only by construction: Sentry evidence is supplied by the caller. */
export const sentryTriageProfile = defineAgentProfile({
  name: "sentry-triager",
  description: "Triages a supplied Sentry issue snapshot and proposes the next safe step.",
  instructions: triageInstructions,
  skills: [sentryTriageSkill],
});
