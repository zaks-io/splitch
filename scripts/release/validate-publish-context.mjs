#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveReleaseTarget } from "./resolve-version.mjs";

const targetKey = process.argv[2];
const repoRoot = process.argv[3] ?? process.cwd();

function requiredEnv(environment, name, releaseTargetKey) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for ${releaseTargetKey.toUpperCase()} trusted publishing`);
  }
  return value;
}

function resolveCommit(repoRoot, ref) {
  return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

/**
 * @param {string} repoRoot
 * @param {string} releaseTargetKey
 * @param {Record<string, string | undefined>} environment
 * @param {(ref: string) => string} [resolveCommitForRef]
 */
export function validatePublishContext(
  releaseTargetKey,
  repoRoot,
  environment = process.env,
  resolveCommitForRef = (ref) => resolveCommit(repoRoot, ref),
) {
  const targetLabel = releaseTargetKey.toUpperCase();
  const repositoryPrivate = requiredEnv(environment, "REPOSITORY_PRIVATE", releaseTargetKey);
  if (repositoryPrivate !== "false") {
    throw new Error(
      `refusing ${targetLabel} trusted publishing for repository.private=${repositoryPrivate}`,
    );
  }

  const releaseTag = requiredEnv(environment, "RELEASE_TAG", releaseTargetKey);
  const releaseTargetCommitish = requiredEnv(
    environment,
    "RELEASE_TARGET_COMMITISH",
    releaseTargetKey,
  );
  const githubRef = requiredEnv(environment, "GITHUB_REF", releaseTargetKey);
  const githubSha = requiredEnv(environment, "GITHUB_SHA", releaseTargetKey);
  const target = resolveReleaseTarget(releaseTargetKey, repoRoot);
  const expectedRef = `refs/tags/${releaseTag}`;

  if (releaseTag !== target.tag) {
    throw new Error(
      `release tag ${releaseTag} does not match expected ${targetLabel} tag ${target.tag}`,
    );
  }
  if (githubRef !== expectedRef) {
    throw new Error(`GITHUB_REF ${githubRef} does not match release tag ref ${expectedRef}`);
  }
  if (!/^[0-9a-f]{40}$/.test(githubSha)) {
    throw new Error(`GITHUB_SHA must be a full commit SHA; found ${githubSha}`);
  }
  if (!/^[0-9a-f]{40}$/.test(releaseTargetCommitish)) {
    throw new Error(
      `release target commitish must be a full commit SHA; found ${releaseTargetCommitish}`,
    );
  }

  const tagSha = resolveCommitForRef(`refs/tags/${releaseTag}`);
  const checkedOutSha = resolveCommitForRef("HEAD");
  const targetSha = resolveCommitForRef(releaseTargetCommitish);
  if (tagSha !== checkedOutSha) {
    throw new Error(
      `checked out commit ${checkedOutSha} differs from release tag commit ${tagSha}`,
    );
  }
  if (githubSha !== checkedOutSha) {
    throw new Error(`GITHUB_SHA ${githubSha} differs from checked out commit ${checkedOutSha}`);
  }
  if (targetSha !== tagSha) {
    throw new Error(`release target commit ${targetSha} differs from release tag commit ${tagSha}`);
  }

  return {
    packageName: target.packageName,
    version: target.version,
    releaseTag,
    releaseTargetCommitish,
    tagSha,
    checkedOutSha,
    githubSha,
  };
}

function main() {
  const result = validatePublishContext(targetKey, repoRoot);
  console.log(`package=${result.packageName}`);
  console.log(`version=${result.version}`);
  console.log(`tag=${result.releaseTag}`);
  console.log(`release_target_commitish=${result.releaseTargetCommitish}`);
  console.log(`release_tag_commit=${result.tagSha}`);
  console.log(`checked_out_commit=${result.checkedOutSha}`);
  console.log(`github_sha=${result.githubSha}`);
  console.log("source_commit_validation=passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
