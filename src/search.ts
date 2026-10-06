import type { SkillIndex } from "./index-store.ts";

export const HIGH_RATIO = 2.0;
export const AMBIGUOUS_RATIO = 0.75;

const RETRIEVE_LIMIT = 20;

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"to",
	"of",
	"for",
	"and",
	"or",
	"in",
	"on",
	"with",
	"is",
	"how",
	"do",
	"does",
	"i",
	"my",
	"me",
	"it",
	"this",
	"that",
]);

export type SearchWeights = [name: number, description: number, body: number];

export const DEFAULT_WEIGHTS: SearchWeights = [3.0, 2.0, 0.5];

export type SearchOptions = {
	limit?: number;
	weights?: SearchWeights;
};

export type SearchResult = { name: string; summary: string };

export type Confidence = "high" | "normal" | "ambiguous";

export type SearchOutcome = {
	results: SearchResult[];
	confidence: Confidence;
};

export type ScoredSkill = { name: string; summary: string; score: number };

const SHORT_NAME_CHARS = 4;

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function buildMatchExpression(tokens: string[]): string {
	return tokens.map((token) => `"${token}"`).join(" OR ");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeToken(lowerQuery: string, token: string): boolean {
	const pattern = new RegExp(`(?<![a-z0-9-])${escapeRegExp(token)}(?![a-z0-9-])`);
	return pattern.test(lowerQuery);
}

function containsSlashForm(lowerQuery: string, name: string): boolean {
	const pattern = new RegExp(`(?<![a-z0-9])/${escapeRegExp(name)}(?![a-z0-9-])`);
	return pattern.test(lowerQuery);
}

/** A name counts when the query has it as a whole word (hyphen or space form), or as "/name". Short names (under 4 chars) count only in the "/name" form. */
function queryMatchesName(lowerQuery: string, name: string): boolean {
	const lowerName = name.toLowerCase();
	const matchesSlashForm = containsSlashForm(lowerQuery, lowerName);
	const isShortName = lowerName.length < SHORT_NAME_CHARS;
	if (isShortName) {
		return matchesSlashForm;
	}
	const spaceForm = lowerName.replace(/[-_]/g, " ");
	const matchesHyphenForm = containsWholeToken(lowerQuery, lowerName);
	const matchesSpaceForm = spaceForm !== lowerName && containsWholeToken(lowerQuery, spaceForm);
	return matchesSlashForm || matchesHyphenForm || matchesSpaceForm;
}

/** Every matching skill name, longest first. Checked against every indexed name, not only the FTS top 20. */
function findMatchingNames(query: string, allNames: string[]): string[] {
	const lowerQuery = query.toLowerCase();
	return allNames
		.filter((name) => queryMatchesName(lowerQuery, name))
		.sort((left, right) => right.length - left.length);
}

function loadAllNames(index: SkillIndex): string[] {
	const rows = index.db.prepare("SELECT name FROM skills").all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

/** An area matches a skill name when the name starts with it, or has it as one of its hyphen-separated words. */
export function matchesArea(name: string, area: string): boolean {
	const lowerName = name.toLowerCase();
	const lowerArea = area.toLowerCase();
	const isHyphenWord = lowerName.split("-").includes(lowerArea);
	return lowerName.startsWith(lowerArea) || isHyphenWord;
}

/** The full catalog, alphabetical by name, optionally narrowed to one area. */
export function listSkills(index: SkillIndex, area?: string): SearchResult[] {
	const rows = index.db.prepare("SELECT name, summary FROM skills ORDER BY name").all() as SearchResult[];
	const trimmedArea = area?.trim();
	const hasArea = trimmedArea !== undefined && trimmedArea.length > 0;
	if (!hasArea) {
		return rows;
	}
	return rows.filter((row) => matchesArea(row.name, trimmedArea));
}

function loadSummary(index: SkillIndex, name: string): string {
	const row = index.db.prepare("SELECT summary FROM skills WHERE name = ?").get(name) as { summary: string } | undefined;
	return row?.summary ?? "";
}

function promoteMatchedNames(index: SkillIndex, matchedNames: string[], ftsScored: ScoredSkill[]): ScoredSkill[] {
	const ftsByName = new Map(ftsScored.map((row) => [row.name, row]));
	const topScore = ftsScored[0]?.score ?? 0;
	return matchedNames.map((name, position) => {
		const score = topScore + (matchedNames.length - position);
		const existing = ftsByName.get(name);
		if (existing !== undefined) {
			return { ...existing, score };
		}
		return { name, summary: loadSummary(index, name), score };
	});
}

function confidenceResultCount(confidence: Confidence): number {
	if (confidence === "high") {
		return 1;
	}
	if (confidence === "ambiguous") {
		return 5;
	}
	return 3;
}

function classifyConfidence(scored: ScoredSkill[], hasExactMatch: boolean): Confidence {
	const top1 = scored[0]?.score;
	const top2 = scored[1]?.score;
	const top3 = scored[2]?.score;
	const topFarAheadOfSecond = top1 !== undefined && top2 !== undefined && top1 >= HIGH_RATIO * top2;
	const isHigh = hasExactMatch || topFarAheadOfSecond;
	if (isHigh) {
		return "high";
	}
	const thirdCloseToFirst = top1 !== undefined && top3 !== undefined && top3 >= AMBIGUOUS_RATIO * top1;
	if (thirdCloseToFirst) {
		return "ambiguous";
	}
	return "normal";
}

/** The top 20 skills for a query, ranked best first, with every exact-name match promoted to the top, longest name first. */
export function rankTopSkills(index: SkillIndex, query: string, weights: SearchWeights = DEFAULT_WEIGHTS): { scored: ScoredSkill[]; hasExactMatch: boolean } {
	const matchedNames = findMatchingNames(query, loadAllNames(index));
	const hasExactMatch = matchedNames.length > 0;

	const tokens = tokenize(query);
	const hasTokens = tokens.length > 0;
	if (!hasTokens) {
		const scored = hasExactMatch ? promoteMatchedNames(index, matchedNames, []) : [];
		return { scored, hasExactMatch };
	}

	const [nameWeight, descriptionWeight, bodyWeight] = weights;
	const matchExpression = buildMatchExpression(tokens);
	const rows = index.db
		.prepare(
			`SELECT s.name as name, s.summary as summary, bm25(skills_fts, ?, ?, ?) as rank
			 FROM skills_fts
			 JOIN skills s ON s.rowid = skills_fts.rowid
			 WHERE skills_fts MATCH ?
			 ORDER BY rank
			 LIMIT ${RETRIEVE_LIMIT}`,
		)
		.all(nameWeight, descriptionWeight, bodyWeight, matchExpression) as Array<{ name: string; summary: string; rank: number }>;

	const ftsScored: ScoredSkill[] = rows.map((row) => ({ name: row.name, summary: row.summary, score: -row.rank }));
	const matchedSet = new Set(matchedNames);
	const remaining = ftsScored.filter((row) => !matchedSet.has(row.name));
	const promoted = promoteMatchedNames(index, matchedNames, ftsScored);
	return { scored: [...promoted, ...remaining], hasExactMatch };
}

export function search(index: SkillIndex, query: string, options: SearchOptions = {}): SearchOutcome {
	const { scored, hasExactMatch } = rankTopSkills(index, query, options.weights ?? DEFAULT_WEIGHTS);
	const hasNoMatches = scored.length === 0;
	if (hasNoMatches) {
		return { results: [], confidence: "normal" };
	}

	const confidence = classifyConfidence(scored, hasExactMatch);
	const limit = options.limit ?? confidenceResultCount(confidence);
	return {
		results: scored.slice(0, limit).map((row) => ({ name: row.name, summary: row.summary })),
		confidence,
	};
}
