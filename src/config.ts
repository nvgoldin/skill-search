import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type SkillSearchConfig = {
	roots: string[];
	exclude: string[];
	cacheDir: string;
};

function expandHome(path: string): string {
	const startsWithHome = path === "~" || path.startsWith("~/");
	if (startsWithHome) {
		return join(homedir(), path.slice(1));
	}
	return path;
}

function resolvePath(path: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

function defaultConfigPath(): string {
	return join(homedir(), ".pi", "agent", "skill-search.json");
}

export function configPath(): string {
	return process.env.SKILL_SEARCH_CONFIG ?? defaultConfigPath();
}

export function loadConfig(path: string = configPath()): SkillSearchConfig {
	const hasConfigFile = existsSync(path);
	if (!hasConfigFile) {
		throw new Error(`skill-search config not found: ${path}`);
	}
	const raw = JSON.parse(readFileSync(path, "utf8"));
	const roots = Array.isArray(raw.roots) ? raw.roots : [];
	const hasRoots = roots.length > 0;
	if (!hasRoots) {
		throw new Error(`skill-search config at ${path} has no roots`);
	}
	const exclude = Array.isArray(raw.exclude) ? raw.exclude : [];
	const hasCacheDir = typeof raw.cacheDir === "string" && raw.cacheDir.length > 0;
	if (!hasCacheDir) {
		throw new Error(`skill-search config at ${path} has no cacheDir`);
	}
	return {
		roots: roots.map(resolvePath),
		exclude,
		cacheDir: resolvePath(raw.cacheDir),
	};
}
