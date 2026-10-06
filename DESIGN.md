# skill-search — design

A reusable Pi package that replaces the model-facing skill catalog with a local index and two tools.
No LLM calls, no network, no daemon in the retrieval path.

## Goals, in order

1. Correctness: the right skill is in the results (target Hit@3 > 98% on the eval set).
2. Near-zero recurring tokens: no skill names or descriptions in the system prompt.
3. No LLM calls for retrieval.
4. Low complexity: Node 24 built-ins only (`node:sqlite` with FTS5, `node:crypto`, `node:fs`). Only allowed npm dependency: `yaml`.
5. Fast: index build < 1 s for 200 skills; search < 20 ms.

## Layout

```text
package.json          name "pi-skill-search", "type": "module", "pi": {"extensions": ["./extension/index.ts"]},
                      "bin": {"pi-skill": "./bin/pi-skill.ts"}, dependencies: {"yaml"}, peerDependencies: Pi host packages "*"
src/config.ts         load config
src/catalog.ts        scan roots, parse SKILL.md, return SkillDoc[]
src/index-store.ts    SQLite FTS5 index with an incremental manifest
src/search.ts         query → ranked results, confidence → 1, 3 or 5 results
src/read.ts           exact read of one skill by name
src/telemetry.ts      append one JSON line per tool call / command to <cacheDir>/telemetry.jsonl
extension/index.ts    Pi extension: tools skill_search and skill_read, session state, telemetry
bin/pi-skill.ts       CLI: index | search | read   (#!/usr/bin/env node; Node 24 runs .ts directly)
eval/                 dataset builders and the eval runner (see "Eval")
test/*.test.ts        node --test
README.md             install, config, how it works, measured results
```

Node 24 runs TypeScript by stripping types. Use only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties. Import local files with the `.ts` extension.

## Config

File: `$SKILL_SEARCH_CONFIG`, else `~/.pi/agent/skill-search.json`.

```json
{
  "roots": ["~/skills", "~/.claude/skills"],
  "exclude": ["human-review"],
  "cacheDir": "~/.pi/agent/cache/skill-search"
}
```

- A root is a directory. Every `*/SKILL.md` directly under it is a skill (one level, like Claude Code plugins).
- `exclude`: skill names to skip.
- First root wins on a name collision. Report collisions in the index stats.

## SkillDoc (src/catalog.ts)

```ts
type SkillDoc = { name: string; description: string; body: string; path: string; dir: string; sha256: string; mtimeMs: number; size: number };
```

- Frontmatter between the first two `---` lines. Parse with `yaml`. If YAML fails, fall back to `key: value` lines.
- `name` from frontmatter, else the folder name. Skip a skill with no description.
- `body` is the text after the frontmatter.
- `summary(description)`: first sentence. If it is shorter than 60 chars, add the second sentence. Cap at 160 chars on a word boundary, end with "…".

## Index (src/index-store.ts)

- Database: `<cacheDir>/index.sqlite`.
- Table `skills(name PRIMARY KEY, path, dir, sha256, mtime_ms, size, description, summary)`.
- FTS5 table `skills_fts(name, description, body, tokenize = "porter unicode61")`. In the `name` column store the name with `-` and `_` replaced by spaces, plus the raw name.
- Incremental update: compare each file's `mtimeMs` and `size` with the manifest. Only if they differ, read it and compare `sha256`. Reindex changed skills, add new ones, delete removed ones. Return stats: `{ total, added, updated, removed, unchanged, ms }`.
- One transaction per update.

## Search (src/search.ts)

```ts
search(query: string, options?: { limit?: number }): { results: Array<{ name: string; summary: string }>; confidence: "high" | "normal" | "ambiguous" }
```

- Tokenize the query: lowercase, split on non-alphanumerics, drop a small stopword list and tokens shorter than 2 chars. Build an FTS5 MATCH of the tokens joined with `OR`, each token quoted.
- Rank: `bm25(skills_fts, 3.0, 2.0, 1.0)` (name 3, description 2, body 1). Lower bm25 is better; convert to a positive score.
- Exact name bonus: when the query contains a skill name (hyphenated form or space form), put it first.
- Retrieve the top 20 internally. Then:
  - `high`: an exact name match, or top1 score ≥ `HIGH_RATIO` × top2 score → return 1 result.
  - `ambiguous`: top3 score ≥ `AMBIGUOUS_RATIO` × top1 score → return 5 results.
  - else `normal` → return 3.
  - Export `HIGH_RATIO = 2.0` and `AMBIGUOUS_RATIO = 0.85` as constants. The eval tunes them.
- `options.limit` overrides the count.
- No scores, paths or body text in the result.
- `listSkills(index, area?)`: the full catalog (`name`, `summary`), alphabetical by name. With
  `area`, keeps only names that start with it or have it as one of their hyphen-separated
  words (`matchesArea`), for example `area: "deploy"` matches `deploy`, `deploy-fleet`, and
  `api-service-e2e-on-deploy`.

## Read (src/read.ts)

`readSkill(name)` → the full SKILL.md text with a 2-line header:

```text
Skill: <name>
Directory: <dir>  (resolve relative paths in this skill against it)
```

Unknown name → an error that lists the 3 closest names by search.

## Pi extension (extension/index.ts)

- On `session_start`: load config, update the index (incremental), keep the DB open.
- Tool `skill_search`:
  - description (the only permanent cost; adds at most 20 words over the base text to mention the fallback): "Find a skill (a specialized, project-specific workflow) by a short description of the task. Use it for project procedures and complex tool workflows, not for ordinary conversation or general knowledge. Search with 2–6 words for one need; run separate searches for separate needs. Then load one result with skill_read. When no result fits, call it again with list: true (optionally area) to browse the full catalog."
  - parameters: optional `query: string`, optional `limit: number`, optional `list: boolean`, optional `area: string`. One of `query` or `list` is required.
  - with `query`: result text is one line per result `name — summary`. If confidence is high, prefix "Best match:"; otherwise append a final line `None fit? skill_search with list: true (optionally area).`
  - with `list: true`: result text is the catalog from `listSkills` (optionally filtered by `area`), one line per skill `name — summary` with the summary cut to 100 chars.
- Tool `skill_read`:
  - description: "Load the full instructions of a skill by exact name. Read it before you follow the skill."
  - parameter: `name: string`.
  - session state: `Map<name, sha256>` of skills read. A second read of the same unchanged skill returns "Already loaded earlier in this session (unchanged). Use the copy in your context." Clear the map on `session_compact` and on `session_start`, because compaction can drop the earlier copy.
- Telemetry (`src/telemetry.ts`): every `skill_search` call, every `skill_read` call, and every skill `/command` appends one JSON line — `{ ts, sessionId, kind: "search" | "list" | "read" | "command", query?, area?, results?, confidence?, name? }` — to `<cacheDir>/telemetry.jsonl`. `sessionId` is `ctx.sessionManager.getSessionId()`. A write failure never fails the tool call: notify once with `ctx.ui.notify(..., "warning")`, then keep going. `SKILL_SEARCH_NO_TELEMETRY=1` disables all logging.
- Close the DB on `session_shutdown`.
- Fail loudly: a config or index error shows `ctx.ui.notify(..., "error")` and the tools return the error text.

## CLI (bin/pi-skill.ts)

```text
pi-skill index            update the index, print stats JSON
pi-skill search "<query>" [--limit N] [--json]
pi-skill read <name>
```

## Tests (test/*.test.ts, node --test)

Use a temp dir with 4–5 fixture skills. Cover: frontmatter parse and the YAML fallback, incremental update (add, change, remove, unchanged), exact name bonus, confidence result counts, read of an unknown name, the summary rule.

## Eval (eval/)

- `eval/data/*.jsonl`: one case per line, `{ "query": string, "expected": string[], "source": string }`.
- `eval/run-eval.ts`: for each dataset, compute Hit@1, Hit@3, Hit@5 and MRR over the top 20, and the mean number of results returned by the confidence logic. Print a table. `--variant` options: `fts-name-desc` (body weight 0), `fts-all` (default 3/2/1).
- The datasets are built by separate scripts. Do not invent data.

## Code style

Plain-English names with verbs. Name a condition in a variable before the `if`. Positive case first. No bare `else`. No inline comments. Docstrings only on exported functions, minimal. Few files. Fail loudly.
