#!/usr/bin/env node
// Pre-commit guard: keep source files small and single-purpose.
//
// The guard is a ratchet, not a snapshot. It compares each staged file against
// the version in HEAD and fails only when THIS commit makes things worse:
//
//   - a file crosses the limit (it was at or under, now it is over), or
//   - a file that was already over the limit grows further.
//
// A file that is already over and holds steady or shrinks passes. Without that,
// any commit touching a pre-existing large file is forced to either drag an
// unrelated refactor along or reach for `git commit --no-verify` — and that
// escape hatch is all-or-nothing, so disarming this soft local advisory also
// silently disarms `verify:commit`. Grandfathering the debt is what keeps the
// strong gate armed.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const MAX_LINES = 300;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function countLines(text) {
  return text.split("\n").length;
}

/** Lines in the staged (index) version, or null when it is not readable. */
function stagedLines(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return countLines(git(["show", `:${file}`]));
  } catch {
    // Staged for deletion/rename and gone from disk, or unreadable.
    return null;
  }
}

/** Lines in HEAD's version, or 0 when the file is new to this commit. */
function committedLines(file) {
  try {
    return countLines(git(["show", `HEAD:${file}`]));
  } catch {
    return 0;
  }
}

/**
 * Staged changes as `{ file, before }` pairs, where `before` is the path to
 * compare against in HEAD.
 *
 * Renames and copies (`R`/`C`) are included deliberately. Dropping them lets a
 * commit move a file and blow it up in the same breath: the destination path is
 * invisible to a name-only `ACM` filter, so a 250-line file could land somewhere
 * else at 400 lines and pass. Comparing the destination against its SOURCE in
 * HEAD is also what keeps a pure move of an already-oversized file passing —
 * moving a file does not make it worse.
 */
function stagedChanges() {
  const records = git(["diff", "--cached", "--name-status", "-z", "--diff-filter=ACMR"]).split(
    "\0",
  );
  const changes = [];
  for (let i = 0; i < records.length; i += 1) {
    const status = records[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = records[i + 1];
      const to = records[i + 2];
      i += 2;
      if (to) changes.push({ file: to, before: from ?? to });
    } else {
      const file = records[i + 1];
      i += 1;
      if (file) changes.push({ file, before: file });
    }
  }
  return changes;
}

const IGNORED = [
  // Vendored generated skill copies from zaks-io/skills; never hand-edited here.
  (f) => f.startsWith(".agents/"),
  // Vendored shadcn component copies; upstream sizes, kept diffable for `shadcn add --diff`.
  (f) => f.startsWith("packages/ui/src/components/"),
  // Machine-generated (e.g. TanStack Router's routeTree.gen.ts): size tracks the
  // number of routes and cannot be hand-split.
  (f) => f.endsWith(".gen.ts"),
];

const staged = stagedChanges()
  .filter(({ file }) => EXTENSIONS.some((ext) => file.endsWith(ext)))
  .filter(({ file }) => !IGNORED.some((ignore) => ignore(file)));

const offenders = [];
for (const { file, before: baseline } of staged) {
  const lines = stagedLines(file);
  if (lines === null || lines <= MAX_LINES) continue;

  const before = committedLines(baseline);
  if (before <= MAX_LINES) {
    offenders.push({ file, lines, reason: `crosses the ${MAX_LINES}-line limit` });
  } else if (lines > before) {
    offenders.push({
      file,
      lines,
      reason: `already over ${MAX_LINES} at ${before} lines and growing`,
    });
  }
}

if (offenders.length > 0) {
  console.error(`\n✖ File-size guard: ${offenders.length} file(s) got worse in this commit.`);
  for (const { file, lines, reason } of offenders) {
    console.error(`  ${file} — ${lines} lines (${reason})`);
  }
  console.error(
    "\nKeep modules small and single-purpose. Split the file, or move the new code\n" +
      "into a smaller module that the large one re-exports, so this file stops growing.\n",
  );
  process.exit(1);
}
