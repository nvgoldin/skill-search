#!/usr/bin/env node
import { loadConfig } from "../src/config.ts";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { readSkill } from "../src/read.ts";
import { search } from "../src/search.ts";

function printUsageAndExit(): void {
	console.error('usage: pi-skill index | search "<query>" [--limit N] [--json] | read <name>');
	process.exit(1);
}

function parseFlags(args: string[]): { positionals: string[]; limit?: number; json: boolean } {
	const positionals: string[] = [];
	let limit: number | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const isLimitFlag = arg === "--limit";
		if (isLimitFlag) {
			limit = Number(args[++i]);
			continue;
		}
		const isJsonFlag = arg === "--json";
		if (isJsonFlag) {
			json = true;
			continue;
		}
		positionals.push(arg);
	}
	return { positionals, limit, json };
}

function runIndex(): void {
	const config = loadConfig();
	const index = new SkillIndex(indexDbPath(config.cacheDir));
	const stats = index.update(config);
	index.close();
	console.log(JSON.stringify(stats, null, 2));
}

function runSearch(query: string, limit: number | undefined, json: boolean): void {
	const config = loadConfig();
	const index = new SkillIndex(indexDbPath(config.cacheDir));
	const outcome = search(index, query, { limit });
	index.close();
	if (json) {
		console.log(JSON.stringify(outcome, null, 2));
		return;
	}
	console.log(`confidence: ${outcome.confidence}`);
	for (const result of outcome.results) {
		console.log(`${result.name} — ${result.summary}`);
	}
}

function runRead(name: string): void {
	const config = loadConfig();
	const index = new SkillIndex(indexDbPath(config.cacheDir));
	const text = readSkill(index, name);
	index.close();
	console.log(text);
}

function main(): void {
	const [command, ...rest] = process.argv.slice(2);
	const hasCommand = typeof command === "string";
	if (!hasCommand) {
		printUsageAndExit();
		return;
	}
	if (command === "index") {
		runIndex();
		return;
	}
	const { positionals, limit, json } = parseFlags(rest);
	if (command === "search") {
		const query = positionals[0];
		const hasQuery = typeof query === "string" && query.length > 0;
		if (!hasQuery) {
			printUsageAndExit();
			return;
		}
		runSearch(query, limit, json);
		return;
	}
	if (command === "read") {
		const name = positionals[0];
		const hasName = typeof name === "string" && name.length > 0;
		if (!hasName) {
			printUsageAndExit();
			return;
		}
		runRead(name);
		return;
	}
	printUsageAndExit();
}

main();
