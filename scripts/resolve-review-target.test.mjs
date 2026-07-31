import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildForkBriefing,
  parseTargetArgs,
  resolveReviewTarget,
} from "./resolve-review-target.mjs";

const CLI = fileURLToPath(new URL("./resolve-review-target.mjs", import.meta.url));
const REPO_ROOT = dirname(dirname(CLI));

const TARGET_PR = {
  number: 247,
  headRefName: "spl-234-flag-key-uniqueness",
  headRefOid: "1178288e0a61ddf837bb4b3c661d8c424b44e363",
  baseRefName: "main",
  state: "MERGED",
  url: "https://github.com/zaks-io/splitch/pull/247",
};

// The SPL-256 incident shape: the reviewer runs inside a worktree that belongs to
// a different PR. Anything the resolver reads from here is the wrong diff.
function ambientWorktree() {
  const directory = mkdtempSync(join(tmpdir(), "spl-256-ambient-"));
  const git = (args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  git(["init", "--initial-branch=spl-118-flag-editing"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(directory, "unrelated.txt"), "other pr\n");
  git(["add", "."]);
  git(["commit", "-m", "unrelated PR #245 work"]);
  return directory;
}

function stubbedGhPath(json) {
  const directory = mkdtempSync(join(tmpdir(), "spl-256-gh-"));
  const stub = join(directory, "gh");
  writeFileSync(stub, `#!/bin/sh\ncat <<'JSON'\n${json}\nJSON\n`);
  chmodSync(stub, 0o755);
  return directory;
}

function runCli(args, { cwd, ghJson } = {}) {
  const env = { ...process.env };
  if (ghJson) env.PATH = `${stubbedGhPath(ghJson)}:${env.PATH}`;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? REPO_ROOT,
    encoding: "utf8",
    env,
  });
}

test("the CLI fails loud instead of falling back to the ambient worktree", () => {
  const result = runCli([], { cwd: ambientWorktree() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an explicit review target/);
  assert.match(result.stderr, /--pr <number>/);
  assert.match(result.stderr, /--branch <name>/);
  assert.match(result.stderr, /--range <base>\.\.<head>/);
  assert.equal(result.stdout, "");
});

test("the CLI reviews the named PR even when run from an unrelated worktree", () => {
  const worktree = ambientWorktree();
  const ambientHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).stdout.trim();

  const result = runCli(["--pr", "247", "--repo", "zaks-io/splitch"], {
    cwd: worktree,
    ghJson: JSON.stringify(TARGET_PR),
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /PR number: 247/);
  assert.match(result.stdout, new RegExp(`Head SHA: ${TARGET_PR.headRefOid}`));
  assert.doesNotMatch(result.stdout, new RegExp(ambientHead));
  assert.doesNotMatch(result.stdout, /spl-118-flag-editing/);
});

test("the CLI refuses two targets rather than picking one", () => {
  const result = runCli(["--pr", "247", "--branch", "spl-118-flag-editing"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Ambiguous ziw-code-review target/);
});

test("the CLI rejects an unknown argument instead of ignoring it", () => {
  const result = runCli(["--pull-request", "247"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unrecognized ziw-code-review argument --pull-request/);
});

test("the fork briefing carries the target and forbids ambient re-resolution", () => {
  const target = resolveReviewTarget({
    argv: ["--pr", "247", "--repo", "zaks-io/splitch"],
    runCommand: () => ({ status: 0, stdout: JSON.stringify(TARGET_PR), stderr: "" }),
  });
  const briefing = buildForkBriefing(target);

  assert.match(briefing, /PR number: 247/);
  assert.match(briefing, new RegExp(`Head SHA: ${TARGET_PR.headRefOid}`));
  assert.match(briefing, /may not change it/);
  assert.match(briefing, /checked-out branch/);
  assert.match(briefing, /Review target: PR #247 @ 1178288e0a61ddf837bb4b3c661d8c424b44e363/);
});

test("a PR head without a pinned SHA is a hard stop", () => {
  assert.throws(
    () =>
      resolveReviewTarget({
        argv: ["--pr", "247", "--repo", "zaks-io/splitch"],
        runCommand: () => ({
          status: 0,
          stdout: JSON.stringify({ ...TARGET_PR, headRefOid: "" }),
          stderr: "",
        }),
      }),
    /did not resolve to a full commit SHA/,
  );
});

test("parsing keeps the target explicit and never invents a default", () => {
  assert.deepEqual(parseTargetArgs(["--branch", "spl-234-flag-key-uniqueness"]), {
    kind: "branch",
    value: "spl-234-flag-key-uniqueness",
    repo: null,
    json: false,
  });
  assert.throws(() => parseTargetArgs(["--json"]), /requires an explicit review target/);
});
