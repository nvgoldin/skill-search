import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { readSkill } from "../src/read.ts";
import { REVIEW_PR_SKILL, DEPLOY_FLEET_SKILL, DEPLOY_TEST_SKILL, makeTempDir, writeSkillFile } from "./support/helpers.ts";

test("read returns the full file with a 2-line header", () => {
	const root = makeTempDir("read-root-");
	const cacheDir = makeTempDir("read-cache-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const text = readSkill(index, "deploy-fleet");
	const lines = text.split("\n");

	assert.equal(lines[0], "Skill: deploy-fleet");
	assert.equal(lines[1], `Directory: ${root}/deploy-fleet`);
	assert.match(text, /deploy-fleet create/);

	index.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
});

test("read of an unknown name throws with the 3 closest names", () => {
	const root = makeTempDir("read-unknown-root-");
	const cacheDir = makeTempDir("read-unknown-cache-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "deploy-test", DEPLOY_TEST_SKILL);
	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	assert.throws(() => readSkill(index, "deploy-flet"), /Unknown skill: deploy-flet/);

	index.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
});
