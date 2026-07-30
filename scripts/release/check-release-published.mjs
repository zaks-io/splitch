#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { getReleaseTarget } from "./constants.mjs";
import { resolveReleaseTarget } from "./resolve-version.mjs";

/**
 * True when the target's tag already has a non-draft GitHub Release. Draft
 * releases are invisible to the by-tag endpoint, so a pending draft resolves
 * to false and the normal draft-update path proceeds.
 *
 * @param {{ tag: string, repository: string, token: string, apiUrl?: string, fetchImpl?: typeof fetch }} options
 */
export async function isReleasePublished({
  tag,
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!tag || !repository || !token) {
    throw new Error("isReleasePublished requires tag, repository, and token");
  }
  const response = await fetchImpl(
    `${apiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`GitHub release lookup for ${tag} failed with HTTP ${response.status}`);
  }
  const release = await response.json();
  return release.draft !== true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetKey = process.argv[2];
  getReleaseTarget(targetKey);
  const repoRoot = process.argv[3] ?? process.cwd();
  const target = resolveReleaseTarget(targetKey, repoRoot);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GH_TOKEN (or GITHUB_TOKEN) are required");
  }
  const published = await isReleasePublished({
    tag: target.tag,
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL || undefined,
  });
  process.stdout.write(`${published}\n`);
}
