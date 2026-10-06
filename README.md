# pi-skill-search

A local index and two Pi tools that replace the model-facing skill catalog.

## 1. What it is

Pi can load a folder of `SKILL.md` files as a catalog. Normally the whole catalog — every
skill name and description — sits in the system prompt of every request, so a project with
`N` skills pays for `N` descriptions on every single turn, whether or not the model needs
any of them. `pi-skill-search` replaces that catalog with a local `node:sqlite` FTS5 index
and two tools, `skill_search` and `skill_read`. The model calls `skill_search` only when it
actually needs a skill. The two tool schemas cost about 250 tokens total, once, instead of a
catalog that can run into the thousands of tokens and grows with every skill you add.

## 2. Install

Requirements: Node.js 24 or newer (for `node:sqlite`), and the
[Pi coding agent](https://pi.dev).

```bash
pi install git:github.com/nvgoldin/skill-search
# or, from a local clone
pi install /absolute/path/to/skill-search
```

`pi install` runs `npm install` for you and wires the extension into your Pi config. To
install by hand instead:

```bash
cd skill-search
npm install
```

`npm install` pulls the single runtime dependency, `yaml`. Node 24 runs the TypeScript
source directly (`node file.ts`), so there is no build step. Then add the extension to
`~/.pi/agent/settings.json` (or a project's `.pi/settings.json`):

```json
{
  "extensions": ["/absolute/path/to/skill-search/extension/index.ts"]
}
```

To use the CLI from anywhere, link the package so the `pi-skill` bin resolves:

```bash
npm link
pi-skill index
```

## 3. Configure

`skill-search` reads `$SKILL_SEARCH_CONFIG`, else `~/.pi/agent/skill-search.json`:

```json
{
  "roots": ["~/skills", "~/.claude/skills"],
  "exclude": ["human-review"],
  "cacheDir": "~/.pi/agent/cache/skill-search"
}
```

- `roots`: directories to scan. Every `*/SKILL.md` directly under a root is one skill, one
  level deep, the same layout Claude Code plugins use.
- `exclude`: skill names to drop, for example a skill with its own dedicated tool already.
- `cacheDir`: where the SQLite index file lives (`<cacheDir>/index.sqlite`).
- The first root wins on a name collision. `pi-skill index` reports collisions in its stats.

`~` expands to the home directory. Relative paths resolve against the current working
directory. Set `SKILL_SEARCH_CONFIG=/path/to/other-config.json` to point at a different file,
for example per project.

## 4. Use

Two tools do all retrieval:

- `skill_search(query?, limit?, list?, area?)`: with `query`, returns one line per result,
  `name — summary`. A high-confidence result is prefixed `Best match:`; anything else ends
  with `None fit? skill_search with list: true (optionally area).` With `list: true`, it
  returns the full catalog instead (optionally narrowed to an `area`), one line per skill.
  One of `query` or `list` is required.
- `skill_read(name)`: returns the full skill text for an exact name.

Each indexed skill is also a `/` command, for example `/deploy-service push the latest
build`. The extension handles it in Pi's `input` event, so it works the same way in the
interactive TUI, in `pi -p`, in `--mode json`, and in `pi-subagents` children (which receive
tasks as `Task: /name …`). It also writes one prompt template per skill to
`<cacheDir>/prompts/`, only so the commands show up in `/` completion. Commands cost the
model 0 tokens: nothing is added to the system prompt to make them work.

## 5. Subagents

`pi-subagents` foreground children do not load the parent's extensions and use a strict tool
allowlist. To give children the tools and the commands, add this to
`~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["/abs/path/to/skill-search/extension/index.ts"],
    "agentOverrides": {
      "delegate": { "tools": ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "skill_search", "skill_read"] }
    }
  }
}
```

Repeat the `tools` override for every agent that should search: `scout`, `worker`,
`reviewer`, `oracle`. Each list replaces that agent's built-in list, so copy the built-in
tools from `pi-subagents/agents/<name>.md` first.

## 6. How it works

1. **Catalog** (`src/catalog.ts`): scans each root one level deep, reads every `SKILL.md`,
   and parses the YAML frontmatter between the first two `---` lines (falling back to plain
   `key: value` lines when the YAML does not parse). A skill with no `description` is
   skipped. The `name` comes from the frontmatter, or the folder name when absent.

2. **Index** (`src/index-store.ts`): keeps a `skills` table (metadata and a short summary)
   and an FTS5 virtual table `skills_fts(name, description, body)` with `porter unicode61`
   tokenization, scored by `bm25(skills_fts, 3.0, 2.0, 0.5)` — name weighs 3x, description
   2x, body 0.5x. An update compares each file's `mtimeMs` and `size` against a stored
   manifest first, and only opens files that changed; it then compares `sha256` before
   reindexing, so a touched-but-identical file costs almost nothing. Everything happens in
   one transaction, so the index is never left half-updated.

3. **Search** (`src/search.ts`): tokenizes the query (lowercase, split on non-alphanumerics,
   drop short tokens and a small stopword list), builds an FTS `OR` match, and pulls the top
   20 ranked rows. An exact skill name in the query (hyphenated or spaced form) is promoted
   to first place. The result count then depends on confidence:
   - `high` (exact name match, or the top result's score is at least `HIGH_RATIO` times the
     next one): 1 result.
   - `ambiguous` (the third result's score is within `AMBIGUOUS_RATIO` of the top result):
     5 results.
   - `normal`: 3 results.
   Results carry only `name` and a short `summary`, never a score, a path, or body text.
   `listSkills()` returns the whole catalog, alphabetical by name, optionally narrowed to
   skills whose name starts with an `area` word or has it as a hyphen-separated word
   (`area: "deploy"` matches `deploy`, `deploy-fleet`, and `api-service-e2e-on-deploy`).

4. **Read** (`src/read.ts`): returns the full `SKILL.md` text for an exact name, with a
   2-line header naming the skill and its directory (resolve relative paths in the skill
   against that directory). An unknown name raises an error that lists the 3 closest names.

5. **Session read cache**: a session-local `Map<name, sha256>` tracks skills already read.
   Reading the same unchanged skill again returns a short notice instead of the text, so the
   model does not pay for the same content twice. The map clears on `session_start` and on
   `session_compact`, because compaction can drop the earlier copy from context.

6. **Telemetry** (`src/telemetry.ts`): every `skill_search` call (`kind: "search"` or
   `"list"`), every `skill_read` call (`kind: "read"`), and every skill `/command`
   (`kind: "command"`) appends one JSON line — `{ ts, sessionId, kind, query?, area?,
   results?, confidence?, name? }` — to `<cacheDir>/telemetry.jsonl`. A write failure never
   fails the tool call: it shows once through `ctx.ui.notify(..., "warning")` and the call
   continues. Set `SKILL_SEARCH_NO_TELEMETRY=1` to turn logging off entirely.

## 7. CLI

```bash
pi-skill index                       # update the index, print stats as JSON
pi-skill search "<query>" [--limit N] [--json]
pi-skill read <name>
```

## 8. Evaluate on your own skills

The `eval/` folder builds datasets from your own skills and usage, and measures retrieval
quality against them. Nothing in `eval/` runs as part of normal use; run it only when you
want to tune or verify the search ranking for your own catalog.

Some scripts call an LLM through an Anthropic-compatible `/v1/messages` endpoint. They read:

- `EVAL_ANTHROPIC_BASE_URL`: the full URL of that endpoint. Required.
- `EVAL_API_KEY`: the API key, or `EVAL_API_KEY_COMMAND`: a shell command whose stdout is the
  key (for providers that issue short-lived keys through a helper). One of the two is
  required.
- `EVAL_MODEL`: the model name. Defaults to `claude-sonnet-5`.

Each script fails loudly with a clear message when a variable it needs is missing, so there
is no silent fallback to a wrong gateway or key.

Run them in this order:

1. `node eval/extract-claude-dataset.ts` — scans Claude Code transcripts
   (`~/.claude/projects` by default, override with `EVAL_TRANSCRIPTS_DIR`) for real requests
   that led to a skill being used, redacts anything that looks like a secret, and writes
   `eval/data/claude-real.jsonl`. Skill names come from your `skill-search` config
   (`src/config.ts`), not a hard-coded path.
2. `node eval/judge-labels.ts` — asks the gateway model whether each case's raw request text,
   read alone, really points to its labeled skill, and writes the "yes" cases to
   `eval/data/claude-real-clean.jsonl`. Many raw requests are bare follow-ups ("continue")
   that depend on earlier context, so this filters them out before scoring.
3. `node eval/condense-queries.ts` — asks the gateway model what short search query it would
   actually type for each case, and caches 1-3 condensed queries per case in
   `eval/data/condensed.json`, keyed by a hash of the raw query (reruns are free once cached).
4. `node eval/run-eval.ts [--variant fts-all|fts-name-desc] [--queries raw|condensed]` —
   computes Hit@1, Hit@3, Hit@5 and MRR for `src/search.ts` directly, no LLM call, over every
   `eval/data/*.jsonl` dataset.
5. `node eval/baseline-index.ts` (needs `EVAL_BASELINE_INDEX`, the path to a flat `SKILL.md`
   catalog file) — the comparison method this package replaces: paste the whole catalog file
   plus the query into the gateway model and ask for the 3 best skill names.
6. `node eval/run-pi-e2e.ts` (needs `EVAL_PI_PROVIDER`, `EVAL_PI_MODEL`, and, for
   `--baseline-index` runs, `EVAL_BASELINE_INDEX`) — runs real `pi` subprocesses end to end,
   extension and tools included, and scores the model's final answer and whether it actually
   read the right skill. `--baseline-index` runs the same cases without the extension,
   pasting the whole catalog file into the prompt instead.

A dataset line looks like `{ "query": string, "expected": string[], "source": string,
"nameInQuery"?: boolean }`. `eval/telemetry-to-dataset.ts` can also turn real
`<cacheDir>/telemetry.jsonl` usage into more eval cases.

## 9. Results

Measured on a real catalog of about 110 skills, with the gateway model set to a Sonnet-5
class model.

- **Token cost**: the two tool schemas add about 250 tokens to the system prompt. The
  alternatives were about 14,500 tokens for all descriptions in the prompt, or about 7,000
  tokens each time the model reads a flat index file of the catalog.
- **Offline ranking** (`eval/run-eval.ts`, no LLM): when the request already names the skill,
  Hit@3 is about 96-100%. When it does not, plain keyword search (FTS5) reaches about 51%
  Hit@3, versus about 75% for a model reading the whole flat index and picking from it.
- **End-to-end in Pi** (`eval/run-pi-e2e.ts`, real `pi` subprocesses, Sonnet-5 class model):
  on hard real requests that do not name the skill, `pi-skill-search` scored 44.1% accuracy
  versus 41.2% for the flat-index method. On synthetic requests, 87.5% versus 77.5%.
- A local-embeddings variant was tried as an experiment (not included in this package): it
  reached about 75% Hit@3 on the hard offline subset, close to the flat-index method, but it
  adds roughly 690 MB of dependencies (an ONNX runtime and model files) for a project whose
  goal is Node built-ins only. It is not worth that cost yet.

The clear win is the exact-name case: whenever the request already names a skill, this
package is fast, free, and already near-perfect. The hard case — a request that describes a
need without naming a skill — is where keyword search alone has the biggest gap to a model
reading everything, and where future tuning should focus.

## 10. Limitations and next steps

- Plain keyword (FTS5) ranking is weak on requests that do not name the skill. Hit@3 there is
  around 51%, well under the quality a full-index LLM read reaches.
  Closing that gap without adding a large dependency (see "Results") is the main open
  problem.
- `HIGH_RATIO` and `AMBIGUOUS_RATIO` are tuned for bm25 score distributions; a different
  ranking signal (embeddings, a different tokenizer) needs its own tuning pass, not these
  same constants.
- The catalog is one level deep (`root/*/SKILL.md`) and has no notion of skill versions or
  dependencies between skills.
- `eval/run-pi-e2e.ts` spawns real `pi` processes and real model calls; it is useful for
  tuning but is not meant to run in CI on every commit.
