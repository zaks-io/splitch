// SPL-256: ziw-code-review used to resolve its review target from ambient state
// (cwd, checked-out branch, `gh pr view` with no argument). Sessions run from
// worktrees unrelated to the PR under review, so ambient state is reliably wrong
// and a wrong-diff review is indistinguishable from a passing one. This resolver
// is the only sanctioned way the skill obtains a target: explicit in, fail loud
// out, and the emitted briefing carries the target into any forked reviewer.
import { spawnSync } from "node:child_process";

const TARGET_FLAGS = ["--pr", "--branch", "--range"];
const KNOWN_FLAGS = [...TARGET_FLAGS, "--repo", "--json"];
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

const MISSING_TARGET =
  "ziw-code-review requires an explicit review target. Pass exactly one of " +
  "--pr <number>, --branch <name>, or --range <base>..<head>. The working " +
  "directory, the checked-out branch, and `gh pr view` without an argument are " +
  "deliberately not consulted: a review of whatever happens to be checked out " +
  "reads exactly like a review of the target (SPL-256).";

export class ReviewTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewTargetError";
  }
}

function runCommandSync(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function readFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new ReviewTargetError(
        `Unrecognized ziw-code-review argument ${flag}. Expected one of ${KNOWN_FLAGS.join(", ")}.`,
      );
    }
    if (flag === "--json") {
      flags.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ReviewTargetError(`${flag} requires a value.`);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

export function parseTargetArgs(argv) {
  const flags = readFlags(argv);
  const chosen = TARGET_FLAGS.filter((flag) => flags.has(flag));
  if (chosen.length === 0) throw new ReviewTargetError(MISSING_TARGET);
  if (chosen.length > 1) {
    throw new ReviewTargetError(
      `Ambiguous ziw-code-review target: ${chosen.join(" and ")} were both passed. ` +
        "Pass exactly one target so the reviewed diff is unambiguous.",
    );
  }
  return {
    kind: chosen[0].slice(2),
    value: flags.get(chosen[0]),
    repo: flags.get("--repo") ?? null,
    json: flags.has("--json"),
  };
}

function requireHeadSha(value, label) {
  if (!FULL_COMMIT_SHA.test(value ?? "")) {
    throw new ReviewTargetError(
      `${label} did not resolve to a full commit SHA; found ${value || "nothing"}. ` +
        "Refusing to review without a pinned head: an unpinned target is the ambient-state defect.",
    );
  }
  return value;
}

function resolveRepo(repo, runCommand) {
  if (repo) return repo;
  const result = runCommand("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (result.status !== 0 || !result.stdout) {
    throw new ReviewTargetError(
      "Could not determine the code-host repository. Pass --repo <owner>/<name>.",
    );
  }
  return result.stdout;
}

function resolvePullRequestTarget(request, runCommand) {
  const repo = resolveRepo(request.repo, runCommand);
  const fields = "number,headRefName,headRefOid,baseRefName,state,url";
  const result = runCommand("gh", ["pr", "view", request.value, "--repo", repo, "--json", fields]);
  if (result.status !== 0) {
    throw new ReviewTargetError(
      `Could not resolve PR #${request.value} in ${repo}: ${result.stderr || "gh pr view failed"}.`,
    );
  }
  const pr = JSON.parse(result.stdout);
  return {
    targetKind: "pr",
    repo,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    headRef: pr.headRefName,
    headSha: requireHeadSha(pr.headRefOid, `PR #${request.value} head`),
    baseRef: pr.baseRefName,
  };
}

function resolveBranchTarget(request, runCommand) {
  const repo = resolveRepo(request.repo, runCommand);
  const result = runCommand("git", ["ls-remote", "origin", `refs/heads/${request.value}`]);
  const headSha = result.status === 0 ? result.stdout.split(/\s+/)[0] : null;
  return {
    targetKind: "branch",
    repo,
    prNumber: null,
    prUrl: null,
    prState: null,
    headRef: request.value,
    headSha: requireHeadSha(headSha, `branch ${request.value} remote head`),
    baseRef: "main",
  };
}

function resolveRangeEndpoint(revision, runCommand) {
  const result = runCommand("git", ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (result.status !== 0) {
    throw new ReviewTargetError(
      `Could not resolve range endpoint ${revision}: ${result.stderr || "git rev-parse failed"}.`,
    );
  }
  return requireHeadSha(result.stdout, `range endpoint ${revision}`);
}

function resolveRangeTarget(request, runCommand) {
  const [base, head] = request.value.split("..");
  if (!base || !head) {
    throw new ReviewTargetError(`--range must be <base>..<head>; received ${request.value}.`);
  }
  return {
    targetKind: "range",
    repo: request.repo ?? resolveRepo(null, runCommand),
    prNumber: null,
    prUrl: null,
    prState: null,
    headRef: head,
    headSha: resolveRangeEndpoint(head, runCommand),
    baseRef: resolveRangeEndpoint(base, runCommand),
  };
}

const RESOLVERS = {
  pr: resolvePullRequestTarget,
  branch: resolveBranchTarget,
  range: resolveRangeTarget,
};

export function resolveReviewTarget({ argv, runCommand = runCommandSync }) {
  const request = parseTargetArgs(argv);
  const target = RESOLVERS[request.kind](request, runCommand);
  return { ...target, diffRange: `${target.baseRef}...${target.headSha}`, json: request.json };
}

export function describeTarget(target) {
  const label = target.prNumber
    ? `PR #${target.prNumber}`
    : `${target.targetKind} ${target.headRef}`;
  return `${label} @ ${target.headSha}`;
}

export function buildForkBriefing(target) {
  return [
    "## REVIEW TARGET (inherited, non-negotiable)",
    "",
    `Repository: ${target.repo}`,
    `Target kind: ${target.targetKind}`,
    `PR number: ${target.prNumber ?? "none"}`,
    `PR URL: ${target.prUrl ?? "none"}`,
    `Head ref: ${target.headRef}`,
    `Head SHA: ${target.headSha}`,
    `Base ref: ${target.baseRef}`,
    `Diff range: ${target.diffRange}`,
    "",
    "You did not choose this target and you may not change it. Do not resolve a",
    "target from the working directory, the checked-out branch, `gh pr view`",
    "without an argument, or any other ambient session state; those are the",
    "SPL-256 defect. Fetch the head SHA above into a disposable checkout and",
    "review that diff only.",
    "",
    `If the head SHA above is not reachable, stop and report it. Do not review a`,
    "substitute revision.",
    "",
    `Your REVIEW REPORT must open with: Review target: ${describeTarget(target)}`,
  ].join("\n");
}

function main(argv) {
  const target = resolveReviewTarget({ argv });
  const { json, ...record } = target;
  process.stdout.write(
    json ? `${JSON.stringify(record, null, 2)}\n` : `${buildForkBriefing(record)}\n`,
  );
}

if (process.argv[1]?.endsWith("resolve-review-target.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof ReviewTargetError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
