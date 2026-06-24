// Scans only the commits introduced by this change with Gitleaks, instead of
// the whole worktree. The range is resolved from the environment:
//   - CI pull_request:  origin/<base>..HEAD        (GITHUB_BASE_REF)
//   - CI push:          <before>..<after>          (SECRETS_RANGE_BEFORE/_AFTER)
//   - local pre-push:   <upstream>..HEAD, else origin/main..HEAD
// Mirrors security-check.mjs: if gitleaks is absent, warn and skip locally
// (CI installs it and sets CI=true, where a missing binary fails loudly).
import { spawnSync } from "node:child_process";

const CI = process.env.CI === "true";

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

function resolveRange() {
  // CI push event: explicit before/after from the GitHub event payload.
  const before = process.env.SECRETS_RANGE_BEFORE;
  const after = process.env.SECRETS_RANGE_AFTER || "HEAD";
  if (before && before !== ZERO_SHA && git(["cat-file", "-e", before]) !== null) {
    return `${before}..${after}`;
  }

  // CI pull_request event: scan everything the PR adds on top of its base.
  const base = process.env.GITHUB_BASE_REF;
  if (base) {
    const ref = git(["rev-parse", "--verify", `origin/${base}`]) ? `origin/${base}` : base;
    return `${ref}..HEAD`;
  }

  // Local pre-push: commits not yet on the tracked upstream, else origin/main.
  if (git(["rev-parse", "--verify", "--quiet", "@{upstream}"]) !== null) {
    return "@{upstream}..HEAD";
  }
  if (git(["rev-parse", "--verify", "--quiet", "origin/main"]) !== null) {
    return "origin/main..HEAD";
  }
  return null;
}

const range = resolveRange();
if (!range) {
  // No baseline to diff against (e.g. brand-new branch with no upstream). A
  // silent pass would let a leaked secret through; scan the full history so the
  // gate still means something.
  console.warn("\x1b[33m⚠ secrets:range: no upstream baseline; scanning full git history.\x1b[0m");
}

const gitleaksArgs = ["git", "--redact", "--no-banner"];
if (range) gitleaksArgs.push(`--log-opts=${range}`);
gitleaksArgs.push(".");

const probe = spawnSync("gitleaks", ["version"], { stdio: "ignore" });
if (probe.status !== 0) {
  const msg = "secrets:range: 'gitleaks' not found on PATH.";
  if (CI) {
    console.error(`${msg} Failing (CI).`);
    process.exit(1);
  }
  console.warn(`\x1b[33m⚠ ${msg} Skipping locally; CI enforces it.\x1b[0m`);
  process.exit(0);
}

const run = spawnSync("gitleaks", gitleaksArgs, { stdio: "inherit" });
process.exit(run.status ?? 1);
