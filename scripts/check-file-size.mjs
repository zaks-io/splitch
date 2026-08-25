#!/usr/bin/env node
// Pre-commit guard: keep source files small and single-purpose.
//
// Two limits per file, so documentation is free but not unbounded:
//
//   - CODE lines (non-blank, non-comment) must stay within MAX_CODE_LINES:
//     comments never force a split of an otherwise small module.
//   - TOTAL lines must stay within MAX_TOTAL_LINES, a hard cap that keeps
//     comment growth from turning "comments are free" into a loophole.
//
// The guard is a ratchet, not a snapshot. It compares each staged file against
// the version it inherits (HEAD, or the largest version across both parents
// during a merge) and fails only when THIS commit makes a metric worse:
//
//   - a file crosses a limit (it was at or under, now it is over), or
//   - a file that was already over a limit grows further on that metric.
//
// A file that is already over and holds steady or shrinks passes. Without that,
// any commit touching a pre-existing large file is forced to either drag an
// unrelated refactor along or reach for `git commit --no-verify` — and that
// escape hatch is all-or-nothing, so disarming this soft local advisory also
// silently disarms `verify:commit`. Grandfathering the debt is what keeps the
// strong gate armed.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_CODE_LINES = 300;
const MAX_TOTAL_LINES = MAX_CODE_LINES * 2;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"];

const METRICS = [
  { key: "code", max: MAX_CODE_LINES, noun: "code lines", limit: `${MAX_CODE_LINES} code-line` },
  {
    key: "total",
    max: MAX_TOTAL_LINES,
    noun: "total lines",
    limit: `${MAX_TOTAL_LINES} total-line`,
  },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * Line-based comment scanner, not a tokenizer: a `/*` inside a string or regex
 * literal reads as a comment opener and undercounts code until the block closes.
 * That failure mode only makes the guard more lenient, never a false reject,
 * which is the right bias for a local advisory.
 */
function countCodeLines(text) {
  let inBlockComment = false;
  let code = 0;
  for (const rawLine of text.split("\n")) {
    let rest = rawLine.trim();
    if (!rest) continue;
    let hasCode = false;
    while (rest.length > 0) {
      if (inBlockComment) {
        const end = rest.indexOf("*/");
        if (end === -1) break;
        inBlockComment = false;
        rest = rest.slice(end + 2).trim();
        continue;
      }
      const lineComment = rest.indexOf("//");
      const blockComment = rest.indexOf("/*");
      if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) {
        if (rest.slice(0, lineComment).trim()) hasCode = true;
        break;
      }
      if (blockComment !== -1) {
        if (rest.slice(0, blockComment).trim()) hasCode = true;
        inBlockComment = true;
        rest = rest.slice(blockComment + 2).trim();
        continue;
      }
      hasCode = true;
      break;
    }
    if (hasCode) code += 1;
  }
  return code;
}

function measure(text) {
  return { code: countCodeLines(text), total: text.split("\n").length };
}

/** Metrics of the staged (index) version, or null when it is not readable. */
function stagedMetrics(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return measure(git(["show", `:${file}`]));
  } catch {
    // Staged for deletion/rename and gone from disk, or unreadable.
    return null;
  }
}

/**
 * Revisions this commit inherits from. Normally just HEAD, but during a merge
 * HEAD is only the FIRST parent: every line the other parent grew since the
 * merge base would read as growth this commit introduced, so the guard would
 * reject a merge that authored none of it.
 */
function baselineRevisions() {
  try {
    const mergeHeadPath = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
    // Octopus merges list one parent SHA per line.
    const parents = readFileSync(mergeHeadPath, "utf8").split("\n").filter(Boolean);
    return ["HEAD", ...parents];
  } catch {
    // No merge in progress.
    return ["HEAD"];
  }
}

const BASELINE_REVISIONS = baselineRevisions();

function revisionMetrics(revision, file) {
  try {
    return measure(git(["show", `${revision}:${file}`]));
  } catch {
    return { code: 0, total: 0 };
  }
}

/**
 * Metrics already inherited: per metric, the largest value across every
 * parent, or 0 when the file is new to this commit. A merge that exceeds
 * neither parent grew nothing; a resolution that bloats a file past both
 * still gets caught.
 */
function committedMetrics(file) {
  const inherited = BASELINE_REVISIONS.map((revision) => revisionMetrics(revision, file));
  return {
    code: Math.max(...inherited.map((metrics) => metrics.code)),
    total: Math.max(...inherited.map((metrics) => metrics.total)),
  };
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
  // Machine-generated by `wrangler types`; the declaration mirrors bindings
  // and runtime types owned by Cloudflare rather than hand-authored modules.
  (f) => f.endsWith("/worker-configuration.d.ts"),
];

const staged = stagedChanges()
  .filter(({ file }) => EXTENSIONS.some((ext) => file.endsWith(ext)))
  .filter(({ file }) => !IGNORED.some((ignore) => ignore(file)));

const offenders = [];
for (const { file, before: baseline } of staged) {
  const now = stagedMetrics(file);
  if (now === null) continue;

  let before;
  for (const metric of METRICS) {
    if (now[metric.key] <= metric.max) continue;
    before ??= committedMetrics(baseline);

    if (before[metric.key] <= metric.max) {
      offenders.push({
        file,
        detail: `${now[metric.key]} ${metric.noun} (crosses the ${metric.limit} limit)`,
      });
    } else if (now[metric.key] > before[metric.key]) {
      offenders.push({
        file,
        detail: `${now[metric.key]} ${metric.noun} (already over the ${metric.limit} limit at ${before[metric.key]} and growing)`,
      });
    }
  }
}

if (offenders.length > 0) {
  console.error(`\n✖ File-size guard: ${offenders.length} file(s) got worse in this commit.`);
  for (const { file, detail } of offenders) {
    console.error(`  ${file} — ${detail}`);
  }
  console.error(
    "\nKeep modules small and single-purpose. Code lines over the limit: split the\n" +
      "file, or move the new code into a smaller module that the large one\n" +
      "re-exports. Total lines over the cap: the file is drowning in comments —\n" +
      "tighten them or move the prose to real docs.\n",
  );
  process.exit(1);
}
