import { isReleasePublished } from "../release/check-release-published.mjs";
import { RELEASE_SEMVER_PATTERN } from "../release/resolve-version.mjs";

const TAG_PREFIX = "cli-v";
const NUMERIC_IDENTIFIER = /^\d+$/u;

/** Parse a `cli-v*` tag as cli-release.yml accepts its version; build metadata is ignored. */
function parseCliTag(tag) {
  const version = tag.slice(TAG_PREFIX.length);
  if (!RELEASE_SEMVER_PATTERN.test(version)) {
    throw new Error(`${tag} is not a release semver tag; fix or delete it`);
  }
  const [, major, minor, patch, suffix] = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version);
  const prerelease = suffix.split("+")[0].replace(/^-/u, "");
  return {
    core: [major, minor, patch].map(Number),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

/** SemVer 2.0.0 section 11 precedence for one pair of prerelease identifiers. */
function compareIdentifiers(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** SemVer precedence: a release outranks its prereleases, compared identifier by identifier. */
export function compareCliTags(leftTag, rightTag) {
  const left = parseCliTag(leftTag);
  const right = parseCliTag(rightTag);
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index] - right.core[index];
    if (delta !== 0) return delta;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const delta = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (delta !== 0) return delta;
  }
  return left.prerelease.length - right.prerelease.length;
}

/**
 * The newest `cli-v*` tag whose GitHub Release is published. cli-release.yml
 * pushes the tag while the release is still a draft, and npm only receives the
 * CLI when cli-publish.yml runs on publication, so a draft's tag must never
 * become the baseline the published CLI is judged against.
 */
export async function newestPublishedCliTag(tagNames, isPublished) {
  const newestFirst = tagNames
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .sort((left, right) => compareCliTags(right, left));
  for (const tag of newestFirst) {
    if (await isPublished(tag)) return tag;
  }
  return undefined;
}

function repositoryFromRemote(remoteUrl) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remoteUrl);
  if (!match) throw new Error(`cannot derive owner/repo from remote ${remoteUrl}`);
  return match[1];
}

/**
 * Publication lookup against the GitHub Releases API. There is no offline
 * fallback: without a token the gate cannot tell a published CLI from a draft.
 */
export function githubPublicationLookup({ env, originUrl }) {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GH_TOKEN (or GITHUB_TOKEN) is required to find the newest published CLI release; locally run "GH_TOKEN=$(gh auth token) pnpm check:request-contract-compat"',
    );
  }
  const repository = env.GITHUB_REPOSITORY || repositoryFromRemote(originUrl());
  return (tag) =>
    isReleasePublished({ tag, repository, token, apiUrl: env.GITHUB_API_URL || undefined });
}
