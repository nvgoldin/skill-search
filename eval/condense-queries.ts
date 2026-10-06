#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayComplete, loadDiskCache, readApiKey, runWithConcurrency, saveDiskCache } from "./gateway.ts";

type EvalCase = { query: string; expected: string[]; source: string };

export type CondenseCache = Record<string, string[]>;

const DATA_DIR = join(import.meta.dirname, "data");
export const CONDENSED_CACHE_PATH = join(DATA_DIR, "condensed.json");
const DATASET_FILES = ["claude-real.jsonl", "synthetic-pr391.jsonl"];
const CONCURRENCY = 4;

const PROMPT_PREFIX = [
	"You have a tool skill_search(query) that finds project-specific workflow skills by a 2-6 word description.",
	"Given the task below, reply with 1-3 search queries, one per line, nothing else.",
	"",
	"Task:",
].join("\n");

export function queryHash(query: string): string {
	return createHash("sha256").update(query).digest("hex");
}

function loadDataset(path: string): EvalCase[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as EvalCase);
}

export function loadCondensedCache(path: string = CONDENSED_CACHE_PATH): CondenseCache {
	const cacheExists = existsSync(path);
	if (!cacheExists) {
		return {};
	}
	return JSON.parse(readFileSync(path, "utf8")) as CondenseCache;
}

function loadCache(): CondenseCache {
	return loadDiskCache<string[]>(CONDENSED_CACHE_PATH);
}

function saveCache(cache: CondenseCache): void {
	saveDiskCache(CONDENSED_CACHE_PATH, cache);
}

function stripOuterQuotes(text: string): string {
	const isDoubleQuoted = text.startsWith('"') && text.endsWith('"');
	const isSingleQuoted = text.startsWith("'") && text.endsWith("'");
	return isDoubleQuoted || isSingleQuoted ? text.slice(1, -1) : text;
}

/** The model sometimes wraps a line as skill_search(...) or skill_search(query="...") despite the "nothing else" instruction. Unwrap it so the cache holds plain queries. */
function cleanCondensedLine(line: string): string {
	const toolCallMatch = line.match(/^skill_search\(\s*(?:query\s*=\s*)?(.*)\)$/i);
	const inner = toolCallMatch ? toolCallMatch[1].trim() : line;
	const withoutLeadingBullet = inner.replace(/^[-*\d.]+\s+/, "");
	return stripOuterQuotes(withoutLeadingBullet.trim()).trim();
}

function parseCondensedQueries(text: string): string[] {
	return text
		.split("\n")
		.map((line) => cleanCondensedLine(line.trim()))
		.filter((line) => line.length > 0)
		.slice(0, 3);
}

async function requestCondensedQueries(apiKey: string, task: string): Promise<string[]> {
	const reply = await gatewayComplete(apiKey, `${PROMPT_PREFIX} ${task}`, 200);
	return parseCondensedQueries(reply.text);
}

function cleanCache(): void {
	const cache = loadCache();
	for (const [hash, lines] of Object.entries(cache)) {
		cache[hash] = lines.map(cleanCondensedLine).filter((line) => line.length > 0);
	}
	saveCache(cache);
	console.log(`Cleaned ${Object.keys(cache).length} cached entries in place.`);
}

async function main(): Promise<void> {
	const runCleanOnly = process.argv.includes("--clean");
	if (runCleanOnly) {
		cleanCache();
		return;
	}

	const datasetFiles = DATASET_FILES.map((file) => join(DATA_DIR, file));
	const cases = datasetFiles.flatMap(loadDataset);
	const uniqueQueries = [...new Set(cases.map((evalCase) => evalCase.query))];

	const cache = loadCache();
	const queriesToFetch = uniqueQueries.filter((query) => cache[queryHash(query)] === undefined);
	console.log(`${uniqueQueries.length} unique queries, ${queriesToFetch.length} not cached yet`);

	const hasWork = queriesToFetch.length > 0;
	if (!hasWork) {
		console.log(`Nothing to do. Cache at ${CONDENSED_CACHE_PATH}`);
		return;
	}

	const apiKey = readApiKey();
	let completed = 0;
	let failed = 0;
	await runWithConcurrency(queriesToFetch, CONCURRENCY, async (query) => {
		try {
			const condensed = await requestCondensedQueries(apiKey, query);
			cache[queryHash(query)] = condensed;
			completed++;
		} catch (error) {
			failed++;
			console.error(`failed for query hash ${queryHash(query).slice(0, 8)}: ${(error as Error).message}`);
		}
		const isCheckpoint = (completed + failed) % 20 === 0;
		if (isCheckpoint) {
			saveCache(cache);
			console.log(`progress: ${completed + failed}/${queriesToFetch.length} (${failed} failed)`);
		}
	});

	saveCache(cache);
	console.log(`Done. ${completed} condensed, ${failed} failed. Cache at ${CONDENSED_CACHE_PATH}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
	main();
}
