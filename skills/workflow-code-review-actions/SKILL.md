---
name: workflow-code-review-actions
description: "Act on selected code-review findings from pi-workflow-engine: make minimal fixes or post GitHub PR inline comments using gh, GitHub MCP/tools, or project-specific tools."
---

Use this skill when the parent agent receives selected code-review finding JSON from `pi-workflow-engine`.

## Inputs

The prompt will include compact JSON with:

- `context`: workflow name, target, diff command, changed files, and optional summary.
- `issues`: selected findings with `id`, `summary`, `category`, `severity`, `confidence`, `location`, `impact`, `evidence`, and `recommendation`.

## Fix mode

When mode is `fix selected code-review findings`:

1. Inspect the selected issue JSON before editing.
2. Make minimal edits that address only the selected findings.
3. Preserve unrelated user changes and avoid broad refactors.
4. Run focused validation if available for the touched files or behavior.
5. Summarize changed files and validation results.
6. Do not post GitHub PR comments in fix mode.

## Comment mode

When mode is `post inline GitHub PR comments`:

1. Do not edit files or make code changes.
2. Prefer installed GitHub MCP/tools if visible in the active tool list.
3. If no GitHub MCP/tools are available, use `gh`:
   - Resolve the PR with `gh pr view --json number,headRefOid,url,headRepositoryOwner,headRepository`.
   - Resolve the repository with `gh repo view --json nameWithOwner` when owner/name is missing.
   - Post each inline comment with `gh api repos/{owner}/{repo}/pulls/{number}/comments` and include `commit_id`, `path`, `line`, and `side=RIGHT`.
4. Keep each comment concise: summary, severity/confidence/category, impact, evidence, and recommendation.
5. Report posted, skipped, and failed counts.

## Safety rules

- Do not post duplicate comments.
- Do not comment line-less findings inline.
- Ask the user if the upstream PR cannot be identified.
- Keep actions scoped to the selected issue IDs only.
