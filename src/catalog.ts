import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type SkillDoc = {
	name: string;
	description: string;
	body: string;
	path: string;
	dir: string;
	sha256: string;
	mtimeMs: number;
	size: number;
};

export type CatalogScan = {
	docs: SkillDoc[];
	collisions: string[];
};

const SUMMARY_CAP = 160;
const SHORT_SENTENCE_CHARS = 60;

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const lines = content.split("\n");
	const startsWithFrontmatter = lines[0]?.trim() === "---";
	if (!startsWithFrontmatter) {
		return { frontmatter: "", body: content };
	}
	const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
	const hasEnd = endIndex !== -1;
	if (!hasEnd) {
		return { frontmatter: "", body: content };
	}
	const frontmatter = lines.slice(1, endIndex + 1).join("\n");
	const body = lines.slice(endIndex + 2).join("\n");
	return { frontmatter, body };
}

function tryParseYaml(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = parseYaml(text);
		const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
		return isPlainObject ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function stripQuotes(value: string): string {
	const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
	const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
	return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

function parseKeyValueLines(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const line of text.split("\n")) {
		const colonIndex = line.indexOf(":");
		const hasKey = colonIndex > 0;
		if (hasKey) {
			const key = line.slice(0, colonIndex).trim();
			const value = stripQuotes(line.slice(colonIndex + 1).trim());
			result[key] = value;
		}
	}
	return result;
}

function parseFrontmatter(text: string): Record<string, unknown> {
	const parsedYaml = tryParseYaml(text);
	return parsedYaml ?? parseKeyValueLines(text);
}

function splitSentences(text: string): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	const matches = normalized.match(/[^.!?]+[.!?]*/g);
	return matches ? matches.map((sentence) => sentence.trim()).filter(Boolean) : [normalized];
}

export function capAtWordBoundary(text: string, maxLength: number): string {
	const fitsAlready = text.length <= maxLength;
	if (fitsAlready) {
		return text;
	}
	const truncated = text.slice(0, maxLength - 1);
	const lastSpace = truncated.lastIndexOf(" ");
	const hasWordBoundary = lastSpace > 0;
	const cut = hasWordBoundary ? truncated.slice(0, lastSpace) : truncated;
	return `${cut}…`;
}

export function summary(description: string): string {
	const sentences = splitSentences(description);
	const firstSentence = sentences[0] ?? "";
	const firstSentenceIsShort = firstSentence.length < SHORT_SENTENCE_CHARS;
	const hasSecondSentence = sentences.length > 1;
	const base = firstSentenceIsShort && hasSecondSentence ? `${firstSentence} ${sentences[1]}` : firstSentence;
	return capAtWordBoundary(base.trim(), SUMMARY_CAP);
}

function loadSkillDoc(path: string, folderName: string): SkillDoc | undefined {
	const content = readFileSync(path, "utf8");
	const stats = statSync(path);
	const { frontmatter, body } = splitFrontmatter(content);
	const parsed = parseFrontmatter(frontmatter);
	const nameFromFrontmatter = typeof parsed.name === "string" ? parsed.name.trim() : "";
	const name = nameFromFrontmatter.length > 0 ? nameFromFrontmatter : folderName;
	const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
	const hasDescription = description.length > 0;
	if (!hasDescription) {
		return undefined;
	}
	return {
		name,
		description,
		body: body.trim(),
		path,
		dir: dirname(path),
		sha256: createHash("sha256").update(content).digest("hex"),
		mtimeMs: stats.mtimeMs,
		size: stats.size,
	};
}

function listSkillDirs(root: string): string[] {
	const rootExists = existsSync(root);
	if (!rootExists) {
		return [];
	}
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

export function scanRoots(roots: string[], exclude: string[]): CatalogScan {
	const excludeSet = new Set(exclude);
	const docsByName = new Map<string, SkillDoc>();
	const collisions: string[] = [];
	for (const root of roots) {
		for (const folderName of listSkillDirs(root)) {
			const skillPath = join(root, folderName, "SKILL.md");
			const hasSkillFile = existsSync(skillPath);
			if (!hasSkillFile) {
				continue;
			}
			const doc = loadSkillDoc(skillPath, folderName);
			const skipped = doc === undefined;
			if (skipped) {
				continue;
			}
			const isExcluded = excludeSet.has(doc.name);
			if (isExcluded) {
				continue;
			}
			const isCollision = docsByName.has(doc.name);
			if (isCollision) {
				collisions.push(doc.name);
				continue;
			}
			docsByName.set(doc.name, doc);
		}
	}
	return { docs: [...docsByName.values()], collisions };
}
