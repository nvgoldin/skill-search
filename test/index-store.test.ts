import assert from "node:assert/strict";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { REVIEW_PR_SKILL, DEPLOY_FLEET_SKILL, DEPLOY_TEST_SKILL, makeTempDir, writeSkillFile } from "./support/helpers.ts";

function freshConfig(root: string, cacheDir: string) {
	return { roots: [root], exclude: [], cacheDir };
}

test("index update adds, reports unchanged, updates, and removes skills", () => {
	const root = makeTempDir("index-root-");
	const cacheDir = makeTempDir("index-cache-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "deploy-test", DEPLOY_TEST_SKILL);

	const index = new SkillIndex(indexDbPath(cacheDir));
	const firstRun = index.update(freshConfig(root, cacheDir));
	assert.equal(firstRun.added, 2);
	assert.equal(firstRun.updated, 0);
	assert.equal(firstRun.removed, 0);
	assert.equal(firstRun.unchanged, 0);
	assert.equal(firstRun.total, 2);

	const secondRun = index.update(freshConfig(root, cacheDir));
	assert.equal(secondRun.added, 0);
	assert.equal(secondRun.updated, 0);
	assert.equal(secondRun.unchanged, 2);
	assert.equal(secondRun.total, 2);

	const path = writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL.replace("Manage deploy fleet instances", "Manage and operate deploy fleet instances"));
	const future = new Date(Date.now() + 5000);
	utimesSync(path, future, future);
	const thirdRun = index.update(freshConfig(root, cacheDir));
	assert.equal(thirdRun.updated, 1);
	assert.equal(thirdRun.unchanged, 1);

	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);
	const fourthRun = index.update(freshConfig(root, cacheDir));
	assert.equal(fourthRun.added, 1);
	assert.equal(fourthRun.total, 3);

	rmSync(join(root, "deploy-test"), { recursive: true, force: true });
	const fifthRun = index.update(freshConfig(root, cacheDir));
	assert.equal(fifthRun.removed, 1);
	assert.equal(fifthRun.total, 2);

	const names = index.db.prepare("SELECT name FROM skills ORDER BY name").all() as Array<{ name: string }>;
	assert.deepEqual(names.map((row) => row.name), ["deploy-fleet", "review-pr"]);

	index.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
});

test("a touched file with unchanged content is reported as unchanged, not updated", () => {
	const root = makeTempDir("index-touch-root-");
	const cacheDir = makeTempDir("index-touch-cache-");
	const path = writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);

	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update(freshConfig(root, cacheDir));

	writeFileSync(path, DEPLOY_FLEET_SKILL);
	const future = new Date(Date.now() + 5000);
	utimesSync(path, future, future);
	const run = index.update(freshConfig(root, cacheDir));

	assert.equal(run.updated, 0);
	assert.equal(run.unchanged, 1);

	index.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
});
