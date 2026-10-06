import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanRoots, summary, type SkillDoc } from "./catalog.ts";
import type { SkillSearchConfig } from "./config.ts";

export type IndexStats = {
	total: number;
	added: number;
	updated: number;
	removed: number;
	unchanged: number;
	collisions: string[];
	ms: number;
};

type ExistingRow = { rowid: number; name: string; sha256: string; mtime_ms: number; size: number };

export function indexDbPath(cacheDir: string): string {
	return join(cacheDir, "index.sqlite");
}

function ftsName(name: string): string {
	const spaced = name.replace(/[-_]/g, " ");
	return `${spaced} ${name}`;
}

export class SkillIndex {
	readonly db: DatabaseSync;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS skills (
				name TEXT PRIMARY KEY,
				path TEXT NOT NULL,
				dir TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				mtime_ms REAL NOT NULL,
				size INTEGER NOT NULL,
				description TEXT NOT NULL,
				summary TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
				name, description, body,
				tokenize = "porter unicode61"
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	private insertFts(rowid: number, doc: SkillDoc): void {
		this.db.prepare("INSERT INTO skills_fts (rowid, name, description, body) VALUES (?, ?, ?, ?)").run(rowid, ftsName(doc.name), doc.description, doc.body);
	}

	private insertSkill(doc: SkillDoc): void {
		this.db
			.prepare(
				"INSERT INTO skills (name, path, dir, sha256, mtime_ms, size, description, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(doc.name, doc.path, doc.dir, doc.sha256, doc.mtimeMs, doc.size, doc.description, summary(doc.description));
		const row = this.db.prepare("SELECT rowid FROM skills WHERE name = ?").get(doc.name) as { rowid: number };
		this.insertFts(row.rowid, doc);
	}

	private replaceSkill(doc: SkillDoc, rowid: number): void {
		this.db
			.prepare(
				"UPDATE skills SET path = ?, dir = ?, sha256 = ?, mtime_ms = ?, size = ?, description = ?, summary = ? WHERE rowid = ?",
			)
			.run(doc.path, doc.dir, doc.sha256, doc.mtimeMs, doc.size, doc.description, summary(doc.description), rowid);
		this.db.prepare("DELETE FROM skills_fts WHERE rowid = ?").run(rowid);
		this.insertFts(rowid, doc);
	}

	private touchSkill(doc: SkillDoc): void {
		this.db.prepare("UPDATE skills SET path = ?, dir = ?, mtime_ms = ?, size = ? WHERE name = ?").run(doc.path, doc.dir, doc.mtimeMs, doc.size, doc.name);
	}

	private deleteSkill(rowid: number): void {
		this.db.prepare("DELETE FROM skills_fts WHERE rowid = ?").run(rowid);
		this.db.prepare("DELETE FROM skills WHERE rowid = ?").run(rowid);
	}

	update(config: SkillSearchConfig): IndexStats {
		const start = performance.now();
		const { docs, collisions } = scanRoots(config.roots, config.exclude);
		const existingRows = this.db.prepare("SELECT rowid, name, sha256, mtime_ms, size FROM skills").all() as ExistingRow[];
		const existingByName = new Map(existingRows.map((row) => [row.name, row]));
		const currentNames = new Set(docs.map((doc) => doc.name));
		const removedRows = existingRows.filter((row) => !currentNames.has(row.name));

		let added = 0;
		let updated = 0;
		let unchanged = 0;

		this.db.exec("BEGIN");
		try {
			for (const doc of docs) {
				const existing = existingByName.get(doc.name);
				const isNew = existing === undefined;
				if (isNew) {
					this.insertSkill(doc);
					added++;
					continue;
				}
				const metadataMatches = existing.mtime_ms === doc.mtimeMs && existing.size === doc.size;
				if (metadataMatches) {
					unchanged++;
					continue;
				}
				const contentUnchanged = existing.sha256 === doc.sha256;
				if (contentUnchanged) {
					this.touchSkill(doc);
					unchanged++;
					continue;
				}
				this.replaceSkill(doc, existing.rowid);
				updated++;
			}
			for (const row of removedRows) {
				this.deleteSkill(row.rowid);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}

		const total = this.db.prepare("SELECT COUNT(*) as count FROM skills").get() as { count: number };
		return {
			total: total.count,
			added,
			updated,
			removed: removedRows.length,
			unchanged,
			collisions,
			ms: performance.now() - start,
		};
	}
}
