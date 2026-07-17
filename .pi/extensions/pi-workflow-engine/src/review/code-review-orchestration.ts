import type { AdvisoryCandidate } from "../advisory-schema.ts";
import { normalizePath, primaryLocation } from "../workflow-advisory-utils.ts";

const DIFF_EMBED_CAP = 60_000;

export function buildCodeReviewScopeBlock(input: {
  readonly diffCommand: string;
  readonly files: readonly string[];
  readonly summary: string;
  readonly conventions?: string;
  readonly diffText: string;
  readonly target: string;
}): string {
  const diffBlock = input.diffText
    ? `\n## Diff (review is bounded to these changed lines)\n\`\`\`diff\n${
        input.diffText.length > DIFF_EMBED_CAP
          ? `${input.diffText.slice(0, DIFF_EMBED_CAP)}\n... (truncated — run \`${input.diffCommand}\` for the full diff)`
          : input.diffText
      }\n\`\`\`\n`
    : "";
  return (
    `## Diff command\n${input.diffCommand}\n\n## Changed files\n${input.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Summary\n${input.summary}\n\n## Conventions\n${input.conventions ?? "(none noted)"}\n` +
    diffBlock +
    (input.target ? `\n## User instructions (verbatim)\n${input.target}\n` : "")
  );
}

export function dedupeCodeReviewCandidates<Context>(
  groups: readonly { readonly angle: Context; readonly candidates: readonly AdvisoryCandidate[] }[],
): Array<{ readonly angle: Context; readonly candidate: AdvisoryCandidate }> {
  const seen = new Set<string>();
  return groups.flatMap(({ angle, candidates }) =>
    candidates
      .filter((candidate) => {
        const key = codeReviewDedupKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((candidate) => ({ angle, candidate })),
  );
}

function codeReviewDedupKey(candidate: AdvisoryCandidate): string {
  const location = primaryLocation(candidate);
  const lineKey = location.line != null ? Math.round(location.line / 5) * 5 : candidate.summary.slice(0, 40).toLowerCase();
  return `${normalizePath(location.file)}:${lineKey}`;
}
