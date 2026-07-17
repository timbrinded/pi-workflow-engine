import assert from "node:assert/strict";
import { test } from "bun:test";
import { changedLines, inDiff } from "../.pi/extensions/pi-workflow-engine/workflows/code-review.ts";
import {
  buildCodeReviewScopeBlock,
  dedupeCodeReviewCandidates,
} from "../.pi/extensions/pi-workflow-engine/src/review/code-review-orchestration.ts";

function lines(map: Map<string, Set<number>>, file: string): number[] {
  return [...(map.get(file) ?? [])].sort((a, b) => a - b);
}

test("changedLines records single-hunk added lines and inDiff matches them", () => {
  const diff = `diff --git a/sum.js b/sum.js
index e0f74bf..54295d7 100644
--- a/sum.js
+++ b/sum.js
@@ -1,6 +1,6 @@
 function sum(arr) {
   let total = 0;
-  for (let i = 0; i < arr.length; i++) total += arr[i];
+  for (let i = 0; i <= arr.length; i++) total += arr[i];
   return total;
 }
 module.exports = { sum };
`;

  const changed = changedLines(diff);
  assert.deepEqual(lines(changed, "sum.js"), [3]);
  assert.equal(inDiff(changed, "sum.js", 3), true);
  assert.equal(inDiff(changed, "b/sum.js", 4), true);
  assert.equal(inDiff(changed, "sum.js", 7), false);
  assert.equal(inDiff(changed, "other.js", 3), false);
  assert.equal(inDiff(changed, "sum.js"), true);
});

test("code-review scope construction bounds embedded diffs and preserves context", () => {
  const block = buildCodeReviewScopeBlock({
    diffCommand: "git diff HEAD",
    files: ["src/app.ts"],
    summary: "One changed file.",
    conventions: "Keep helpers pure.",
    diffText: "x".repeat(60_001),
    target: "focus on parsing",
  });

  assert.match(block, /## Diff command\ngit diff HEAD/);
  assert.match(block, /## Changed files\n- src\/app\.ts/);
  assert.match(block, /\.\.\. \(truncated — run `git diff HEAD` for the full diff\)/);
  assert.match(block, /## User instructions \(verbatim\)\nfocus on parsing/);
});

test("code-review candidate deduplication retains first discovery order", () => {
  const candidate = (summary: string, file: string, line: number) => ({
    summary,
    category: "bug",
    locations: [{ file, line }],
    impact: `${summary} impact`,
  });
  const first = candidate("first", "src/app.ts", 11);
  const duplicate = candidate("duplicate", "./src/app.ts", 12);
  const distinct = candidate("distinct", "src/app.ts", 30);

  assert.deepEqual(dedupeCodeReviewCandidates([
    { angle: "logic", candidates: [first] },
    { angle: "edge", candidates: [duplicate, distinct] },
  ]), [
    { angle: "logic", candidate: first },
    { angle: "edge", candidate: distinct },
  ]);
});

test("changedLines records multi-hunk edits and new files", () => {
  const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@ function f() {
 const x = 1;
+const y = 2;
 const z = 3;
 return x;
@@ -40,2 +41,2 @@ function g() {
-  old();
+  new();
   keep();
diff --git a/b.ts b/b.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/b.ts
@@ -0,0 +1,2 @@
+export const A = 1;
+export const B = 2;
`;

  const changed = changedLines(diff);
  assert.deepEqual(lines(changed, "a.ts"), [11, 41]);
  assert.deepEqual(lines(changed, "b.ts"), [1, 2]);
});
