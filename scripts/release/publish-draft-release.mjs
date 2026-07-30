#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getReleaseTarget } from "./constants.mjs";
import { resolveReleaseTarget } from "./resolve-version.mjs";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

// This script's stdout is a machine contract: the workflow captures it and
// pipes it to jq. Child stdout (gh prints release URLs there) must go to
// stderr so only the final JSON line lands on stdout.
function runInherit(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: ["ignore", 2, "inherit"],
    ...options,
  });
}

/**
 * @returns {{ exists: false } | { exists: true; isDraft: boolean; url?: string }}
 */
function inspectExistingRelease(tag) {
  try {
    const output = run("gh", ["release", "view", tag, "--json", "isDraft,url,tagName"]);
    const release = JSON.parse(output);
    return {
      exists: true,
      isDraft: release.isDraft === true,
      url: typeof release.url === "string" ? release.url : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("release not found") || message.includes("Not Found")) {
      return { exists: false };
    }
    throw error;
  }
}

const targetKey = process.argv[2];
getReleaseTarget(targetKey);
const targetLabel = targetKey.toUpperCase();
const repoRoot = process.argv[3] ?? process.cwd();
const outputDir = process.argv[4] ?? join(repoRoot, `.${targetKey}-release-artifacts`);
const commitSha = process.argv[5] ?? process.env.GITHUB_SHA;

if (!commitSha) {
  throw new Error(`commit SHA is required to create or update the draft ${targetLabel} release`);
}

const target = resolveReleaseTarget(targetKey, repoRoot);
const releaseManifest = JSON.parse(readFileSync(join(outputDir, "release-manifest.json"), "utf8"));
const existing = inspectExistingRelease(target.tag);

if (existing.exists && !existing.isDraft) {
  throw new Error(
    `Refusing to mutate published GitHub Release ${target.tag}; draft-only updates are allowed`,
  );
}

runInherit("git", ["config", "user.name", "github-actions[bot]"]);
runInherit("git", [
  "config",
  "user.email",
  "41898282+github-actions[bot]@users.noreply.github.com",
]);
runInherit("git", [
  "tag",
  "-fa",
  target.tag,
  commitSha,
  "-m",
  `${target.packageName}@${target.version}`,
]);
runInherit("git", ["push", "origin", `refs/tags/${target.tag}`, "--force"]);

const releaseTitle = `${target.packageName}@${target.version}`;
const releaseNotes = [
  `Draft ${targetLabel} release for \`${target.packageName}@${target.version}\`.`,
  "",
  `- Tag: \`${target.tag}\``,
  `- Commit: \`${commitSha}\``,
  `- Tarball: \`${releaseManifest.tarballName}\``,
  `- SHA-256: \`${releaseManifest.sha256}\``,
  "",
  `This draft was prepared by the manual \`${targetKey}-release\` workflow. Publishing the GitHub Release is handled by a separate trusted-publish workflow.`,
].join("\n");

if (!existing.exists) {
  runInherit("gh", [
    "release",
    "create",
    target.tag,
    "--draft",
    "--title",
    releaseTitle,
    "--notes",
    releaseNotes,
    "--target",
    commitSha,
  ]);
} else {
  runInherit("gh", [
    "release",
    "edit",
    target.tag,
    "--draft",
    "--title",
    releaseTitle,
    "--notes",
    releaseNotes,
    "--target",
    commitSha,
  ]);
}

const uploadFiles = releaseManifest.artifactFiles
  .map((fileName) => join(outputDir, fileName))
  .filter((filePath) => {
    try {
      readFileSync(filePath);
      return true;
    } catch {
      return false;
    }
  });

if (uploadFiles.length > 0) {
  runInherit("gh", ["release", "upload", target.tag, "--clobber", ...uploadFiles]);
}

const releaseUrl = run("gh", ["release", "view", target.tag, "--json", "url"]).trim();
const parsed = JSON.parse(releaseUrl);
process.stdout.write(
  `${JSON.stringify({
    tag: target.tag,
    version: target.version,
    commitSha,
    draft: true,
    url: parsed.url,
    updatedExistingDraft: existing.exists,
  })}\n`,
);
