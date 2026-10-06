import { readFileSync } from "node:fs";
import type { SkillIndex } from "./index-store.ts";
import { search } from "./search.ts";

export function readSkill(index: SkillIndex, name: string): string {
	const row = index.db.prepare("SELECT path, dir FROM skills WHERE name = ?").get(name) as { path: string; dir: string } | undefined;
	const isKnown = row !== undefined;
	if (!isKnown) {
		const closestNames = search(index, name, { limit: 3 }).results.map((result) => result.name);
		const suggestion = closestNames.length > 0 ? ` Closest names: ${closestNames.join(", ")}.` : "";
		throw new Error(`Unknown skill: ${name}.${suggestion}`);
	}
	const content = readFileSync(row.path, "utf8");
	return `Skill: ${name}\nDirectory: ${row.dir}\n\n${content}`;
}
