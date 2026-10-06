#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatewayComplete, hashKey, loadDiskCache, readApiKey, requireEnv, runWithConcurrency, saveDiskCache } from "./gateway.ts";

type EvalCase = Record<string, unknown> & { query: string; expected: string[] };
type TaggedCase = EvalCase & { file: string };
type CacheEntry = { names: string[]; inputTokens: number; outputTokens: number };

const DATA_DIR = join(import.meta.dirname, "data");
const CACHE_PATH = join(DATA_DIR, "baseline-index-cache.json");
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 20;

type SubsetDef = { label: string; file: string; filter?: (evalCase: TaggedCase) => boolean };

const SUBSETS: SubsetDef[] = [
	{ label: "claude-real-clean nameInQuery=false", file: "claude-real-clean.jsonl", filter: (c) => !c.nameInQuery },
	{ label: "claude-real-clean nameInQuery=true", file: "claude-real-clean.jsonl", filter: (c) => Boolean(c.nameInQuery) },
	{ label: "synthetic", file: "synthetic-pr391.jsonl" },
];

function loadDataset(path: string): TaggedCase[] {
	const file = path.split("/").pop() as string;
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => ({ ...(JSON.parse(line) as EvalCase), file }));
}

function buildPrompt(indexText: string, query: string): string {
	return [
		"Here is an index of available skills.",
		"",
		indexText,
		"",
		"Given the task below, reply with the 3 best skill names from the index above, one per line, nothing else.",
		"",
		"Task:",
		query,
	].join("\n");
}

function cleanSkillNameLine(line: string): string {
	return line
		.trim()
		.replace(/^[-*\d.]+\s*/, "")
		.replace(/`/g, "")
		.trim();
}

function parseSkillNames(text: string): string[] {
	return text
		.split("\n")
		.map(cleanSkillNameLine)
		.filter((line) => line.length > 0)
		.slice(0, 3);
}

async function lookupCase(apiKey: string, indexText: string, query: string, cache: Record<string, CacheEntry>): Promise<CacheEntry> {
	const key = hashKey(`${hashKey(indexText)}\u0000${query}`);
	const cached = cache[key];
	if (cached !== undefined) {
		return cached;
	}
	const reply = await gatewayComplete(apiKey, buildPrompt(indexText, query), 60);
	const entry: CacheEntry = { names: parseSkillNames(reply.text), inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
	cache[key] = entry;
	return entry;
}

type SubsetMetrics = { label: string; cases: number; hitAt1: number; hitAt3: number; meanInputTokens: number };

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function printTable(rows: SubsetMetrics[]): void {
	const headers = ["subset", "cases", "Hit@1", "Hit@3", "mean input tokens/lookup"];
	const lines = rows.map((row) => [row.label, String(row.cases), formatPercent(row.hitAt1), formatPercent(row.hitAt3), row.meanInputTokens.toFixed(0)]);
	const widths = headers.map((header, column) => Math.max(header.length, ...lines.map((line) => line[column].length)));
	const renderRow = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
	console.log(renderRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const line of lines) {
		console.log(renderRow(line));
	}
}

async function main(): Promise<void> {
	const indexPath = requireEnv("EVAL_BASELINE_INDEX");
	const indexText = readFileSync(indexPath, "utf8");
	const datasetFiles = [...new Set(SUBSETS.map((subset) => subset.file))];
	const casesByFile = new Map(datasetFiles.map((file) => [file, loadDataset(join(DATA_DIR, file))]));

	const cache = loadDiskCache<CacheEntry>(CACHE_PATH);
	const apiKey = readApiKey();

	const allCases = [...casesByFile.values()].flat();
	const uniqueQueries = [...new Set(allCases.map((evalCase) => evalCase.query))];
	const queriesToFetch = uniqueQueries.filter((query) => cache[hashKey(`${hashKey(indexText)}\u0000${query}`)] === undefined);
	console.log(`${uniqueQueries.length} unique queries across subsets, ${queriesToFetch.length} not cached yet`);

	let processed = 0;
	let failed = 0;
	await runWithConcurrency(queriesToFetch, CONCURRENCY, async (query) => {
		try {
			await lookupCase(apiKey, indexText, query, cache);
			processed++;
		} catch (error) {
			failed++;
			console.error(`lookup failed: ${(error as Error).message}`);
		}
		const isCheckpoint = (processed + failed) % CHECKPOINT_EVERY === 0;
		if (isCheckpoint) {
			saveDiskCache(CACHE_PATH, cache);
			console.log(`progress: ${processed + failed}/${queriesToFetch.length} (${failed} failed)`);
		}
	});
	saveDiskCache(CACHE_PATH, cache);

	const results: SubsetMetrics[] = [];
	for (const subset of SUBSETS) {
		const allSubsetCases = casesByFile.get(subset.file) ?? [];
		const cases = subset.filter ? allSubsetCases.filter(subset.filter) : allSubsetCases;
		let hitAt1 = 0;
		let hitAt3 = 0;
		let tokenSum = 0;
		let scored = 0;
		for (const evalCase of cases) {
			const key = hashKey(`${hashKey(indexText)}\u0000${evalCase.query}`);
			const entry = cache[key];
			const hasEntry = entry !== undefined;
			if (!hasEntry) {
				continue;
			}
			scored++;
			tokenSum += entry.inputTokens;
			const expectedSet = new Set(evalCase.expected);
			if (expectedSet.has(entry.names[0])) {
				hitAt1++;
			}
			if (entry.names.some((name) => expectedSet.has(name))) {
				hitAt3++;
			}
		}
		results.push({
			label: subset.label,
			cases: cases.length,
			hitAt1: cases.length > 0 ? hitAt1 / cases.length : 0,
			hitAt3: cases.length > 0 ? hitAt3 / cases.length : 0,
			meanInputTokens: scored > 0 ? tokenSum / scored : 0,
		});
	}

	console.log(`\nindex file: ${indexPath} (${indexText.length} chars, ~${Math.round(indexText.length / 4)} tokens)`);
	printTable(results);
}

main();
