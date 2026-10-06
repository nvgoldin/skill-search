#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { telemetryPath, type TelemetryEvent } from "../src/telemetry.ts";

type EvalCase = { query: string; expected: string[]; source: "pi-telemetry"; kind?: "command" };

const OUT_PATH = join(import.meta.dirname, "data", "pi-telemetry.jsonl");

function loadEvents(path: string): TelemetryEvent[] {
	const fileExists = existsSync(path);
	if (!fileExists) {
		return [];
	}
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as TelemetryEvent);
}

function groupBySession(events: TelemetryEvent[]): Map<string, TelemetryEvent[]> {
	const bySession = new Map<string, TelemetryEvent[]>();
	for (const event of events) {
		const existing = bySession.get(event.sessionId) ?? [];
		existing.push(event);
		bySession.set(event.sessionId, existing);
	}
	return bySession;
}

/** The first `read` after this event's index, stopping at the next `search` (not reached). */
function findReadBeforeNextSearch(sessionEvents: TelemetryEvent[], searchIndex: number): TelemetryEvent | undefined {
	for (let index = searchIndex + 1; index < sessionEvents.length; index++) {
		const event = sessionEvents[index];
		const isNextSearch = event.kind === "search";
		if (isNextSearch) {
			return undefined;
		}
		if (event.kind === "read") {
			return event;
		}
	}
	return undefined;
}

function searchCasesForSession(sessionEvents: TelemetryEvent[]): EvalCase[] {
	const cases: EvalCase[] = [];
	sessionEvents.forEach((event, index) => {
		const isGroundedSearch = event.kind === "search" && event.query !== undefined;
		if (!isGroundedSearch) {
			return;
		}
		const followingRead = findReadBeforeNextSearch(sessionEvents, index);
		const hasFollowingRead = followingRead !== undefined && followingRead.name !== undefined;
		if (hasFollowingRead) {
			cases.push({ query: event.query as string, expected: [followingRead!.name as string], source: "pi-telemetry" });
		}
	});
	return cases;
}

function commandCasesForSession(sessionEvents: TelemetryEvent[]): EvalCase[] {
	return sessionEvents
		.filter((event) => event.kind === "command" && event.query !== undefined && event.name !== undefined)
		.map((event) => ({ query: event.query as string, expected: [event.name as string], source: "pi-telemetry", kind: "command" }));
}

function main(): void {
	const config = loadConfig();
	const path = telemetryPath(config.cacheDir);
	const events = loadEvents(path);
	const bySession = groupBySession(events);

	const searchCases: EvalCase[] = [];
	const commandCases: EvalCase[] = [];
	for (const sessionEvents of bySession.values()) {
		searchCases.push(...searchCasesForSession(sessionEvents));
		commandCases.push(...commandCasesForSession(sessionEvents));
	}
	const allCases = [...searchCases, ...commandCases];

	const body = allCases.map((evalCase) => JSON.stringify(evalCase)).join("\n");
	writeFileSync(OUT_PATH, allCases.length > 0 ? `${body}\n` : "");

	console.log(`telemetry file: ${path}`);
	console.log(`events: ${events.length}, sessions: ${bySession.size}`);
	console.log(`search-derived cases (search followed by a read before the next search): ${searchCases.length}`);
	console.log(`command-derived cases: ${commandCases.length}`);
	console.log(`total cases: ${allCases.length}`);
	console.log(`wrote ${OUT_PATH}`);
}

main();
