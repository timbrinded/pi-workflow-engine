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
