import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { appendTelemetryEvent, telemetryPath } from "../src/telemetry.ts";
import { makeTempDir } from "./support/helpers.ts";

function readLines(cacheDir: string): Array<Record<string, unknown>> {
	return readFileSync(telemetryPath(cacheDir), "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

test("appendTelemetryEvent writes one JSON line with a timestamp", () => {
	const cacheDir = makeTempDir("telemetry-");

	appendTelemetryEvent(cacheDir, { sessionId: "s1", kind: "search", query: "restart deploy", results: ["deploy-fleet"], confidence: "high" });
	appendTelemetryEvent(cacheDir, { sessionId: "s1", kind: "read", name: "deploy-fleet" });

	const lines = readLines(cacheDir);
	assert.equal(lines.length, 2);
	assert.equal(lines[0].kind, "search");
	assert.equal(lines[0].sessionId, "s1");
	assert.equal(typeof lines[0].ts, "number");
	assert.equal(lines[1].kind, "read");
	assert.equal(lines[1].name, "deploy-fleet");

	rmSync(cacheDir, { recursive: true, force: true });
});

test("SKILL_SEARCH_NO_TELEMETRY=1 disables all writes", () => {
	const cacheDir = makeTempDir("telemetry-disabled-");
	process.env.SKILL_SEARCH_NO_TELEMETRY = "1";

	appendTelemetryEvent(cacheDir, { sessionId: "s1", kind: "list", results: [] });

	assert.equal(existsSync(telemetryPath(cacheDir)), false);

	delete process.env.SKILL_SEARCH_NO_TELEMETRY;
	rmSync(cacheDir, { recursive: true, force: true });
});
