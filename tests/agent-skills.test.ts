import assert from "node:assert/strict";
import { test } from "bun:test";
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import {
  appendSkillReminder,
  extractSkillSelectorsFromText,
  normalizeSkillSelector,
  resolveAgentSkillRequest,
  selectAgentSkills,
} from "../.pi/extensions/pi-workflow-engine/src/agent-skills.ts";

function skill(name: string, disableModelInvocation = false): Skill {
  const filePath = `/skills/${name}/SKILL.md`;
  return {
    name,
    description: `${name} skill`,
    filePath,
    baseDir: `/skills/${name}`,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
    disableModelInvocation,
  };
}

test("extractSkillSelectorsFromText handles slash, skill-first, and name-first opt-ins", () => {
  assert.deepEqual(extractSkillSelectorsFromText("Use /skill:diagnose and include this Skill parallel web search for the verifier."), [
    "diagnose",
    "parallel-web-search",
  ]);
  assert.deepEqual(extractSkillSelectorsFromText("Please use the shape-lang skill and skills: frontend-skill, diagnose."), [
    "frontend-skill",
    "diagnose",
    "shape-lang",
  ]);
});

test("resolveAgentSkillRequest keeps subagents skillless unless prompt or options opt in", () => {
  assert.deepEqual(resolveAgentSkillRequest("ordinary prompt", undefined), { selectors: [], source: "prompt", strict: false });
  assert.deepEqual(resolveAgentSkillRequest("include skill diagnose", []), { selectors: [], source: "explicit", strict: true });
  assert.deepEqual(resolveAgentSkillRequest("ordinary prompt", ["Diagnose", "diagnose"]), {
    selectors: ["diagnose"],
    source: "explicit",
    strict: true,
  });
});

test("normalizeSkillSelector canonicalizes natural skill names", () => {
  assert.equal(normalizeSkillSelector("/skill:parallel-web-search"), "parallel-web-search");
  assert.equal(normalizeSkillSelector("the Parallel Web Search skill"), "parallel-web-search");
  assert.equal(normalizeSkillSelector("workflow_code_review_actions"), "workflow-code-review-actions");
});

test("selectAgentSkills matches exact and unique fuzzy selectors and enables explicit hidden skills", () => {
  const available = [skill("parallel-web-search"), skill("diagnose", true), skill("parallel-web-extract")];

  const resolved = selectAgentSkills(available, ["web search", "diagnose", "missing"]);

  assert.deepEqual(
    resolved.selected.map((item) => item.name),
    ["parallel-web-search", "diagnose"],
  );
  assert.deepEqual(resolved.unmatched, ["missing"]);
  assert.equal(resolved.selected.find((item) => item.name === "diagnose")?.disableModelInvocation, false);
});

test("appendSkillReminder points the subagent at selected SKILL.md files only", () => {
  const prompt = appendSkillReminder("do work", [skill("diagnose")]);

  assert.match(prompt, /Workflow subagent skills enabled: diagnose/);
  assert.match(prompt, /\/skills\/diagnose\/SKILL.md/);
  assert.match(prompt, /No other skills are available/);
});
