import { NPM_REGISTRY } from "../release/check-published-version.mjs";
import { getReleaseTarget } from "../release/constants.mjs";
import { RELEASE_SEMVER_PATTERN } from "../release/resolve-version.mjs";

const TAG_PREFIX = "cli-v";
const NUMERIC_IDENTIFIER = /^\d+$/u;
const REGISTRY_TIMEOUT_MS = 15_000;

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
 * The newest `cli-v*` tag whose version users can actually install. A tag
 * exists from the draft stage of cli-release.yml, and even a published GitHub
 * Release precedes cli-publish.yml, which can still fail before npm publish;
 * only the registry says which CLI is in the wild.
 */
export function newestCliTagOnNpm(tagNames, npmVersions) {
  const cliTags = tagNames.filter((tag) => tag.startsWith(TAG_PREFIX));
  const chosen = cliTags
    .sort((left, right) => compareCliTags(right, left))
    .find((tag) => npmVersions.has(npmVersionOf(tag)));
  if (!chosen) return undefined;
  // npm drops build metadata, so cli-v1.0.0+a and cli-v1.0.0+b both read as
  // 1.0.0 and the registry cannot say which one's contracts were shipped.
  const sameVersion = cliTags.filter((tag) => npmVersionOf(tag) === npmVersionOf(chosen));
  if (sameVersion.length > 1) {
    throw new Error(
      `npm version ${npmVersionOf(chosen)} matches several tags (${sameVersion.join(", ")}); delete the ones that were never published`,
    );
  }
  return chosen;
}

function npmVersionOf(tag) {
  return tag.slice(TAG_PREFIX.length).split("+")[0];
}

/**
 * Every version of the CLI on the public npm registry. No auth and no
 * fallback: a network error, a non-200, or a stalled request or body read
 * (one deadline covers both) fails the gate rather than guessing.
 */
export async function fetchNpmCliVersions(fetchImpl = fetch, timeoutMs = REGISTRY_TIMEOUT_MS) {
  const { packageName } = getReleaseTarget("cli");
  const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let status;
  let body;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal,
    });
    status = response.status;
    if (status === 200) body = await response.json();
  } catch (error) {
    const reason = signal.aborted ? `timed out after ${timeoutMs}ms` : `failed: ${error.message}`;
    throw new Error(`npm registry lookup ${url} ${reason}`);
  }
  if (status !== 200) {
    throw new Error(`npm registry lookup ${url} returned HTTP ${status}`);
  }
  if (!body?.versions || typeof body.versions !== "object") {
    throw new Error(`npm registry lookup ${url} returned no versions`);
  }
  return new Set(Object.keys(body.versions));
}
