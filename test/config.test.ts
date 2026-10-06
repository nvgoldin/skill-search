import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { makeTempDir } from "./support/helpers.ts";

test("loadConfig reads roots, exclude, and cacheDir from the given path", () => {
	const dir = makeTempDir("config-");
	const configPath = join(dir, "skill-search.json");
	writeFileSync(
		configPath,
		JSON.stringify({ roots: [join(dir, "skills-a")], exclude: ["human-review"], cacheDir: join(dir, "cache") }),
	);

	const config = loadConfig(configPath);

	assert.deepEqual(config.roots, [join(dir, "skills-a")]);
	assert.deepEqual(config.exclude, ["human-review"]);
	assert.equal(config.cacheDir, join(dir, "cache"));

	rmSync(dir, { recursive: true, force: true });
});

test("loadConfig fails loudly when the file is missing", () => {
	assert.throws(() => loadConfig("/nonexistent/skill-search.json"), /not found/);
});
