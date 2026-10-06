import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { capAtWordBoundary, scanRoots, summary } from "../src/catalog.ts";
import {
	REVIEW_PR_SKILL,
	DEPLOY_FLEET_SKILL,
	FALLBACK_YAML_SKILL,
	NO_DESCRIPTION_SKILL,
	NO_NAME_SKILL,
	makeTempDir,
	writeSkillFile,
} from "./support/helpers.ts";

test("parses frontmatter with yaml and skips a skill with no description", () => {
	const root = makeTempDir("catalog-yaml-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "no-description", NO_DESCRIPTION_SKILL);

	const { docs } = scanRoots([root], []);

	assert.equal(docs.length, 1);
	assert.equal(docs[0].name, "deploy-fleet");
	assert.match(docs[0].description, /Manage deploy fleet instances/);
	assert.match(docs[0].body, /deploy-fleet create/);
	rmSync(root, { recursive: true, force: true });
});

test("falls back to key: value parsing when the frontmatter is not valid yaml", () => {
	const root = makeTempDir("catalog-fallback-");
	writeSkillFile(root, "fallback-skill", FALLBACK_YAML_SKILL);

	const { docs } = scanRoots([root], []);

	assert.equal(docs.length, 1);
	assert.equal(docs[0].name, "fallback-skill");
	assert.match(docs[0].description, /Unterminated quote breaks real YAML parsing/);
	rmSync(root, { recursive: true, force: true });
});

test("uses the folder name when frontmatter has no name field", () => {
	const root = makeTempDir("catalog-noname-");
	writeSkillFile(root, "no-name-folder", NO_NAME_SKILL);

	const { docs } = scanRoots([root], []);

	assert.equal(docs.length, 1);
	assert.equal(docs[0].name, "no-name-folder");
	rmSync(root, { recursive: true, force: true });
});

test("first root wins on a name collision and reports it", () => {
	const rootA = makeTempDir("catalog-collide-a-");
	const rootB = makeTempDir("catalog-collide-b-");
	writeSkillFile(rootA, "review-pr", REVIEW_PR_SKILL);
	writeSkillFile(rootB, "review-pr", DEPLOY_FLEET_SKILL.replace("deploy-fleet", "review-pr"));

	const { docs, collisions } = scanRoots([rootA, rootB], []);

	assert.equal(docs.length, 1);
	assert.match(docs[0].description, /Open and update a pull request/);
	assert.deepEqual(collisions, ["review-pr"]);
	rmSync(rootA, { recursive: true, force: true });
	rmSync(rootB, { recursive: true, force: true });
});

test("exclude removes a skill by name", () => {
	const root = makeTempDir("catalog-exclude-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);

	const { docs } = scanRoots([root], ["review-pr"]);

	assert.equal(docs.length, 1);
	assert.equal(docs[0].name, "deploy-fleet");
	rmSync(root, { recursive: true, force: true });
});

test("summary takes the first sentence and caps at 160 chars on a word boundary", () => {
	const short = "Short one. Second sentence adds a little more detail here for context.";
	assert.equal(summary(short), "Short one. Second sentence adds a little more detail here for context.");

	const long = `${"A".repeat(50)} sentence one goes on for a very long while to force truncation past the one hundred and sixty character cap that the summary rule enforces on every description. Sentence two.`;
	const result = summary(long);
	assert.ok(result.length <= 160);
	assert.ok(result.endsWith("…"));
	assert.ok(!result.includes("  "));
});

test("summary adds the second sentence when the first is short", () => {
	const description = "Fixes bugs. Reads the stack trace, finds the root cause, and applies a minimal patch.";
	const result = summary(description);
	assert.match(result, /Fixes bugs\. Reads the stack trace/);
});

test("capAtWordBoundary cuts to any cap on a word boundary", () => {
	const text = "Routes any deploy request to the right sub-skill: create, list, ssh, or stop boxes, remote development, tests and more.";
	const result = capAtWordBoundary(text, 100);
	assert.ok(result.length <= 100);
	assert.ok(result.endsWith("…"));
	assert.ok(!result.includes("  "));
});
