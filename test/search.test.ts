import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { listSkills, rankTopSkills, search } from "../src/search.ts";
import {
	API_SERVICE_E2E_ON_DEPLOY_SKILL,
	REVIEW_PR_SKILL,
	DEPLOY_FLEET_SKILL,
	DEPLOY_SKILL,
	DEPLOY_TEST_SKILL,
	ORACLE_CDC_DEPLOY_SKILL,
	makeTempDir,
	writeSkillFile,
} from "./support/helpers.ts";

function buildIndex() {
	const root = makeTempDir("search-root-");
	const cacheDir = makeTempDir("search-cache-");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "deploy-test", DEPLOY_TEST_SKILL);
	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });
	return { index, root, cacheDir };
}

function cleanup(root: string, cacheDir: string, index: SkillIndex) {
	index.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
}

test("an exact skill name in the query is returned first and marks high confidence", () => {
	const { index, root, cacheDir } = buildIndex();

	const outcome = search(index, "deploy-fleet create a box");

	assert.equal(outcome.confidence, "high");
	assert.equal(outcome.results[0].name, "deploy-fleet");
	assert.equal(outcome.results.length, 1);

	cleanup(root, cacheDir, index);
});

test("an exact skill name in space form is also recognized", () => {
	const { index, root, cacheDir } = buildIndex();

	const outcome = search(index, "run the deploy fleet skill");

	assert.equal(outcome.results[0].name, "deploy-fleet");

	cleanup(root, cacheDir, index);
});

test("a query that fits several unrelated skills about equally returns 3 results at normal confidence", () => {
	const root = makeTempDir("search-normal-root-");
	const cacheDir = makeTempDir("search-normal-cache-");
	writeSkillFile(
		root,
		"alpha-deploy",
		"---\nname: alpha-deploy\ndescription: Deploys the alpha service to production with a canary rollout and health checks.\n---\n\n# alpha-deploy\n\nRun the deploy pipeline for the alpha service, then watch the canary metrics.\n",
	);
	writeSkillFile(
		root,
		"beta-release",
		"---\nname: beta-release\ndescription: Cuts a release for the beta service and deploys it across every region.\n---\n\n# beta-release\n\nTag the build, then deploy to each region one at a time.\n",
	);
	writeSkillFile(
		root,
		"gamma-rollout",
		"---\nname: gamma-rollout\ndescription: Rolls a gamma build out behind a feature flag before a full deploy.\n---\n\n# gamma-rollout\n\nEnable the flag, deploy to 1 percent, then ramp up.\n",
	);
	writeSkillFile(
		root,
		"delta-docs",
		"---\nname: delta-docs\ndescription: Writes delta release notes and changelog entries for the docs site.\n---\n\n# delta-docs\n\nSummarize every merged change since the last tag.\n",
	);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const outcome = search(index, "deploy the service");

	assert.equal(outcome.confidence, "normal");
	assert.equal(outcome.results.length, 3);
	assert.equal(outcome.results[0].name, "alpha-deploy");

	cleanup(root, cacheDir, index);
});

test("results never include scores, paths, or body text", () => {
	const { index, root, cacheDir } = buildIndex();

	const outcome = search(index, "deploy");
	for (const result of outcome.results) {
		assert.deepEqual(Object.keys(result).sort(), ["name", "summary"]);
	}

	cleanup(root, cacheDir, index);
});

test("options.limit overrides the confidence-based result count", () => {
	const { index, root, cacheDir } = buildIndex();

	const outcome = search(index, "deploy", { limit: 1 });
	assert.equal(outcome.results.length, 1);

	cleanup(root, cacheDir, index);
});

test("several near-identical matches are ambiguous and return up to 5 results", () => {
	const root = makeTempDir("search-ambiguous-root-");
	const cacheDir = makeTempDir("search-ambiguous-cache-");
	const filler = "Handles the widget workflow end to end with the same shape of steps and the same length of text.";
	for (const suffix of ["one", "two", "three", "four", "five"]) {
		writeSkillFile(
			root,
			`widget-${suffix}`,
			`---\nname: widget-${suffix}\ndescription: ${filler}\n---\n\n# widget-${suffix}\n\n${filler}\n`,
		);
	}
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const outcome = search(index, "widget workflow");

	assert.equal(outcome.confidence, "ambiguous");
	assert.equal(outcome.results.length, 5);

	cleanup(root, cacheDir, index);
});

test("a skill name shorter than 4 chars counts as an exact match only in the /name form", () => {
	const root = makeTempDir("search-short-name-root-");
	const cacheDir = makeTempDir("search-short-name-cache-");
	writeSkillFile(root, "pr", "---\nname: pr\ndescription: Opens a pull request from the current branch with the default template.\n---\n\n# pr\n\nRun the pr flow.\n");
	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const bareWord = rankTopSkills(index, "open a pr for this change");
	assert.equal(bareWord.hasExactMatch, false);

	const slashForm = rankTopSkills(index, "run /pr now");
	assert.equal(slashForm.hasExactMatch, true);
	assert.equal(slashForm.scored[0].name, "pr");

	cleanup(root, cacheDir, index);
});

test("when several skill names match, the longest is promoted first", () => {
	const root = makeTempDir("search-longest-first-root-");
	const cacheDir = makeTempDir("search-longest-first-cache-");
	writeSkillFile(root, "deploy", "---\nname: deploy\ndescription: Overview of the deploy tooling and where to start.\n---\n\n# deploy\n\nStart here.\n");
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const outcome = rankTopSkills(index, "deploy-fleet and deploy are both useful");

	assert.deepEqual(
		outcome.scored.slice(0, 2).map((row) => row.name),
		["deploy-fleet", "deploy"],
	);

	cleanup(root, cacheDir, index);
});

test("an exact name match is found even when the skill has no FTS rows for the query", () => {
	const root = makeTempDir("search-outside-top20-root-");
	const cacheDir = makeTempDir("search-outside-top20-cache-");
	for (let index = 0; index < 22; index++) {
		writeSkillFile(
			root,
			`filler-${index}`,
			`---\nname: filler-${index}\ndescription: Please handle widgets for the display team, handle widgets please.\n---\n\n# filler-${index}\n\nPlease handle widgets every night, handle widgets please.\n`,
		);
	}
	writeSkillFile(
		root,
		"with-that",
		"---\nname: with-that\ndescription: Rotates an unrelated internal process for the archive team on a schedule.\n---\n\n# with-that\n\nRotate the archive process nightly on a timer.\n",
	);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });

	const outcome = rankTopSkills(index, "with-that please handle widgets for me");

	assert.equal(outcome.hasExactMatch, true);
	assert.equal(outcome.scored[0].name, "with-that");

	cleanup(root, cacheDir, index);
});

function buildAreaIndex() {
	const root = makeTempDir("search-area-root-");
	const cacheDir = makeTempDir("search-area-cache-");
	writeSkillFile(root, "deploy", DEPLOY_SKILL);
	writeSkillFile(root, "deploy-fleet", DEPLOY_FLEET_SKILL);
	writeSkillFile(root, "deploy-test", DEPLOY_TEST_SKILL);
	writeSkillFile(root, "api-service-e2e-on-deploy", API_SERVICE_E2E_ON_DEPLOY_SKILL);
	writeSkillFile(root, "oracle-cdc-deploy", ORACLE_CDC_DEPLOY_SKILL);
	writeSkillFile(root, "review-pr", REVIEW_PR_SKILL);
	const index = new SkillIndex(indexDbPath(cacheDir));
	index.update({ roots: [root], exclude: [], cacheDir });
	return { index, root, cacheDir };
}

test("listSkills with no area returns the full catalog, alphabetical by name", () => {
	const { index, root, cacheDir } = buildAreaIndex();

	const entries = listSkills(index);

	assert.deepEqual(entries.map((entry) => entry.name), [
		"api-service-e2e-on-deploy",
		"deploy",
		"deploy-fleet",
		"deploy-test",
		"oracle-cdc-deploy",
		"review-pr",
	]);

	cleanup(root, cacheDir, index);
});

test("listSkills with area keeps names that start with it or have it as a hyphen word", () => {
	const { index, root, cacheDir } = buildAreaIndex();

	const entries = listSkills(index, "deploy");

	assert.deepEqual(entries.map((entry) => entry.name), [
		"api-service-e2e-on-deploy",
		"deploy",
		"deploy-fleet",
		"deploy-test",
		"oracle-cdc-deploy",
	]);

	cleanup(root, cacheDir, index);
});

test("listSkills with an area that matches nothing returns an empty list", () => {
	const { index, root, cacheDir } = buildAreaIndex();

	const entries = listSkills(index, "no-such-area");

	assert.deepEqual(entries, []);

	cleanup(root, cacheDir, index);
});
