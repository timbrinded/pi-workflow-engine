---
name: workflow-code-review-actions
description: "Act on selected code-review findings from pi-workflow-engine: post GitHub PR inline comments using gh, GitHub MCP/tools, or project-specific tools."
---

Use this skill when the parent agent receives selected code-review finding JSON from `pi-workflow-engine`. The engine hands comments to the parent agent only when its own `gh` posting could not resolve the PR or failed for some findings.

Fixes are never handed off: the results viewer generates isolated, independently validated patch previews for selected findings. Do not edit files in response to a code-review handoff.

## Inputs

The prompt will include the verified reviewed PR head SHA, the reason the engine could not post the comments itself, and compact JSON with:

- `context`: workflow name, target, `diffTarget` (with the PR `number`), display `diffCommand`, changed files, optional summary, and optional snapshot identity.
- `issues`: selected findings with `id`, `summary`, `category`, `severity`, `confidence`, `location`, `impact`, `evidence`, and `recommendation`.

## Comment mode

When mode is `post inline GitHub PR comments`:

1. Do not edit files or make code changes.
2. Prefer installed GitHub MCP/tools if visible in the active tool list.
3. Before posting, resolve the current PR head and require it to equal the verified reviewed head from the prompt; stop if it differs.
4. If no GitHub MCP/tools are available, use `gh`:
   - Resolve the PR with `gh pr view <context.diffTarget.number> --json headRefOid,url`.
   - Take owner/repo from the PR `url`, which names the base repository, so fork PRs are commented upstream. Do not use `headRepositoryOwner`/`headRepository`; on a fork PR they name the fork. Fall back to `gh repo view --json nameWithOwner` only if the URL is missing.
   - Post each inline comment with `gh api repos/{owner}/{repo}/pulls/{number}/comments` and include `commit_id` (the verified head), `path`, `line`, and `side=RIGHT`.
5. Keep each comment concise: summary, severity/confidence/category, impact, evidence, and recommendation.
6. Report posted, skipped, and failed counts.

## Safety rules

- Do not post duplicate comments.
- Do not comment line-less findings inline.
- Ask the user if the upstream PR cannot be identified.
- Keep actions scoped to the selected issue IDs only.
