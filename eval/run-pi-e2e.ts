#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashKey, loadDiskCache, requireEnv, runWithConcurrency, saveDiskCache } from "./gateway.ts";

type EvalCase = { query: string; expected: string[]; source: string; nameInQuery?: boolean };
type DatasetCase = EvalCase & { dataset: string };

type SkillSearchCall = { query?: string; list?: boolean; area?: string };

type CaseResult = {
	finalAnswer?: string;
	searches: SkillSearchCall[];
	reads: string[];
	tokens: { input: number; cacheRead: number; cacheWrite: number };
	totalCost: number;
	error?: string;
};

type Variant = "extension" | "baseline";

const REPO_ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(import.meta.dirname, "data");
const CACHE_PATH = join(DATA_DIR, "pi-e2e-cache.json");
const EXTENSION_PATH = join(REPO_ROOT, "extension", "index.ts");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "skill-search.json");
const PROVIDER = requireEnv("EVAL_PI_PROVIDER");
const MODEL = requireEnv("EVAL_PI_MODEL");
const THINKING = "medium";

function baselineIndexPath(): string {
	return requireEnv("EVAL_BASELINE_INDEX");
}
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 10;
const PROCESS_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 50 * 1024 * 1024;
const MAX_MISS_LINES = 20;

function loadJsonl(path: string): EvalCase[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as EvalCase);
}

function loadCases(): DatasetCase[] {
	const claudeReal = loadJsonl(join(DATA_DIR, "claude-real-clean.jsonl"))
		.filter((evalCase) => !evalCase.nameInQuery)
		.map((evalCase) => ({ ...evalCase, dataset: "claude-real-clean nameInQuery=false" }));
	const synthetic = loadJsonl(join(DATA_DIR, "synthetic-pr391.jsonl")).map((evalCase) => ({ ...evalCase, dataset: "synthetic" }));
	return [...claudeReal, ...synthetic];
}

function listTsFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".ts"))
		.map((file) => join(dir, file));
}

function gitHead(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** `git rev-parse HEAD` plus a hash of the current `src/` and `extension/` file contents, so uncommitted edits also invalidate the cache. */
function extensionFingerprint(): string {
	const files = [...listTsFiles(join(REPO_ROOT, "src")), ...listTsFiles(join(REPO_ROOT, "extension"))].sort();
	const combined = files.map((file) => `${file}\u0000${readFileSync(file, "utf8")}`).join("\u0001");
	return hashKey(`${gitHead()}\u0000${hashKey(combined)}`);
}

function baselineFingerprint(): string {
	return hashKey(readFileSync(baselineIndexPath(), "utf8"));
}

function cacheKey(variant: Variant, fingerprint: string, query: string): string {
	return hashKey(`${variant}\u0000${fingerprint}\u0000${MODEL}\u0000${THINKING}\u0000${query}`);
}

function buildExtensionPrompt(query: string): string {
	return `Task from an engineer:\n${query}\n\nDo not do the task. Use the skill tools to find the one skill that fits it best, read it with skill_read to confirm, then reply with only the skill name.`;
}

function buildBaselinePrompt(query: string, indexText: string): string {
	return ["Here is an index of available skills.", "", indexText, "", "Pick the one skill from this index that fits it best. Reply with only the skill name.", "", "Task:", query].join("\n");
}

/** `spawn`, not `execFile`: `execFile` buffers output through its own pipes and deadlocks once the thinking/tool-call JSON exceeds the OS pipe buffer, because nothing drains it while it waits for exit. */
function runPi(args: string[], env: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill("SIGTERM");
			reject(new Error(`pi timed out after ${PROCESS_TIMEOUT_MS}ms`));
		}, PROCESS_TIMEOUT_MS);
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			const isOverBuffer = stdout.length > MAX_BUFFER;
			if (isOverBuffer) {
				settled = true;
				clearTimeout(timer);
				child.kill("SIGTERM");
				reject(new Error(`pi output exceeded ${MAX_BUFFER} bytes`));
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			const exitedCleanly = code === 0;
			if (exitedCleanly) {
				resolve(stdout);
				return;
			}
			reject(new Error(`pi exited with code ${code}: ${stderr.slice(0, 500)}`));
		});
	});
}

type AgentEndMessage = {
	role: string;
	content?: Array<{ type: string; name?: string; arguments?: Record<string, unknown>; text?: string }>;
	usage?: { input?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
};

function findLastAgentEndEvent(stdout: string): { messages: AgentEndMessage[] } | undefined {
	let lastAgentEnd: { messages: AgentEndMessage[] } | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		let event: { type?: string; messages?: AgentEndMessage[] };
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event.type === "agent_end" && event.messages !== undefined) {
			lastAgentEnd = { messages: event.messages };
		}
	}
	return lastAgentEnd;
}

function parsePiOutput(stdout: string): CaseResult {
	const agentEnd = findLastAgentEndEvent(stdout);
	const hasAgentEnd = agentEnd !== undefined;
	if (!hasAgentEnd) {
		throw new Error("no agent_end event in pi output");
	}
	const assistantMessages = agentEnd.messages.filter((message) => message.role === "assistant");
	const searches: SkillSearchCall[] = [];
	const reads: string[] = [];
	let totalCost = 0;
	let finalAnswer: string | undefined;
	for (const message of assistantMessages) {
		totalCost += message.usage?.cost?.total ?? 0;
		for (const item of message.content ?? []) {
			if (item.type === "toolCall" && item.name === "skill_search") {
				const args = item.arguments ?? {};
				searches.push({ query: args.query as string | undefined, list: args.list as boolean | undefined, area: args.area as string | undefined });
			}
			if (item.type === "toolCall" && item.name === "skill_read") {
				reads.push((item.arguments?.name as string | undefined) ?? "");
			}
			if (item.type === "text" && typeof item.text === "string") {
				finalAnswer = item.text;
			}
		}
	}
	const lastUsage = assistantMessages.at(-1)?.usage;
	return {
		finalAnswer: finalAnswer?.trim(),
		searches,
		reads,
		tokens: { input: lastUsage?.input ?? 0, cacheRead: lastUsage?.cacheRead ?? 0, cacheWrite: lastUsage?.cacheWrite ?? 0 },
		totalCost,
	};
}

async function runCaseUncached(variant: Variant, query: string, baselineIndexText: string): Promise<CaseResult> {
	const isExtension = variant === "extension";
	const prompt = isExtension ? buildExtensionPrompt(query) : buildBaselinePrompt(query, baselineIndexText);
	const commonArgs = ["--mode", "json", "--no-session", "-ne", "--provider", PROVIDER, "--model", MODEL, "--thinking", THINKING];
	const args = isExtension ? ["--mode", "json", "--no-session", "-ne", "-e", EXTENSION_PATH, "--provider", PROVIDER, "--model", MODEL, "--thinking", THINKING, prompt] : [...commonArgs, prompt];
	const env = isExtension ? { SKILL_SEARCH_CONFIG: CONFIG_PATH, SKILL_SEARCH_NO_TELEMETRY: "1" } : {};
	const stdout = await runPi(args, env);
	return parsePiOutput(stdout);
}

async function runCaseWithRetry(variant: Variant, query: string, baselineIndexText: string): Promise<CaseResult> {
	try {
		return await runCaseUncached(variant, query, baselineIndexText);
	} catch (firstError) {
		try {
			return await runCaseUncached(variant, query, baselineIndexText);
		} catch (secondError) {
			return { searches: [], reads: [], tokens: { input: 0, cacheRead: 0, cacheWrite: 0 }, totalCost: 0, error: (secondError as Error).message };
		}
	}
}

type DatasetMetrics = {
	label: string;
	cases: number;
	scored: number;
	accuracy: number;
	hitRate: number;
	meanSearches: number;
	listShare: number;
	meanTokens: number;
	totalCost: number;
};

/** Strips cosmetic markdown emphasis (`**bold**`, `` `code` ``) around an otherwise-bare name; does not touch sentence text, so a verbose non-compliant answer still fails the match. */
function normalizeAnswer(answer: string): string {
	return answer.replace(/[`*]/g, "").trim();
}

function matchesExpected(expected: string[], answer: string | undefined): boolean {
	const isMissing = answer === undefined || answer.length === 0;
	if (isMissing) {
		return false;
	}
	const lowerAnswer = normalizeAnswer(answer).toLowerCase();
	return expected.some((name) => name.toLowerCase() === lowerAnswer);
}

function hitAnyRead(expected: string[], reads: string[]): boolean {
	const lowerExpected = new Set(expected.map((name) => name.toLowerCase()));
	return reads.some((name) => lowerExpected.has(name.toLowerCase()));
}

function computeMetrics(label: string, datasetCases: DatasetCase[], variant: Variant, fingerprint: string, cache: Record<string, CaseResult>): DatasetMetrics {
	let correct = 0;
	let hit = 0;
	let searchSum = 0;
	let listUsed = 0;
	let tokenSum = 0;
	let costSum = 0;
	let scored = 0;
	for (const evalCase of datasetCases) {
		const result = cache[cacheKey(variant, fingerprint, evalCase.query)];
		const isUsable = result !== undefined && result.error === undefined;
		if (!isUsable) {
			continue;
		}
		scored++;
		costSum += result.totalCost;
		tokenSum += result.tokens.input + result.tokens.cacheRead + result.tokens.cacheWrite;
		searchSum += result.searches.length;
		const usedList = result.searches.some((call) => call.list === true);
		if (usedList) {
			listUsed++;
		}
		if (matchesExpected(evalCase.expected, result.finalAnswer)) {
			correct++;
		}
		if (hitAnyRead(evalCase.expected, result.reads)) {
			hit++;
		}
	}
	return {
		label,
		cases: datasetCases.length,
		scored,
		accuracy: scored > 0 ? correct / scored : 0,
		hitRate: scored > 0 ? hit / scored : 0,
		meanSearches: scored > 0 ? searchSum / scored : 0,
		listShare: scored > 0 ? listUsed / scored : 0,
		meanTokens: scored > 0 ? tokenSum / scored : 0,
		totalCost: costSum,
	};
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function printTable(rows: DatasetMetrics[]): void {
	const headers = ["dataset", "cases", "scored", "accuracy", "hit", "mean searches", "list share", "mean tokens", "cost"];
	const lines = rows.map((row) => [
		row.label,
		String(row.cases),
		String(row.scored),
		formatPercent(row.accuracy),
		formatPercent(row.hitRate),
		row.meanSearches.toFixed(2),
		formatPercent(row.listShare),
		row.meanTokens.toFixed(0),
		`$${row.totalCost.toFixed(4)}`,
	]);
	const widths = headers.map((header, column) => Math.max(header.length, ...lines.map((line) => line[column].length)));
	const renderRow = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
	console.log(renderRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const line of lines) {
		console.log(renderRow(line));
	}
}

function printMisses(datasetCases: DatasetCase[], variant: Variant, fingerprint: string, cache: Record<string, CaseResult>): void {
	const misses = datasetCases.filter((evalCase) => {
		const result = cache[cacheKey(variant, fingerprint, evalCase.query)];
		const isUsable = result !== undefined && result.error === undefined;
		return isUsable && !matchesExpected(evalCase.expected, result.finalAnswer);
	});
	console.log(`\n${misses.length} miss(es) out of ${datasetCases.length} scorable cases, showing up to ${MAX_MISS_LINES}:`);
	for (const evalCase of misses.slice(0, MAX_MISS_LINES)) {
		const result = cache[cacheKey(variant, fingerprint, evalCase.query)];
		console.log(`expected=${evalCase.expected.join(",")}  got=${result.finalAnswer ?? "(none)"}  query=${evalCase.query.slice(0, 70).replace(/\n/g, " ")}`);
	}
}

async function main(): Promise<void> {
	const useBaseline = process.argv.includes("--baseline-index");
	const variant: Variant = useBaseline ? "baseline" : "extension";
	const cases = loadCases();
	const cache = loadDiskCache<CaseResult>(CACHE_PATH);
	const fingerprint = variant === "extension" ? extensionFingerprint() : baselineFingerprint();
	const baselineIndexText = variant === "baseline" ? readFileSync(baselineIndexPath(), "utf8") : "";

	const uniqueQueries = [...new Set(cases.map((evalCase) => evalCase.query))];
	const toRun = uniqueQueries.filter((query) => cache[cacheKey(variant, fingerprint, query)] === undefined);
	console.log(`variant=${variant}  model=${MODEL}:${THINKING}  cases=${cases.length}  unique queries=${uniqueQueries.length}  to run=${toRun.length}`);

	let done = 0;
	let failed = 0;
	await runWithConcurrency(toRun, CONCURRENCY, async (query) => {
		const result = await runCaseWithRetry(variant, query, baselineIndexText);
		cache[cacheKey(variant, fingerprint, query)] = result;
		done++;
		if (result.error !== undefined) {
			failed++;
			console.error(`case failed after retry: ${result.error.slice(0, 200)}`);
		}
		const isCheckpoint = done % CHECKPOINT_EVERY === 0;
		if (isCheckpoint) {
			saveDiskCache(CACHE_PATH, cache);
			console.log(`progress: ${done}/${toRun.length} (${failed} failed)`);
		}
	});
	saveDiskCache(CACHE_PATH, cache);

	const datasetLabels = [...new Set(cases.map((evalCase) => evalCase.dataset))];
	const rows = datasetLabels.map((label) => computeMetrics(label, cases.filter((evalCase) => evalCase.dataset === label), variant, fingerprint, cache));
	printTable(rows);

	for (const label of datasetLabels) {
		printMisses(cases.filter((evalCase) => evalCase.dataset === label), variant, fingerprint, cache);
	}
}

main();
