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
 *   - route-removed / route-moved: the operation is gone or its method or URL
 *     shape changed (a path param rename is compatible; params pair by position)
 *   - required-added: a field required at HEAD was absent or optional in the
 *     release, or the Idempotency-Key header became required
 *   - field-removed: a field (or a record's arbitrary keys) the release accepted
 *     is rejected by a strict object at HEAD
 *   - literal-removed / variant-removed: an enum, literal, or discriminated variant lost a value
 *   - type-narrowed: a union no longer accepts a primitive type, object, or
 *     array, or a field that accepted any value is now constrained
 *   - unsupported-schema: allOf/$ref/not/if appeared, which the diff cannot reason about
 * It recurses through nested objects, arrays (`[]`), records (`*` values,
 * `(key)` names), nullable wrappers, and unions, to depth 12. Each released
 * object variant is compared with its closest HEAD object variant, matched by
 * discriminator tag when the released union has one.
 *
 * Limits, honestly:
 *   - Only the newest tag is checked. Older CLIs still in use are not, and a
 *     draft release's tag counts once cli-release.yml pushes it, even unpublished.
 *   - Refinements, transforms, and cross-field rules (superRefine "owner is
 *     required when ...") are invisible to JSON Schema and are not checked.
 *   - Tightened string/number constraints (pattern, format, min/max, length,
 *     array size) are not checked. Of the headers, only Idempotency-Key is.
 *   - Primitive union members are compared by type only, and arrays only when
 *     both sides have exactly one array member.
 *   - The release's contracts are evaluated with HEAD's installed zod and
 *     @hono/zod-openapi, and only routes in the shared registry are covered.
 *
 * Usage: node scripts/check-request-contract-compat.mjs [--released-ref <git-ref>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllowlist } from "./lib/request-contract-allowlist.mjs";
import { diffRequestContracts } from "./lib/request-contract-diff.mjs";
import {
  extractContractsAt,
  headContractsSrc,
  loadRequestContractSnapshot,
} from "./lib/request-contract-snapshot.mjs";
import { RELEASE_SEMVER_PATTERN } from "./release/resolve-version.mjs";

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
an entry { operationId, path, releasedTag, reason } to ${ALLOWLIST_PATH}.`;

function git(args, repoRoot) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Parse a release version as cli-release.yml accepts it; build metadata is ignored. */
function parseVersion(tag) {
  const version = tag.slice(TAG_PREFIX.length);
  if (!RELEASE_SEMVER_PATTERN.test(version)) {
    throw new Error(`${tag} is not a release semver tag; fix or delete it`);
  }
  const [, major, minor, patch, suffix] = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version);
  const prerelease = suffix.split("+")[0].replace(/^-/u, "");
  return { core: [major, minor, patch].map(Number), prerelease: prerelease || undefined };
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

/** The highest-semver `cli-v*` tag name; throws on a `cli-v*` tag it cannot order. */
export function latestCliTag(tagNames) {
  let latest;
  for (const tag of tagNames) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const version = parseVersion(tag);
    if (!latest || compareVersions(version, latest.version) > 0) latest = { tag, version };
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

function parseArgs(argv) {
  const index = argv.indexOf("--released-ref");
  if (index === -1) return {};
  const ref = argv[index + 1];
  if (!ref) throw new Error("--released-ref needs a git ref");
  return { releasedRef: ref };
}

async function loadReleasedSnapshot(repoRoot, ref) {
  const extracted = extractContractsAt({ repoRoot, ref });
  try {
    return await loadRequestContractSnapshot({ repoRoot, srcDir: extracted.srcDir });
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true });
  }
}

const listEntries = (entries) =>
  entries.map((entry) => `  ${entry.operationId} ${entry.path} (${entry.releasedTag})`).join("\n");

function collectFailures(result, ref) {
  const failures = [];
  if (result.problems.length > 0) {
    const lines = result.problems.map((problem) => `  ${problem}`).join("\n");
    failures.push(`${ALLOWLIST_PATH} is malformed:\n${lines}`);
  }
  if (result.stale.length > 0) {
    failures.push(
      `${ALLOWLIST_PATH} has ${ref} entries that match no violation; delete them:\n${listEntries(result.stale)}`,
    );
  }
  if (result.failing.length > 0) {
    const lines = result.failing
      .map(
        ({ operationId, path, rule, message }) => `  ${operationId} ${path} [${rule}] ${message}`,
      )
      .join("\n");
    failures.push(
      `HEAD would refuse requests the released CLI (${ref}) can send:\n${lines}\n${REMEDIATION}`,
    );
  }
  return failures;
}

async function main() {
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const { releasedRef } = parseArgs(process.argv.slice(2));
  const ref = releasedRef ?? resolveReleasedRef(repoRoot);
  const commit = git(["rev-parse", "--short", `${ref}^{commit}`], repoRoot);
  const source = releasedRef ? "an explicit --released-ref" : "the newest released CLI tag";
  console.log(`${LABEL}: comparing HEAD request contracts against ${ref} (${commit}), ${source}`);

  const released = await loadReleasedSnapshot(repoRoot, ref);
  const head = await loadRequestContractSnapshot({ repoRoot, srcDir: headContractsSrc(repoRoot) });
  const allowlist = JSON.parse(readFileSync(join(repoRoot, ALLOWLIST_PATH), "utf8"));
  const result = applyAllowlist(diffRequestContracts(released, head), allowlist, ref);

  for (const violation of result.excused) {
    console.log(`${LABEL}: allowlisted ${violation.operationId} ${violation.path}`);
  }
  if (result.expired.length > 0) {
    console.warn(
      `${LABEL}: ${ALLOWLIST_PATH} entries written for another release no longer apply; delete them:\n${listEntries(result.expired)}`,
    );
  }
  const failures = collectFailures(result, ref);
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
