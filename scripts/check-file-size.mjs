#!/usr/bin/env node
// Pre-commit guard: keep source files small and single-purpose.
// Local-only (git hook). NOT enforced in CI, so it can be bypassed with
// `git commit --no-verify` when there's a legitimate reason for a large file.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_LINES = 300;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"];

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
  encoding: "utf8",
})
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
  // Vendored generated skill copies from zaks-io/skills; never hand-edited here.
  .filter((f) => !f.startsWith(".agents/"))
  // Vendored shadcn component copies; upstream sizes, kept diffable for `shadcn add --diff`.
  .filter((f) => !f.startsWith("packages/ui/src/components/"))
  // Machine-generated (e.g. TanStack Router's routeTree.gen.ts): size tracks the
  // number of routes and cannot be hand-split.
  .filter((f) => !f.endsWith(".gen.ts"))
  // Pure re-export barrels (e.g. a package's public-API entry): size tracks the
  // number of exported names, and Biome's `noReExportAll` forbids `export * from`,
  // the one construct that would compress them. This is a shape test rather than a
  // file list on purpose: the moment a barrel grows a declaration or any other
  // statement it stops matching and the guard re-engages on it.
  .filter((f) => !isReExportBarrel(f));

/**
 * True when every statement in the file is `export ... from "..."`. Comments and
 * blank lines are ignored; anything else at all (a `const`, a function, a local
 * `export`) disqualifies the file.
 */
function isReExportBarrel(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let rest = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
  if (rest.length === 0) return false;
  const reExport =
    /^export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["'][^"']+["'];/;
  while (rest.length > 0) {
    const match = reExport.exec(rest);
    if (!match) return false;
    rest = rest.slice(match[0].length).trimStart();
  }
  return true;
}

const offenders = [];
for (const file of staged) {
  try {
    if (!statSync(file).isFile()) continue;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > MAX_LINES) offenders.push({ file, lines });
  } catch {
    // File staged for deletion/rename that no longer exists on disk; skip.
  }
}

if (offenders.length > 0) {
  console.error(`\n✖ File-size guard: ${offenders.length} file(s) exceed ${MAX_LINES} lines.`);
  for (const { file, lines } of offenders) {
    console.error(`  ${file} — ${lines} lines`);
  }
  console.error(
    "\nKeep modules small and single-purpose. Split the file, or bypass with a reason:\n" +
      "  git commit --no-verify\n",
  );
  process.exit(1);
}
