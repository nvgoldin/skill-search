#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { rankTopSkills, type Confidence, type ScoredSkill, type SearchWeights } from "../src/search.ts";
import { loadCondensedCache, queryHash } from "./condense-queries.ts";

type EvalCase = { query: string; expected: string[]; source: string; nameInQuery?: boolean };
type TaggedCase = EvalCase & { file: string };

const DATA_DIR = join(import.meta.dirname, "data");

const WEIGHT_SETS: Record<string, SearchWeights> = {
	"3/2/1": [3, 2, 1],
	"5/3/1": [5, 3, 1],
	"3/2/0.5": [3, 2, 0.5],
	"3/2/0": [3, 2, 0],
};

const RATIO_SETS: Array<{ label: string; highRatio: number; ambiguousRatio: number }> = [
	{ label: "high=1.5 amb=0.75", highRatio: 1.5, ambiguousRatio: 0.75 },
	{ label: "high=1.5 amb=0.85", highRatio: 1.5, ambiguousRatio: 0.85 },
	{ label: "high=2.0 amb=0.75", highRatio: 2.0, ambiguousRatio: 0.75 },
	{ label: "high=2.0 amb=0.85 (default)", highRatio: 2.0, ambiguousRatio: 0.85 },
	{ label: "high=2.0 amb=0.9", highRatio: 2.0, ambiguousRatio: 0.9 },
	{ label: "high=2.5 amb=0.85", highRatio: 2.5, ambiguousRatio: 0.85 },
];

function loadDataset(path: string): TaggedCase[] {
	const file = basename(path);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => ({ ...(JSON.parse(line) as EvalCase), file }));
}

function loadAllCases(): TaggedCase[] {
	const files = readdirSync(DATA_DIR)
		.filter((file) => file.endsWith(".jsonl"))
		.sort()
		.map((file) => join(DATA_DIR, file));
	return files.flatMap(loadDataset);
}

function firstHitRank(expected: string[], names: string[]): number | undefined {
	const expectedSet = new Set(expected);
	const index = names.findIndex((name) => expectedSet.has(name));
	return index === -1 ? undefined : index + 1;
}

function queriesForCase(evalCase: EvalCase, mode: "raw" | "condensed", cache: Record<string, string[]>): string[] {
	if (mode === "raw") {
		return [evalCase.query];
	}
	const cached = cache[queryHash(evalCase.query)];
	return cached !== undefined && cached.length > 0 ? cached : [evalCase.query];
}

function hitAt3Rate(index: SkillIndex, cases: TaggedCase[], mode: "raw" | "condensed", weights: SearchWeights, cache: Record<string, string[]>): number {
	let hits = 0;
	for (const evalCase of cases) {
		const queries = queriesForCase(evalCase, mode, cache);
		const bestRank = queries
			.map((query) => firstHitRank(evalCase.expected, rankTopSkills(index, query, weights).scored.map((row) => row.name)))
			.filter((rank): rank is number => rank !== undefined)
			.sort((left, right) => left - right)[0];
		if (bestRank !== undefined && bestRank <= 3) {
			hits++;
		}
	}
	return cases.length > 0 ? hits / cases.length : 0;
}

function classifyConfidence(scored: ScoredSkill[], hasExactMatch: boolean, highRatio: number, ambiguousRatio: number): Confidence {
	const top1 = scored[0]?.score;
	const top2 = scored[1]?.score;
	const top3 = scored[2]?.score;
	const topFarAheadOfSecond = top1 !== undefined && top2 !== undefined && top1 >= highRatio * top2;
	const isHigh = hasExactMatch || topFarAheadOfSecond;
	if (isHigh) {
		return "high";
	}
	const thirdCloseToFirst = top1 !== undefined && top3 !== undefined && top3 >= ambiguousRatio * top1;
	return thirdCloseToFirst ? "ambiguous" : "normal";
}

function countForConfidence(confidence: Confidence): number {
	if (confidence === "high") {
		return 1;
	}
	return confidence === "ambiguous" ? 5 : 3;
}

function resultTextLength(scored: ScoredSkill[], count: number, confidence: Confidence): number {
	const hasNoResults = scored.length === 0;
	if (hasNoResults) {
		return "No matching skill.".length;
	}
	const lines = scored.slice(0, count).map((row) => `${row.name} — ${row.summary}`);
	const header = confidence === "high" ? "Best match:\n" : "";
	return (header + lines.join("\n")).length;
}

function actualHitAt3AndTokens(
	index: SkillIndex,
	cases: TaggedCase[],
	weights: SearchWeights,
	highRatio: number,
	ambiguousRatio: number,
	cache: Record<string, string[]>,
	mode: "raw" | "condensed" = "condensed",
): { actualHitRate: number; meanTokens: number } {
	let hits = 0;
	let tokenSum = 0;
	for (const evalCase of cases) {
		const queries = queriesForCase(evalCase, mode, cache);
		let caseHit = false;
		let caseTokens = 0;
		for (const query of queries) {
			const { scored, hasExactMatch } = rankTopSkills(index, query, weights);
			const confidence = classifyConfidence(scored, hasExactMatch, highRatio, ambiguousRatio);
			const count = countForConfidence(confidence);
			const rank = firstHitRank(evalCase.expected, scored.slice(0, count).map((row) => row.name));
			if (rank !== undefined) {
				caseHit = true;
			}
			caseTokens += resultTextLength(scored, count, confidence) / 4;
		}
		if (caseHit) {
			hits++;
		}
		tokenSum += caseTokens;
	}
	return { actualHitRate: cases.length > 0 ? hits / cases.length : 0, meanTokens: cases.length > 0 ? tokenSum / cases.length : 0 };
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function main(): void {
	const config = loadConfig();
	const index = new SkillIndex(indexDbPath(config.cacheDir));
	index.update(config);

	const allCases = loadAllCases();
	const cache = loadCondensedCache();

	console.log("=== weight tuning: Hit@3, all cases combined ===");
	console.log(["weights", "raw Hit@3", "condensed Hit@3"].join("\t"));
	for (const [label, weights] of Object.entries(WEIGHT_SETS)) {
		const rawHit = hitAt3Rate(index, allCases, "raw", weights, cache);
		const condensedHit = hitAt3Rate(index, allCases, "condensed", weights, cache);
		console.log([label, formatPercent(rawHit), formatPercent(condensedHit)].join("\t"));
	}

	const bestWeights: SearchWeights = [3, 2, 0.5];
	console.log(`\n=== ratio tuning with weights ${bestWeights.join("/")}: actual (confidence-bounded) Hit@3 and mean search-result tokens ===`);
	console.log(["ratios", "raw actual Hit@3", "raw tokens/case", "condensed actual Hit@3", "condensed tokens/case"].join("\t"));
	for (const ratioSet of RATIO_SETS) {
		const raw = actualHitAt3AndTokens(index, allCases, bestWeights, ratioSet.highRatio, ratioSet.ambiguousRatio, cache, "raw");
		const condensed = actualHitAt3AndTokens(index, allCases, bestWeights, ratioSet.highRatio, ratioSet.ambiguousRatio, cache, "condensed");
		console.log(
			[ratioSet.label, formatPercent(raw.actualHitRate), raw.meanTokens.toFixed(1), formatPercent(condensed.actualHitRate), condensed.meanTokens.toFixed(1)].join("\t"),
		);
	}

	index.close();
}

main();
