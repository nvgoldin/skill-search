#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanRoots } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { gatewayComplete, hashKey, loadDiskCache, readApiKey, runWithConcurrency, saveDiskCache } from "./gateway.ts";

type EvalCase = Record<string, unknown> & { query: string; expected: string[]; nameInQuery?: boolean };
type Judgment = "yes" | "no" | "unclear";
type SkillInfo = { name: string; description: string };

const DATA_DIR = join(import.meta.dirname, "data");
const INPUT_PATH = join(DATA_DIR, "claude-real.jsonl");
const OUTPUT_PATH = join(DATA_DIR, "claude-real-clean.jsonl");
const CACHE_PATH = join(DATA_DIR, "judge-cache.json");
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 40;

function loadCases(path: string): EvalCase[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as EvalCase);
}

function buildSkillLookup(): Map<string, SkillInfo> {
	const config = loadConfig();
	const { docs } = scanRoots(config.roots, config.exclude);
	return new Map(docs.map((doc) => [doc.name, { name: doc.name, description: doc.description }]));
}

function buildPrompt(query: string, skill: SkillInfo): string {
	return [
		"Here is a request an engineer sent to a coding agent, and a skill the agent then used (name + description).",
		"From the request text ALONE, should an agent pick this skill? Answer one word: yes, no, or unclear.",
		"",
		"Request:",
		query,
		"",
		"Skill name:",
		skill.name,
		"",
		"Skill description:",
		skill.description,
	].join("\n");
}

function parseJudgment(text: string): Judgment {
	const firstWord = text.trim().toLowerCase().split(/\W+/)[0] ?? "";
	const isKnownJudgment = firstWord === "yes" || firstWord === "no" || firstWord === "unclear";
	return isKnownJudgment ? (firstWord as Judgment) : "unclear";
}

function cacheKeyFor(query: string, skill: SkillInfo): string {
	return hashKey(`${query}\u0000${skill.name}\u0000${skill.description}`);
}

async function judgeCase(apiKey: string, evalCase: EvalCase, skillLookup: Map<string, SkillInfo>, cache: Record<string, Judgment>): Promise<Judgment> {
	const expectedName = evalCase.expected[0];
	const skill = skillLookup.get(expectedName);
	const skillMissing = skill === undefined;
	if (skillMissing) {
		throw new Error(`no skill doc found for expected name ${expectedName}`);
	}
	const key = cacheKeyFor(evalCase.query, skill);
	const cached = cache[key];
	if (cached !== undefined) {
		return cached;
	}
	const reply = await gatewayComplete(apiKey, buildPrompt(evalCase.query, skill), 10);
	const judgment = parseJudgment(reply.text);
	cache[key] = judgment;
	return judgment;
}

function groupLabel(evalCase: EvalCase): string {
	return evalCase.nameInQuery ? "nameInQuery=true" : "nameInQuery=false";
}

function printCounts(cases: EvalCase[], judgments: Judgment[]): void {
	const groups = new Map<string, Record<Judgment, number>>();
	cases.forEach((evalCase, index) => {
		const label = groupLabel(evalCase);
		const counts = groups.get(label) ?? { yes: 0, no: 0, unclear: 0 };
		counts[judgments[index]]++;
		groups.set(label, counts);
	});
	console.log("Judge label counts (per nameInQuery):");
	for (const [label, counts] of groups) {
		const total = counts.yes + counts.no + counts.unclear;
		console.log(`  ${label}: total=${total} yes=${counts.yes} no=${counts.no} unclear=${counts.unclear}`);
	}
	const overall = { yes: 0, no: 0, unclear: 0 };
	for (const judgment of judgments) {
		overall[judgment]++;
	}
	console.log(`  overall: total=${judgments.length} yes=${overall.yes} no=${overall.no} unclear=${overall.unclear}`);
}

async function main(): Promise<void> {
	const cases = loadCases(INPUT_PATH);
	const skillLookup = buildSkillLookup();
	const cache = loadDiskCache<Judgment>(CACHE_PATH);
	const apiKey = readApiKey();

	const judgments: Judgment[] = new Array(cases.length);
	let processed = 0;
	let failed = 0;
	const indexedCases = cases.map((evalCase, index) => ({ evalCase, index }));
	await runWithConcurrency(indexedCases, CONCURRENCY, async ({ evalCase, index }) => {
		try {
			judgments[index] = await judgeCase(apiKey, evalCase, skillLookup, cache);
			processed++;
		} catch (error) {
			failed++;
			judgments[index] = "unclear";
			console.error(`judge failed for case ${index}: ${(error as Error).message}`);
		}
		const isCheckpoint = (processed + failed) % CHECKPOINT_EVERY === 0;
		if (isCheckpoint) {
			saveDiskCache(CACHE_PATH, cache);
			console.log(`progress: ${processed + failed}/${cases.length} (${failed} failed)`);
		}
	});
	saveDiskCache(CACHE_PATH, cache);
	const hasFailures = failed > 0;
	if (hasFailures) {
		console.log(`${failed} case(s) failed and were treated as "unclear" for this run. Rerun the script to retry them from the cache.`);
	}

	printCounts(cases, judgments);

	const cleanLines = cases
		.filter((_evalCase, index) => judgments[index] === "yes")
		.map((evalCase) => JSON.stringify({ ...evalCase, judged: "yes" }));
	writeFileSync(OUTPUT_PATH, `${cleanLines.join("\n")}\n`);
	console.log(`Wrote ${cleanLines.length} clean cases to ${OUTPUT_PATH}`);
}

main();
