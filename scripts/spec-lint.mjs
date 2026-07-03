#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const docsSpecDir = path.join(process.cwd(), "docs", "spec");

export const bannedPhraseRules = [
  {
    name: "Retired Experiment Run lifecycle verb",
    pattern: /\bPublish\b/,
    hint: "Use Start, End, or Promote depending on the domain action.",
  },
  {
    name: "Event-time snapshot tailing",
    pattern: /server_ts\s*>\s*last_snapshot(?:_ts)?/,
    hint: "Tail by ingest_ts watermarks, not server_ts.",
  },
  {
    name: "Old BH-family token",
    pattern: /(?<![A-Za-z0-9_])bh_family(?![A-Za-z0-9_])/,
    hint: "Use decision_family for input and in_bh_family only for result audit output.",
  },
  {
    name: "Ratio zero-denominator drop wording",
    pattern: /Exclude that Entity/,
    hint: "Zero-denominator rows stay in the data; arm-level zero denominators fail loud.",
  },
  {
    name: "Arm-specific winsor cap wording",
    pattern: /per-arm caps?/i,
    hint: "Winsor caps are pooled across arms.",
  },
  {
    name: "Legacy pooled variance token",
    pattern: /(?<![A-Za-z0-9_])var_pooled(?![A-Za-z0-9_])/,
    hint: "Use the aCS contract terms from the stats specs.",
  },
  {
    name: "Legacy interval-width token",
    pattern: /(?<![A-Za-z0-9_])half_width(?![A-Za-z0-9_])/,
    hint: "Use the aCS contract terms from the stats specs.",
  },
  {
    name: "Invalid p-value formula",
    pattern: /p_value\s*=\s*1\s*-\s*alpha/,
    hint: "Do not encode alpha-derived p-values as the aCS contract.",
  },
];

const decisionMarkers = ["in_bh_family", "is_significant", "is_breached", "exploratory"];

function lineForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function pushBannedPhraseViolations(violations, filePath, text) {
  for (const rule of bannedPhraseRules) {
    const match = rule.pattern.exec(text);
    if (match?.index !== undefined) {
      violations.push({
        filePath,
        line: lineForIndex(text, match.index),
        message: `${rule.name}: ${rule.hint}`,
      });
    }
  }
}

function hasDecisionMarker(text) {
  return decisionMarkers.some((marker) => text.includes(marker));
}

function pushMissingDecisionValidViolations(violations, filePath, text) {
  const fencedBlockPattern = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fencedBlockPattern)) {
    const block = match[1] ?? "";
    if (
      /interface\s+\w*Result\b/.test(block) &&
      hasDecisionMarker(block) &&
      !block.includes("decision_valid")
    ) {
      violations.push({
        filePath,
        line: lineForIndex(text, match.index ?? 0),
        message: "Decision-bearing code block is missing decision_valid.",
      });
    }
  }

  const sections = text.split(/(?=^##\s+)/m);
  let offset = 0;
  for (const section of sections) {
    const heading = section.split("\n", 1)[0] ?? "";
    const isResultTable = /result (?:object|shape)/i.test(heading);
    if (
      isResultTable &&
      hasDecisionMarker(section) &&
      section.includes("|") &&
      !section.includes("decision_valid")
    ) {
      violations.push({
        filePath,
        line: lineForIndex(text, offset),
        message: "Decision-bearing Markdown table section is missing decision_valid.",
      });
    }
    offset += section.length;
  }
}

export function lintSpecText(filePath, text) {
  const violations = [];
  pushBannedPhraseViolations(violations, filePath, text);
  pushMissingDecisionValidViolations(violations, filePath, text);
  return violations;
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listMarkdownFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

export async function lintSpecDirectory(dir = docsSpecDir) {
  const files = await listMarkdownFiles(dir);
  const violationGroups = await Promise.all(
    files.map(async (filePath) => {
      const text = await readFile(filePath, "utf8");
      return lintSpecText(path.relative(process.cwd(), filePath), text);
    }),
  );
  return violationGroups.flat();
}

async function main() {
  const violations = await lintSpecDirectory();
  if (violations.length === 0) {
    console.log("spec:lint passed");
    return;
  }

  console.error("spec:lint failed");
  for (const violation of violations) {
    console.error(`${violation.filePath}:${violation.line} ${violation.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
