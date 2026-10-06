import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type TelemetryKind = "search" | "list" | "read" | "command";

export type TelemetryEvent = {
	ts: number;
	sessionId: string;
	kind: TelemetryKind;
	query?: string;
	area?: string;
	results?: string[];
	confidence?: string;
	name?: string;
};

export function telemetryPath(cacheDir: string): string {
	return join(cacheDir, "telemetry.jsonl");
}

function isDisabled(): boolean {
	return process.env.SKILL_SEARCH_NO_TELEMETRY === "1";
}

/** Appends one JSON line. Throws on a write failure; the caller decides how to surface it. Does nothing when `SKILL_SEARCH_NO_TELEMETRY=1`. */
export function appendTelemetryEvent(cacheDir: string, event: Omit<TelemetryEvent, "ts">): void {
	if (isDisabled()) {
		return;
	}
	const line = JSON.stringify({ ts: Date.now(), ...event });
	mkdirSync(cacheDir, { recursive: true });
	appendFileSync(telemetryPath(cacheDir), `${line}\n`);
}
