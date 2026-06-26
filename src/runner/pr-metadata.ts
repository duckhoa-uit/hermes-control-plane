// PR #A / A2 — agent-authored PR title + body.
//
// Extracted to a standalone module so we can unit-test it without booting
// the full runner. The runtime (sandbox-runner.ts) re-imports both
// `parsePrMetadata` and `renderPrBody` from here.

export interface PrMetadata {
  title: string;
  summary: string[];
  verification: string;
  outOfScope: string;
}

export function parsePrMetadata(raw: string): PrMetadata | null {
  // Trim common LLM noise: leading/trailing prose, ```json fences.
  let s = raw.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find first { and last } to slice out JSON if surrounded by text.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  s = s.slice(firstBrace, lastBrace + 1);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const summary = Array.isArray(obj.summary)
    ? obj.summary.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
    : [];
  const verification = typeof obj.verification === "string" ? obj.verification.trim() : "";
  const outOfScope = typeof obj.outOfScope === "string" ? obj.outOfScope.trim() : "";

  if (!title || summary.length === 0) return null;
  return {
    title: title.length > 72 ? title.slice(0, 69) + "..." : title,
    summary: summary.slice(0, 5),
    verification: verification || "(agent did not report verification steps)",
    outOfScope: outOfScope || "(none)",
  };
}

export function renderPrBody(meta: PrMetadata, taskDescription: string): string {
  const bullets = meta.summary.map((b) => `- ${b}`).join("\n");
  return [
    `## Summary`,
    bullets,
    ``,
    `## Verification`,
    meta.verification,
    ``,
    `## Out of scope / Follow-ups`,
    meta.outOfScope,
    ``,
    `---`,
    `_Opened by hermes-control-plane for task:_ ${taskDescription.replace(/`/g, "'").slice(0, 200)}_._`,
  ].join("\n");
}
