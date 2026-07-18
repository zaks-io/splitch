#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSdkReleaseTarget } from "./resolve-version.mjs";

const repoRoot = process.argv[2] ?? process.cwd();

function requiredEnv(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for SDK trusted publishing`);
  }
  return value;
}

function isCommitSha(value) {
  return /^[0-9a-f]{40}$/.test(value);
}

function currentHead(repoRoot) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function remotePeeledTagCommit(repoRoot, tag) {
  const output = execFileSync("git", ["ls-remote", "origin", `refs/tags/${tag}^{}`], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const [sha, ref] = output.split("\t");
  if (!isCommitSha(sha) || ref !== `refs/tags/${tag}^{}`) {
    throw new Error(`remote tag ${tag} has no immutable peeled commit`);
  }
  return sha;
}

async function fetchJson(fetcher, url, token) {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `GitHub API returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} environment
 * @param {{ fetcher?: typeof fetch; head?: () => string; peeledTag?: (tag: string) => string }} [options]
 */
export async function validateLivePublishState(
  repoRoot,
  environment = process.env,
  {
    fetcher = fetch,
    head = () => currentHead(repoRoot),
    peeledTag = (tag) => remotePeeledTagCommit(repoRoot, tag),
  } = {},
) {
  const githubSha = requiredEnv(environment, "GITHUB_SHA");
  const repository = requiredEnv(environment, "GITHUB_REPOSITORY");
  const token = requiredEnv(environment, "GITHUB_TOKEN");
  const releaseTag = requiredEnv(environment, "RELEASE_TAG");
  const apiUrl = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const target = resolveSdkReleaseTarget(repoRoot);

  if (!isCommitSha(githubSha)) {
    throw new Error(`GITHUB_SHA must be a full commit SHA; found ${githubSha}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo; found ${repository}`);
  }
  if (releaseTag !== target.tag) {
    throw new Error(`release tag ${releaseTag} does not match expected SDK tag ${target.tag}`);
  }

  const repositoryUrl = `${apiUrl}/repos/${repository}`;
  const releaseUrl = `${repositoryUrl}/releases/tags/${encodeURIComponent(releaseTag)}`;
  const [liveRepository, liveRelease] = await Promise.all([
    fetchJson(fetcher, repositoryUrl, token),
    fetchJson(fetcher, releaseUrl, token),
  ]);

  if (liveRepository.private !== false || liveRepository.visibility !== "public") {
    throw new Error(
      "refusing SDK trusted publishing for a repository that is not publicly visible",
    );
  }
  if (
    liveRelease.tag_name !== releaseTag ||
    liveRelease.draft !== false ||
    liveRelease.prerelease !== false ||
    liveRelease.immutable !== true ||
    !liveRelease.published_at
  ) {
    throw new Error(
      `live GitHub Release metadata is not a published immutable release for ${releaseTag}`,
    );
  }
  if (!isCommitSha(liveRelease.target_commitish)) {
    throw new Error(
      `live GitHub Release target commitish must be a full commit SHA; found ${liveRelease.target_commitish}`,
    );
  }

  const headSha = head();
  const remotePeeledSha = peeledTag(releaseTag);
  const shas = {
    GITHUB_SHA: githubSha,
    HEAD: headSha,
    release_target_commitish: liveRelease.target_commitish,
    remote_peeled_tag: remotePeeledSha,
  };
  if (!Object.values(shas).every((sha) => sha === githubSha)) {
    throw new Error(`live release source SHAs disagree: ${JSON.stringify(shas)}`);
  }

  return { ...shas, repository: repository, visibility: liveRepository.visibility, releaseTag };
}

async function main() {
  const result = await validateLivePublishState(repoRoot);
  console.log(`repository=${result.repository}`);
  console.log(`repository_visibility=${result.visibility}`);
  console.log(`release_tag=${result.releaseTag}`);
  console.log(`github_sha=${result.GITHUB_SHA}`);
  console.log(`head_sha=${result.HEAD}`);
  console.log(`release_target_commitish=${result.release_target_commitish}`);
  console.log(`remote_peeled_tag=${result.remote_peeled_tag}`);
  console.log("live_publish_state_validation=passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
