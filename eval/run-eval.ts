#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { DEFAULT_WEIGHTS, rankTopSkills, search, type SearchOutcome, type SearchWeights } from "../src/search.ts";
import { loadCondensedCache, queryHash, type CondenseCache } from "./condense-queries.ts";

type EvalCase = { query: string; expected: string[]; source: string; nameInQuery?: boolean };
type TaggedCase = EvalCase & { file: string };

type QueryMode = "raw" | "condensed";

type SubsetMetrics = {
	label: string;
	cases: number;
	hitAt1: number;
	hitAt3: number;
	hitAt5: number;
	mrr: number;
	meanSearches: number;
	meanResults: number;
	meanResultTokens: number;
};

const VARIANTS: Record<string, SearchWeights> = {
	"fts-all": DEFAULT_WEIGHTS,
	"fts-name-desc": [3.0, 2.0, 0.0],
	"w-3-2-1": [3.0, 2.0, 1.0],
	"w-5-3-1": [5.0, 3.0, 1.0],
};

const DATA_DIR = join(import.meta.dirname, "data");

function parseFlag(argv: string[], flag: string, fallback: string): string {
	const flagIndex = argv.indexOf(flag);
	const hasFlag = flagIndex !== -1;
	return hasFlag ? argv[flagIndex + 1] : fallback;
}

function listDatasetFiles(dir: string): string[] {
	const dirExists = existsSync(dir);
	if (!dirExists) {
		return [];
	}
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.sort()
		.map((file) => join(dir, file));
}

function loadDataset(path: string): TaggedCase[] {
	const file = basename(path);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => ({ ...(JSON.parse(line) as EvalCase), file }));
}

function firstHitRank(expected: string[], names: string[]): number | undefined {
	const expectedSet = new Set(expected);
	const index = names.findIndex((name) => expectedSet.has(name));
	return index === -1 ? undefined : index + 1;
}

function formatToolResultText(outcome: SearchOutcome): string {
	const hasNoResults = outcome.results.length === 0;
	if (hasNoResults) {
		return "No matching skill.";
	}
	const lines = outcome.results.map((result) => `${result.name} — ${result.summary}`);
	const isHighConfidence = outcome.confidence === "high";
	const header = isHighConfidence ? "Best match:\n" : "";
	return `${header}${lines.join("\n")}`;
}

function queriesForCase(evalCase: EvalCase, mode: QueryMode, cache: CondenseCache): { queries: string[]; wasCached: boolean } {
	if (mode === "raw") {
		return { queries: [evalCase.query], wasCached: true };
	}
	const cached = cache[queryHash(evalCase.query)];
	const hasCached = cached !== undefined && cached.length > 0;
	return hasCached ? { queries: cached, wasCached: true } : { queries: [evalCase.query], wasCached: false };
}

type CaseOutcome = { bestRank: number | undefined; searchCount: number; resultCount: number; resultTokens: number };

function evaluateCase(index: SkillIndex, queries: string[], expected: string[], weights: SearchWeights): CaseOutcome {
	let bestRank: number | undefined;
	let resultCount = 0;
	let resultTokens = 0;
	for (const query of queries) {
		const { scored } = rankTopSkills(index, query, weights);
		const rank = firstHitRank(expected, scored.map((row) => row.name));
		const isBetterRank = rank !== undefined && (bestRank === undefined || rank < bestRank);
		if (isBetterRank) {
			bestRank = rank;
		}
		const outcome = search(index, query, { weights });
		resultCount += outcome.results.length;
		resultTokens += formatToolResultText(outcome).length / 4;
	}
	return { bestRank, searchCount: queries.length, resultCount, resultTokens };
}

function evaluateSubset(index: SkillIndex, label: string, cases: TaggedCase[], weights: SearchWeights, mode: QueryMode, cache: CondenseCache): { metrics: SubsetMetrics; uncachedCount: number } {
	let hitAt1 = 0;
	let hitAt3 = 0;
	let hitAt5 = 0;
	let reciprocalRankSum = 0;
	let searchCountSum = 0;
	let resultCountSum = 0;
	let resultTokenSum = 0;
	let uncachedCount = 0;

	for (const evalCase of cases) {
		const { queries, wasCached } = queriesForCase(evalCase, mode, cache);
		if (!wasCached) {
			uncachedCount++;
		}
		const outcome = evaluateCase(index, queries, evalCase.expected, weights);
		const hit = outcome.bestRank !== undefined;
		if (hit && outcome.bestRank! <= 1) {
			hitAt1++;
		}
		if (hit && outcome.bestRank! <= 3) {
			hitAt3++;
		}
		if (hit && outcome.bestRank! <= 5) {
			hitAt5++;
		}
		reciprocalRankSum += hit ? 1 / outcome.bestRank! : 0;
		searchCountSum += outcome.searchCount;
		resultCountSum += outcome.resultCount;
		resultTokenSum += outcome.resultTokens;
	}

	const caseCount = cases.length;
	const hasCases = caseCount > 0;
	const metrics: SubsetMetrics = {
		label,
		cases: caseCount,
		hitAt1: hasCases ? hitAt1 / caseCount : 0,
		hitAt3: hasCases ? hitAt3 / caseCount : 0,
		hitAt5: hasCases ? hitAt5 / caseCount : 0,
		mrr: hasCases ? reciprocalRankSum / caseCount : 0,
		meanSearches: hasCases ? searchCountSum / caseCount : 0,
		meanResults: hasCases ? resultCountSum / caseCount : 0,
		meanResultTokens: hasCases ? resultTokenSum / caseCount : 0,
	};
	return { metrics, uncachedCount };
}

function buildSubsets(allCases: TaggedCase[], claudeRealFile: string): Array<{ label: string; cases: TaggedCase[] }> {
	const claudeReal = allCases.filter((evalCase) => evalCase.file === claudeRealFile);
	const synthetic = allCases.filter((evalCase) => evalCase.file === "synthetic-pr391.jsonl");
	const claudeRealLabel = claudeRealFile.replace(/\.jsonl$/, "");
	return [
		{ label: `${claudeRealLabel} nameInQuery=false`, cases: claudeReal.filter((evalCase) => !evalCase.nameInQuery) },
		{ label: `${claudeRealLabel} nameInQuery=true`, cases: claudeReal.filter((evalCase) => Boolean(evalCase.nameInQuery)) },
		{ label: "synthetic", cases: synthetic },
	];
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function printTable(rows: SubsetMetrics[]): void {
	const headers = ["subset", "cases", "Hit@1", "Hit@3", "Hit@5", "MRR", "mean searches", "mean results", "mean result tokens"];
	const lines = rows.map((row) => [
		row.label,
		String(row.cases),
		formatPercent(row.hitAt1),
		formatPercent(row.hitAt3),
		formatPercent(row.hitAt5),
		row.mrr.toFixed(3),
		row.meanSearches.toFixed(2),
		row.meanResults.toFixed(2),
		row.meanResultTokens.toFixed(1),
	]);
	const widths = headers.map((header, column) => Math.max(header.length, ...lines.map((line) => line[column].length)));
	const renderRow = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
	console.log(renderRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const line of lines) {
		console.log(renderRow(line));
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const variantName = parseFlag(argv, "--variant", "fts-all");
	const weights = VARIANTS[variantName];
	const isKnownVariant = weights !== undefined;
	if (!isKnownVariant) {
		throw new Error(`unknown --variant: ${variantName}. Known variants: ${Object.keys(VARIANTS).join(", ")}`);
	}

	const mode = parseFlag(argv, "--queries", "raw") as QueryMode;
	const isKnownMode = mode === "raw" || mode === "condensed";
	if (!isKnownMode) {
		throw new Error(`unknown --queries: ${mode}. Known modes: raw, condensed`);
	}

	const claudeRealFile = `${parseFlag(argv, "--dataset", "claude-real")}.jsonl`;

	const datasetFiles = listDatasetFiles(DATA_DIR).filter((path) => {
		const file = basename(path);
		return file === claudeRealFile || file === "synthetic-pr391.jsonl";
	});
	const hasDatasets = datasetFiles.length > 0;
	if (!hasDatasets) {
		console.log(`No eval datasets found under ${DATA_DIR}. Nothing to run.`);
		return;
	}

	const config = loadConfig();
	const index = new SkillIndex(indexDbPath(config.cacheDir));
	index.update(config);

	const allCases = datasetFiles.flatMap(loadDataset);
	const subsets = buildSubsets(allCases, claudeRealFile);
	const cache = mode === "condensed" ? loadCondensedCache() : {};

	console.log(`queries: ${mode}  variant: ${variantName} (name=${weights[0]} description=${weights[1]} body=${weights[2]})`);
	const results = subsets.map((subset) => evaluateSubset(index, subset.label, subset.cases, weights, mode, cache));
	printTable(results.map((result) => result.metrics));

	const totalUncached = results.reduce((sum, result) => sum + result.uncachedCount, 0);
	const hasUncached = mode === "condensed" && totalUncached > 0;
	if (hasUncached) {
		console.log(`Warning: ${totalUncached} case(s) had no condensed cache entry and fell back to the raw query. Run eval/condense-queries.ts first.`);
	}

	index.close();
}

main();
