#!/usr/bin/env node
/**
 * Request-contract skew gate. The Worker deploys continuously from main, but
 * the published @splitch/cli only moves on a manual release, so every request
 * the newest released CLI can send must stay acceptable at HEAD. The response
 * side already tolerates skew; this guards the request side.
 *
 * Released ref: the highest-semver `cli-v*` git tag (created by cli-release.yml
 * and checked out by cli-publish.yml), cross-checked against the version in
 * apps/cli/package.json at that tag. Git refs only, no npm calls.
 *
 * For every operationId in the released route registry it compares the JSON
 * Schema (zod v4 `z.toJSONSchema`, io "input") of the route's runtime input
 * `{ params, query, body }` at the release and at HEAD, and fails on:
 *   - route-removed / route-moved: the operation is gone or its method/path changed
 *   - required-added: a field required at HEAD was absent or optional in the release
 *   - field-removed: a field the release accepted is gone under a strict object
 *   - literal-removed / variant-removed: an enum, literal, or discriminated variant lost a value
 *   - type-narrowed: a union no longer accepts a primitive type, object, or array
 * It recurses through nested objects, arrays (`[]`), records (`*`), nullable
 * wrappers, and discriminated unions (paired by their const tag), to depth 12.
 *
 * Limits, honestly:
 *   - Only the newest tag is checked. Older CLIs still in use are not, and a
 *     draft release's tag counts once cli-release.yml pushes it, even unpublished.
 *   - Refinements, transforms, and cross-field rules (superRefine "owner is
 *     required when ...") are invisible to JSON Schema and are not checked.
 *   - Tightened string/number constraints (pattern, format, min/max, length,
 *     array size) are not checked.
 *   - Unions without a shared const discriminator are only compared by the
 *     kinds of value they accept, not member by member.
 *   - The release's contracts are evaluated with HEAD's installed zod and
 *     @hono/zod-openapi, and only routes in the shared registry are covered.
 *
 * Usage: node scripts/check-request-contract-compat.mjs [--released-ref <git-ref>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllowlist, diffRequestContracts } from "./lib/request-contract-diff.mjs";
import {
  extractContractsAt,
  headContractsSrc,
  loadRequestContractSnapshot,
} from "./lib/request-contract-snapshot.mjs";

const TAG_PREFIX = "cli-v";
const ALLOWLIST_PATH = "scripts/request-contract-compat-allowlist.json";
const LABEL = "request-contract-compat";

const REMEDIATION = `
Fix it with expand/contract, never by tightening the contract in one step:
  1. Expand: keep accepting what the released CLI sends. Make the new field
     optional and default it on the server (or keep the removed field/value
     accepted and ignore or map it).
  2. Release a CLI built from that contract (cli-release.yml), so the newest
     released client sends the new shape.
  3. Contract: only after that release is out, consider tightening the field.
     This gate then compares against the new tag and allows it.
If a break is truly intended (for example a route no client ever called), add
an entry with operationId, path, and a reviewed reason to ${ALLOWLIST_PATH}.`;

function git(args, repoRoot) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/u.exec(version);
  if (!match) return undefined;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index] - right.core[index];
    if (delta !== 0) return delta;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease, "en", { numeric: true });
}

/** The highest-semver `cli-v*` tag name, or undefined when none parse. */
export function latestCliTag(tagNames) {
  let latest;
  for (const tag of tagNames) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const version = parseVersion(tag.slice(TAG_PREFIX.length));
    if (version && (!latest || compareVersions(version, latest.version) > 0)) {
      latest = { tag, version };
    }
  }
  return latest?.tag;
}

function resolveReleasedRef(repoRoot) {
  const tags = git(["tag", "--list", `${TAG_PREFIX}*`], repoRoot)
    .split("\n")
    .filter(Boolean);
  const tag = latestCliTag(tags);
  if (!tag) {
    throw new Error(
      `no ${TAG_PREFIX}* tags found. CI must check out with fetch-depth: 0; locally run "git fetch --tags".`,
    );
  }
  const manifest = JSON.parse(git(["show", `${tag}:apps/cli/package.json`], repoRoot));
  if (`${TAG_PREFIX}${manifest.version}` !== tag) {
    throw new Error(`${tag} points at apps/cli/package.json version ${manifest.version}`);
  }
  return tag;
}

function readAllowlist(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, ALLOWLIST_PATH), "utf8"));
}

function formatViolation({ operationId, path, rule, message }) {
  return `  ${operationId} ${path} [${rule}] ${message}`;
}

function parseArgs(argv) {
  const index = argv.indexOf("--released-ref");
  if (index === -1) return {};
  const ref = argv[index + 1];
  if (!ref) throw new Error("--released-ref needs a git ref");
  return { releasedRef: ref };
}

async function main() {
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const { releasedRef } = parseArgs(process.argv.slice(2));
  const ref = releasedRef ?? resolveReleasedRef(repoRoot);
  const commit = git(["rev-parse", "--short", `${ref}^{commit}`], repoRoot);
  const source = releasedRef ? "an explicit --released-ref" : "the newest released CLI tag";
  console.log(`${LABEL}: comparing HEAD request contracts against ${ref} (${commit}), ${source}`);

  const extracted = extractContractsAt({ repoRoot, ref });
  let released;
  try {
    released = await loadRequestContractSnapshot({ repoRoot, srcDir: extracted.srcDir });
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true });
  }
  const head = await loadRequestContractSnapshot({ repoRoot, srcDir: headContractsSrc(repoRoot) });
  const result = applyAllowlist(diffRequestContracts(released, head), readAllowlist(repoRoot));

  for (const violation of result.excused) {
    console.log(`${LABEL}: allowlisted ${violation.operationId} ${violation.path}`);
  }
  const failures = [];
  if (result.problems.length > 0) {
    failures.push(
      `${ALLOWLIST_PATH} is malformed:\n${result.problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
  if (result.stale.length > 0) {
    const lines = result.stale.map((entry) => `  ${entry.operationId} ${entry.path}`);
    failures.push(
      `${ALLOWLIST_PATH} has entries that match no violation; delete them:\n${lines.join("\n")}`,
    );
  }
  if (result.failing.length > 0) {
    failures.push(
      `HEAD would refuse requests the released CLI (${ref}) can send:\n${result.failing.map(formatViolation).join("\n")}\n${REMEDIATION}`,
    );
  }
  if (failures.length > 0) {
    console.error(`${LABEL}: FAILED\n${failures.join("\n\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${LABEL}: ok, ${Object.keys(released).length} released operations still accept their requests at HEAD`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${LABEL}: ${error.message}`);
    process.exitCode = 1;
  });
}
