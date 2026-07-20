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
  .filter((f) => !f.startsWith("packages/ui/src/components/"));

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
