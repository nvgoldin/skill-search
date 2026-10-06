import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_RETRIES = 5;

export type GatewayReply = { text: string; inputTokens: number; outputTokens: number };

export function requireEnv(name: string): string {
	const value = process.env[name];
	const isSet = value !== undefined && value.length > 0;
	if (!isSet) {
		throw new Error(`${name} is not set. Set it before running this eval script.`);
	}
	return value;
}

export function gatewayBaseUrl(): string {
	return requireEnv("EVAL_ANTHROPIC_BASE_URL");
}

export function gatewayModel(): string {
	return process.env.EVAL_MODEL ?? DEFAULT_MODEL;
}

export function readApiKey(): string {
	const directKey = process.env.EVAL_API_KEY;
	const hasDirectKey = directKey !== undefined && directKey.length > 0;
	if (hasDirectKey) {
		return directKey as string;
	}
	const command = process.env.EVAL_API_KEY_COMMAND;
	const hasCommand = command !== undefined && command.length > 0;
	if (!hasCommand) {
		throw new Error("Set EVAL_API_KEY to the gateway API key, or EVAL_API_KEY_COMMAND to a command that prints it on stdout.");
	}
	return execSync(command as string, { encoding: "utf8" }).trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function gatewayComplete(apiKey: string, prompt: string, maxTokens: number): Promise<GatewayReply> {
	const baseUrl = gatewayBaseUrl();
	const model = gatewayModel();
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const response = await fetch(baseUrl, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model,
				max_tokens: maxTokens,
				thinking: { type: "disabled" },
				messages: [{ role: "user", content: prompt }],
			}),
		});
		const isRetryable = response.status === 429 || response.status >= 500;
		if (isRetryable) {
			await sleep(500 * 2 ** attempt);
			continue;
		}
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`gateway error ${response.status}: ${body.slice(0, 300)}`);
		}
		const payload = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
			usage: { input_tokens: number; output_tokens: number };
		};
		const textBlock = payload.content.find((block) => block.type === "text");
		return {
			text: textBlock?.text ?? "",
			inputTokens: payload.usage.input_tokens,
			outputTokens: payload.usage.output_tokens,
		};
	}
	throw new Error(`gateway kept returning retryable errors after ${MAX_RETRIES} retries`);
}

export function hashKey(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export type DiskCache<T> = Record<string, T>;

export function loadDiskCache<T>(path: string): DiskCache<T> {
	const cacheExists = existsSync(path);
	if (!cacheExists) {
		return {};
	}
	return JSON.parse(readFileSync(path, "utf8")) as DiskCache<T>;
}

function sortedByKey<T>(cache: DiskCache<T>): DiskCache<T> {
	return Object.fromEntries(Object.keys(cache).sort().map((key) => [key, cache[key]]));
}

export function saveDiskCache<T>(path: string, cache: DiskCache<T>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sortedByKey(cache), null, 2)}\n`);
}

export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0;
	async function runNext(): Promise<void> {
		const index = nextIndex++;
		const hasMore = index < items.length;
		if (!hasMore) {
			return;
		}
		await worker(items[index]);
		await runNext();
	}
	const lanes = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
	await Promise.all(lanes);
}
