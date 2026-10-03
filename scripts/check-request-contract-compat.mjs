#!/usr/bin/env node
/**
 * Request-contract skew gate. The Worker deploys continuously from main, but
 * the published @splitch/cli only moves on a manual release, so every request
 * the newest released CLI can send must stay acceptable at HEAD. The response
 * side already tolerates skew; this guards the request side.
 *
 * Released ref: the highest-SemVer `cli-v*` git tag whose GitHub Release is
 * published (non-draft), cross-checked against apps/cli/package.json at that
 * tag. cli-release.yml pushes the tag while the release is still a draft and
 * cli-publish.yml only ships to npm on publication, so the newest tag alone can
 * be ahead of what users run. Publication is read from the GitHub Releases API
 * with GH_TOKEN (CI passes the read-only workflow token); there is no offline
 * fallback, and no npm calls. A published release whose npm publish then failed
 * still counts, which only makes the baseline newer than what users run.
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
 *   - Only the newest published release is checked. Older CLIs still in use are not.
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
import { githubPublicationLookup, newestPublishedCliTag } from "./lib/released-cli-tag.mjs";

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

async function resolveReleasedRef(repoRoot) {
  const tags = git(["tag", "--list", `${TAG_PREFIX}*`], repoRoot)
    .split("\n")
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error(
      `no ${TAG_PREFIX}* tags found. CI must check out with fetch-depth: 0; locally run "git fetch --tags".`,
    );
  }
  const isPublished = githubPublicationLookup({
    env: process.env,
    originUrl: () => git(["remote", "get-url", "origin"], repoRoot),
  });
  const tag = await newestPublishedCliTag(tags, isPublished);
  if (!tag) {
    throw new Error(`none of the local ${TAG_PREFIX}* tags has a published GitHub Release`);
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
  const ref = releasedRef ?? (await resolveReleasedRef(repoRoot));
  const commit = git(["rev-parse", "--short", `${ref}^{commit}`], repoRoot);
  const source = releasedRef ? "an explicit --released-ref" : "the newest published CLI release";
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
