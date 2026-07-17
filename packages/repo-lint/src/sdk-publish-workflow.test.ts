import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkPublishedVersion } = await import(
  pathToFileURL(path.join(repoRoot, "scripts/sdk-release/check-published-version.mjs")).href
);
const { validatePublishContext } = await import(
  pathToFileURL(path.join(repoRoot, "scripts/sdk-release/validate-publish-context.mjs")).href
);
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/sdk-publish.yml"), "utf8");
const publishedVersionChecker = readFileSync(
  path.join(repoRoot, "scripts/sdk-release/check-published-version.mjs"),
  "utf8",
);
const publishContextValidator = readFileSync(
  path.join(repoRoot, "scripts/sdk-release/validate-publish-context.mjs"),
  "utf8",
);
const sdkManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/sdk/package.json"), "utf8"),
) as {
  repository?: { url?: string; directory?: string };
};

describe("sdk-publish workflow contract", () => {
  it("runs only for published GitHub Releases in the SDK tag namespace", () => {
    expect(workflow).toMatch(/^on:\n {2}release:\n {4}types: \[published\]/m);
    expect(workflow).toContain("if: startsWith(github.event.release.tag_name, 'sdk-v')");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+workflow_dispatch:/m);
  });

  it("uses GitHub-hosted infrastructure and OIDC without npm tokens", () => {
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).not.toContain("blacksmith-");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("publishes the first SDK version with provenance and latest", () => {
    expect(workflow).toContain("npm publish --provenance --access public --tag latest");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("@splitch/sdk");
    expect(workflow).toContain("npm dist-tag: latest");
  });

  it("validates the release tag, source commit, and repository visibility", () => {
    expect(workflow).toContain("ref: ${{" + " github.event.release.tag_name }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("validate-publish-context.mjs");
    expect(workflow).toContain("RELEASE_TARGET_COMMITISH");
    expect(workflow).toContain("REPOSITORY_PRIVATE");
    expect(workflow).toContain("repository.private=$REPOSITORY_PRIVATE");
    expect(workflow).toContain("github.sha");
    expect(publishContextValidator).toContain("release target commitish must be a full commit SHA");
  });

  it("skips an exact immutable npm version and logs the decision", () => {
    expect(workflow).toContain("check-published-version.mjs");
    expect(publishedVersionChecker).toContain('"npm",');
    expect(publishedVersionChecker).toContain('["view",');
    expect(workflow).toContain("already_published=$already_published");
    expect(workflow).toContain("skip-already-published");
    expect(workflow).toContain("Decision: ");
    expect(workflow).toContain("Runner: ubuntu-24.04 (GitHub-hosted)");
  });
});

describe("SDK trusted-publish validation behavior", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
  const environment = {
    REPOSITORY_PRIVATE: "false",
    RELEASE_TAG: "sdk-v0.1.0",
    RELEASE_TARGET_COMMITISH: commit,
    GITHUB_REF: "refs/tags/sdk-v0.1.0",
    GITHUB_SHA: commit,
  };
  const resolveCommit = (ref: string) => {
    if (ref === "refs/tags/sdk-v0.1.0" || ref === "HEAD" || ref === commit) {
      return commit;
    }
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return otherCommit;
    }
    throw new Error(`unexpected ref ${ref}`);
  };

  it("requires the release target commitish to resolve to the immutable tag commit", () => {
    expect(validatePublishContext(repoRoot, environment, resolveCommit)).toMatchObject({
      packageName: "@splitch/sdk",
      version: "0.1.0",
      releaseTag: "sdk-v0.1.0",
      tagSha: commit,
    });

    expect(() =>
      validatePublishContext(
        repoRoot,
        { ...environment, RELEASE_TARGET_COMMITISH: "main" },
        resolveCommit,
      ),
    ).toThrow("release target commitish must be a full commit SHA");

    expect(() =>
      validatePublishContext(
        repoRoot,
        {
          ...environment,
          RELEASE_TARGET_COMMITISH: otherCommit,
        },
        resolveCommit,
      ),
    ).toThrow("differs from release tag commit");

    expect(() =>
      validatePublishContext(
        repoRoot,
        { ...environment, REPOSITORY_PRIVATE: "true" },
        resolveCommit,
      ),
    ).toThrow("refusing SDK trusted publishing");

    expect(() =>
      validatePublishContext(
        repoRoot,
        { ...environment, RELEASE_TAG: "sdk-v0.2.0" },
        resolveCommit,
      ),
    ).toThrow("does not match expected SDK tag");
  });
});

describe("SDK exact-version publication check", () => {
  it("returns true only for the exact immutable npm version", () => {
    expect(
      checkPublishedVersion({
        version: "0.1.0",
        run: () => ({ status: 0, stdout: '"0.1.0"\n', stderr: "" }),
      }),
    ).toBe(true);

    expect(
      checkPublishedVersion({
        version: "0.1.0",
        run: () => ({ status: 1, stdout: "", stderr: "npm ERR! code E404" }),
      }),
    ).toBe(false);

    expect(() =>
      checkPublishedVersion({
        version: "0.1.0",
        run: () => ({ status: 0, stdout: '"0.1.1"\n', stderr: "" }),
      }),
    ).toThrow("refusing an ambiguous result");
  });
});

describe("SDK trusted publisher package identity", () => {
  it("declares the GitHub repository and SDK package directory", () => {
    expect(sdkManifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/zaks-io/splitch.git",
      directory: "packages/sdk",
    });
  });
});
