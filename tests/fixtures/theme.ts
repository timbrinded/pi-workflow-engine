import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AdvisoryReport } from "../../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";

type ThemeBg = Parameters<Theme["bg"]>[0];

const fgKeys: ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

const bgKeys: ThemeBg[] = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];

export function createTestTheme(): Theme {
  return new Theme(
    Object.fromEntries(fgKeys.map((key) => [key, ""])) as Record<ThemeColor, string | number>,
    Object.fromEntries(bgKeys.map((key) => [key, ""])) as Record<ThemeBg, string | number>,
    "truecolor",
  );
}

export function createReviewReportFixture(): AdvisoryReport {
  const longSummary =
    "This intentionally long finding summary exercises truncation and wrapping in both the compact table and interactive detail pane without requiring a real terminal.";
  return {
    summary: "Review complete with multiple severities.",
    findings: [
      {
        summary: longSummary,
        category: "bug",
        severity: "high",
        confidence: "high",
        locations: [{ file: "src/app.ts", line: 10, symbol: "retry" }],
        evidence: ["line 10 increments before checking the limit"],
        impact: "A final retry is skipped.",
        recommendation: "Change the loop boundary after adding a regression test.",
      },
      {
        summary: "The cleanup path duplicates parser setup.",
        category: "cleanup",
        severity: "medium",
        confidence: "medium",
        locations: [{ file: "src/parser.ts", line: 42 }],
        evidence: ["parser setup repeats the same option defaults"],
        impact: "Future parser changes need to be made in two places.",
        recommendation: "Extract a shared parser option helper.",
      },
      {
        summary: "Documentation omits the new flag.",
        category: "cleanup",
        severity: "low",
        confidence: "low",
        locations: [{ file: "README.md" }],
        evidence: ["README lists old flags only"],
        impact: "Users may miss the new workflow option.",
        recommendation: "Document the flag in the workflow usage section.",
      },
    ],
    nextSteps: ["Inspect src/app.ts retry loop"],
  };
}

/** Drops SGR colour/style escapes so assertions can match rendered text. */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
