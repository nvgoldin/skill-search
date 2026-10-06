#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { scanRoots } from "../src/catalog.ts";

const transcriptsRoot = process.env.EVAL_TRANSCRIPTS_DIR ?? join(homedir(), ".claude", "projects");
const outputPath = new URL("./data/claude-real.jsonl", import.meta.url).pathname;

const SECRET_TOKEN_PATTERN = /[A-Za-z0-9_+/=.-]+/g;
const SECRET_PREFIXES = ["ghp_", "ATATT", "eyJ", "xox", "AKIA"];

type RawCase = { query: string; expected: string; kind: "natural" | "slash-args"; file: string };
type ContentBlock = { type?: string; text?: string; name?: string; input?: { skill?: string }; [key: string]: unknown };

function listJsonlFilesRecursively(root: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsonlFilesRecursively(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

function loadAllowedSkillNames(): Set<string> {
  const config = loadConfig();
  const { docs } = scanRoots(config.roots, config.exclude);
  return new Set(docs.map((doc) => doc.name));
}

function looksLikeSecretToken(token: string): boolean {
  const looksLikePath = token.includes("/") || token.includes(".");
  if (token.length >= 30 && !looksLikePath) return true;
  return SECRET_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function redactSecrets(text: string): string {
  return text.replace(SECRET_TOKEN_PATTERN, (token) => (looksLikeSecretToken(token) ? "<redacted>" : token));
}

function processQuery(rawQuery: string): string {
  const collapsed = rawQuery.replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(collapsed);
  return redacted.slice(0, 600);
}

function extractHumanText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as ContentBlock[];
  const hasToolResultBlock = blocks.some((block) => block.type === "tool_result");
  if (hasToolResultBlock) return null;
  const textBlocks = blocks.filter((block) => block.type === "text" && typeof block.text === "string");
  if (textBlocks.length === 0) return null;
  return textBlocks.map((block) => block.text).join("\n");
}

function isOnlySystemReminder(trimmedText: string): boolean {
  return /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(trimmedText);
}

function isSkippableHumanText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("Caveat:")) return true;
  if (text.includes("<local-command-stdout>")) return true;
  if (text.includes("<task-notification>")) return true;
  if (text.includes("Base directory for this skill")) return true;
  return isOnlySystemReminder(trimmed);
}

function parseSlashCommand(text: string): { command: string; args: string } | null {
  const nameMatch = text.match(/<command-name>\s*\/([^<]+?)\s*<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return { command: nameMatch[1].trim(), args };
}

function stripPluginPrefix(skillRaw: string): string {
  const colonIndex = skillRaw.indexOf(":");
  return colonIndex === -1 ? skillRaw : skillRaw.slice(colonIndex + 1);
}

function extractCasesFromFile(filePath: string): RawCase[] {
  const cases: RawCase[] = [];
  const fileName = basename(filePath);
  const lines = readFileSync(filePath, "utf8").split("\n");

  let latestNaturalText: string | null = null;
  let latestNaturalConsumed = false;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === "user") {
      const content = record.message?.content;

      if (typeof content === "string") {
        const slashCommand = parseSlashCommand(content);
        if (slashCommand) {
          if (slashCommand.args.length > 0) {
            cases.push({ query: slashCommand.args, expected: slashCommand.command, kind: "slash-args", file: fileName });
          }
          latestNaturalText = null;
          latestNaturalConsumed = true;
          continue;
        }
      }

      const humanText = extractHumanText(content);
      const isUsableHumanText = humanText !== null && !isSkippableHumanText(humanText);
      if (isUsableHumanText) {
        latestNaturalText = humanText;
        latestNaturalConsumed = false;
      }
      continue;
    }

    if (record.type === "assistant") {
      const content = record.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as ContentBlock[]) {
        const isSkillCall = block.type === "tool_use" && block.name === "Skill";
        if (!isSkillCall) continue;

        const hasUnconsumedNaturalText = latestNaturalText !== null && !latestNaturalConsumed;
        if (!hasUnconsumedNaturalText) continue;

        const skillRaw = block.input?.skill;
        if (typeof skillRaw !== "string" || skillRaw.length === 0) continue;

        cases.push({ query: latestNaturalText as string, expected: stripPluginPrefix(skillRaw), kind: "natural", file: fileName });
        latestNaturalConsumed = true;
      }
    }
  }

  return cases;
}

function main(): void {
  const allowedSkillNames = loadAllowedSkillNames();
  const transcriptFiles = listJsonlFilesRecursively(transcriptsRoot);

  const rawCases: RawCase[] = [];
  for (const file of transcriptFiles) {
    rawCases.push(...extractCasesFromFile(file));
  }

  const seenQueries = new Set<string>();
  const finalLines: string[] = [];
  const kindCounts = new Map<string, number>();
  const skillCounts = new Map<string, number>();

  for (const rawCase of rawCases) {
    const expectedSkillExists = allowedSkillNames.has(rawCase.expected);
    if (!expectedSkillExists) continue;

    const query = processQuery(rawCase.query);
    if (query.length < 8) continue;

    const dedupeKey = query.toLowerCase();
    if (seenQueries.has(dedupeKey)) continue;
    seenQueries.add(dedupeKey);

    finalLines.push(
      JSON.stringify({
        query,
        expected: [rawCase.expected],
        source: "claude-transcript",
        kind: rawCase.kind,
        nameInQuery: query.toLowerCase().includes(rawCase.expected.toLowerCase()),
        file: rawCase.file,
      }),
    );

    kindCounts.set(rawCase.kind, (kindCounts.get(rawCase.kind) ?? 0) + 1);
    skillCounts.set(rawCase.expected, (skillCounts.get(rawCase.expected) ?? 0) + 1);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, finalLines.join("\n") + "\n");

  console.log(`Scanned ${transcriptFiles.length} transcript files`);
  console.log(`Total cases: ${finalLines.length}`);

  console.log("By kind:");
  for (const [kind, count] of kindCounts) {
    console.log(`  ${kind}: ${count}`);
  }

  console.log("Top 20 expected skills:");
  const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [skill, count] of topSkills) {
    console.log(`  ${skill}: ${count}`);
  }

  console.log(`Distinct skills covered: ${skillCounts.size}`);
}

main();
