import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capAtWordBoundary, scanRoots, summary } from "../src/catalog.ts";
import { loadConfig, type SkillSearchConfig } from "../src/config.ts";
import { indexDbPath, SkillIndex } from "../src/index-store.ts";
import { readSkill } from "../src/read.ts";
import { listSkills, search } from "../src/search.ts";
import { appendTelemetryEvent, type TelemetryEvent } from "../src/telemetry.ts";

const LIST_SUMMARY_CAP = 100;
const NONE_FIT_LINE = "None fit? skill_search with list: true (optionally area).";

let index: SkillIndex | undefined;
let currentConfig: SkillSearchConfig | undefined;
let readShaByName = new Map<string, string>();
let hasNotifiedTelemetryFailure = false;

const PI_BUILT_IN_COMMANDS = new Set([
	"settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "tree",
	"fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit", "mcp",
]);

function requireIndex(): SkillIndex {
	const isReady = index !== undefined;
	if (!isReady) {
		throw new Error("skill-search index is not ready: see the earlier startup error");
	}
	return index;
}

function openIndex(): void {
	const config = loadConfig();
	currentConfig = config;
	index = new SkillIndex(indexDbPath(config.cacheDir));
	index.update(config);
}

function logTelemetry(ctx: ExtensionContext, event: Omit<TelemetryEvent, "ts" | "sessionId">): void {
	const cacheDir = currentConfig?.cacheDir;
	if (cacheDir === undefined) {
		return;
	}
	try {
		appendTelemetryEvent(cacheDir, { sessionId: ctx.sessionManager.getSessionId(), ...event });
	} catch (error) {
		if (!hasNotifiedTelemetryFailure) {
			hasNotifiedTelemetryFailure = true;
			ctx.ui.notify(`skill-search: could not write telemetry: ${(error as Error).message}`, "warning");
		}
	}
}

function buildSkillCommandMessage(name: string, args: string): string {
	const text = readSkill(requireIndex(), name);
	const row = requireIndex().db.prepare("SELECT sha256 FROM skills WHERE name = ?").get(name) as { sha256: string };
	readShaByName.set(name, row.sha256);
	const request = args.trim();
	const hasRequest = request.length > 0;
	const requestText = hasRequest ? request : "(no request given: ask me what to do with this skill)";
	return `I invoked the skill \`${name}\`. Follow it.\n\n${text}\n\nMy request: ${requestText}`;
}

const commandSkillNames = new Set<string>();
const SKILL_COMMAND_PATTERN = /^(?:Task:\s*)?\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

type CommandSkill = { name: string; description: string };

function collectCommandSkills(): CommandSkill[] {
	const config = loadConfig();
	const { docs } = scanRoots(config.roots, config.exclude);
	const commandSkills = docs.filter((doc) => !PI_BUILT_IN_COMMANDS.has(doc.name));
	for (const doc of commandSkills) {
		commandSkillNames.add(doc.name);
	}
	return commandSkills.map((doc) => ({ name: doc.name, description: summary(doc.description) }));
}

function writePromptTemplates(commandSkills: CommandSkill[]): string[] {
	const promptDir = join(loadConfig().cacheDir, "prompts");
	rmSync(promptDir, { recursive: true, force: true });
	mkdirSync(promptDir, { recursive: true });
	return commandSkills.map((skill) => {
		const templatePath = join(promptDir, `${skill.name}.md`);
		const description = JSON.stringify(skill.description);
		const body = `Load the skill \`${skill.name}\` with skill_read and follow it. My request: \${@:-(none: ask me what to do)}`;
		writeFileSync(templatePath, `---\ndescription: ${description}\nargument-hint: "[request]"\n---\n${body}\n`);
		return templatePath;
	});
}

function expandSkillCommand(text: string, ctx: ExtensionContext): string | undefined {
	const match = SKILL_COMMAND_PATTERN.exec(text.trim());
	const isSkillCommand = match !== null && commandSkillNames.has(match[1]) && index !== undefined;
	if (!isSkillCommand) {
		return undefined;
	}
	const name = match[1];
	const request = (match[2] ?? "").trim();
	logTelemetry(ctx, { kind: "command", name, query: request.length > 0 ? request : undefined });
	return buildSkillCommandMessage(name, request);
}

export default function (pi: ExtensionAPI) {
	let commandSkills: CommandSkill[] = [];
	let commandSetupError: string | undefined;
	try {
		commandSkills = collectCommandSkills();
	} catch (error) {
		commandSetupError = (error as Error).message;
	}

	pi.on("resources_discover", () => {
		return { promptPaths: writePromptTemplates(commandSkills) };
	});

	pi.on("input", (event, ctx) => {
		const expanded = expandSkillCommand(event.text, ctx);
		const isExpanded = expanded !== undefined;
		if (isExpanded) {
			return { action: "transform", text: expanded };
		}
		return { action: "continue" };
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		readShaByName = new Map();
		const hasCommandSetupError = commandSetupError !== undefined;
		if (hasCommandSetupError) {
			ctx.ui.notify(`skill-search: no skill /commands: ${commandSetupError}`, "error");
		}
		try {
			openIndex();
		} catch (error) {
			ctx.ui.notify(`skill-search: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_compact", () => {
		readShaByName = new Map();
	});

	pi.on("session_shutdown", () => {
		index?.close();
		index = undefined;
	});

	pi.registerTool(
		defineTool({
			name: "skill_search",
			label: "Skill search",
			description:
				"Find a skill (a specialized, project-specific workflow) by a short description of the task. Use it for project procedures and complex tool workflows, not for ordinary conversation or general knowledge. Search with 2–6 words for one need; run separate searches for separate needs. Then load one result with skill_read. When no result fits, call it again with list: true (optionally area) to browse the full catalog.",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "2-6 words describing the task" })),
				limit: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
				list: Type.Optional(Type.Boolean({ description: "Return the full skill catalog instead of searching" })),
				area: Type.Optional(Type.String({ description: "With list: true, keep only names starting with or hyphen-matching this word" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				try {
					const activeIndex = requireIndex();
					if (params.list) {
						const entries = listSkills(activeIndex, params.area);
						logTelemetry(ctx, { kind: "list", area: params.area, results: entries.map((entry) => entry.name) });
						const hasNoEntries = entries.length === 0;
						if (hasNoEntries) {
							const areaText = params.area !== undefined ? ` matching area "${params.area}"` : "";
							return { content: [{ type: "text", text: `No skills${areaText}.` }], details: {} };
						}
						const lines = entries.map((entry) => `${entry.name} — ${capAtWordBoundary(entry.summary, LIST_SUMMARY_CAP)}`);
						return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
					}
					const hasQuery = params.query !== undefined && params.query.trim().length > 0;
					if (!hasQuery) {
						return { content: [{ type: "text", text: "Provide a query, or set list: true to browse the catalog." }], details: {}, isError: true };
					}
					const outcome = search(activeIndex, params.query as string, { limit: params.limit });
					logTelemetry(ctx, { kind: "search", query: params.query, results: outcome.results.map((result) => result.name), confidence: outcome.confidence });
					const isHighConfidence = outcome.confidence === "high";
					const suffix = isHighConfidence ? "" : `\n${NONE_FIT_LINE}`;
					const hasNoResults = outcome.results.length === 0;
					if (hasNoResults) {
						return { content: [{ type: "text", text: `No matching skill.${suffix}` }], details: { confidence: outcome.confidence } };
					}
					const lines = outcome.results.map((result) => `${result.name} — ${result.summary}`);
					const header = isHighConfidence ? "Best match:\n" : "";
					return { content: [{ type: "text", text: `${header}${lines.join("\n")}${suffix}` }], details: { confidence: outcome.confidence } };
				} catch (error) {
					return { content: [{ type: "text", text: (error as Error).message }], details: {}, isError: true };
				}
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "skill_read",
			label: "Skill read",
			description: "Load the full instructions of a skill by exact name. Read it before you follow the skill.",
			parameters: Type.Object({ name: Type.String({ description: "Exact skill name" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				try {
					logTelemetry(ctx, { kind: "read", name: params.name });
					const activeIndex = requireIndex();
					const row = activeIndex.db.prepare("SELECT sha256 FROM skills WHERE name = ?").get(params.name) as { sha256: string } | undefined;
					const isKnown = row !== undefined;
					const alreadyLoadedUnchanged = isKnown && readShaByName.get(params.name) === row.sha256;
					if (alreadyLoadedUnchanged) {
						return { content: [{ type: "text", text: "Already loaded earlier in this session (unchanged). Use the copy in your context." }], details: {} };
					}
					const text = readSkill(activeIndex, params.name);
					if (isKnown) {
						readShaByName.set(params.name, row.sha256);
					}
					return { content: [{ type: "text", text }], details: {} };
				} catch (error) {
					return { content: [{ type: "text", text: (error as Error).message }], details: {}, isError: true };
				}
			},
		}),
	);
}
