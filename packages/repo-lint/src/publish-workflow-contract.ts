import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkPublishedVersion } = await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/check-published-version.mjs")).href
);
const { validatePublishContext } = await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/validate-publish-context.mjs")).href
);
const { validateLivePublishState } = await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/validate-live-publish-state.mjs")).href
);

interface PublishContractOptions {
  targetKey: "sdk" | "cli";
  label: "SDK" | "CLI";
  packageName: "@splitch/sdk" | "@splitch/cli";
  packageDir: "packages/sdk" | "apps/cli";
  tag: "sdk-v0.1.0" | "cli-v0.1.0";
  workflowName: "sdk-publish.yml" | "cli-publish.yml";
}

export function registerPublishWorkflowContract(options: PublishContractOptions): void {
  const workflow = readFileSync(
    path.join(repoRoot, `.github/workflows/${options.workflowName}`),
    "utf8",
  );
  const packageManifest = JSON.parse(
    readFileSync(path.join(repoRoot, options.packageDir, "package.json"), "utf8"),
  ) as { repository?: { url?: string; directory?: string } };

  describe(`${options.targetKey}-publish workflow contract`, () => {
    it(`runs only for published GitHub Releases in the ${options.label} tag namespace`, () => {
      expect(workflow).toMatch(/^on:\n {2}release:\n {4}types: \[published\]/m);
      expect(workflow).toContain(
        `if: startsWith(github.event.release.tag_name, '${options.targetKey}-v')`,
      );
      expect(workflow).not.toMatch(/^\s+(push|workflow_dispatch):/m);
    });

    it("uses GitHub-hosted infrastructure and OIDC without npm tokens", () => {
      expect(workflow).toContain("runs-on: ubuntu-24.04");
      expect(workflow).not.toContain("blacksmith-");
      expect(workflow).toContain("contents: read");
      expect(workflow).toContain("id-token: write");
      expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    });

    it(`publishes ${options.packageName} with provenance and latest`, () => {
      expect(workflow).toContain("npm publish --provenance --access public --tag latest");
      expect(workflow).toContain("registry-url: https://registry.npmjs.org");
      expect(workflow).toContain("package-manager-cache: false");
      expect(workflow).toContain(options.packageName);
      expect(workflow).toContain(`working-directory: ${options.packageDir}`);
      expect(workflow).toContain("npm dist-tag: latest");
    });

    it("validates the release tag, source commit, and repository visibility", () => {
      expect(workflow).toContain("ref: ${{" + " github.event.release.tag_name }}");
      expect(workflow).toContain("fetch-depth: 0");
      expect(workflow).toContain(`validate-publish-context.mjs ${options.targetKey}`);
      expect(workflow).toContain("RELEASE_TARGET_COMMITISH");
      expect(workflow).toContain("Refresh live release state before npm version check");
      expect(workflow).toContain(`validate-live-publish-state.mjs ${options.targetKey}`);
      expect(workflow).toContain("GITHUB_TOKEN: ${{" + " github.token }}");
      expect(workflow).toContain("github.sha");
    });

    it("validates live release metadata before any npm-version skip", () => {
      const liveValidation = workflow.indexOf(
        "      - name: Refresh live release state before npm version check",
      );
      const npmVersionCheck = workflow.indexOf(
        `      - name: Check whether ${options.label} version is already published`,
      );
      expect(liveValidation).toBeGreaterThan(-1);
      expect(npmVersionCheck).toBeGreaterThan(liveValidation);
      expect(workflow.slice(liveValidation, npmVersionCheck)).not.toContain("if:");
      expect(workflow.slice(npmVersionCheck)).toContain(
        "if: steps.npm-version.outputs.already_published != 'true'",
      );
    });

    it("skips an exact immutable npm version and logs the decision", () => {
      expect(workflow).toContain(`check-published-version.mjs" ${options.targetKey}`);
      expect(workflow).toContain("already_published=$already_published");
      expect(workflow).toContain("skip-already-published");
      expect(workflow).toContain("Decision: ");
      expect(workflow).toContain("Runner: ubuntu-24.04 (GitHub-hosted)");
    });

    it("declares the trusted-publisher package identity", () => {
      expect(packageManifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/zaks-io/splitch.git",
        directory: options.packageDir,
      });
    });
  });

  registerLiveStateTests(options);
  registerContextTests(options);
  registerPublishedVersionTests(options);
}

function registerLiveStateTests(options: PublishContractOptions): void {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const environment = {
    GITHUB_SHA: commit,
    GITHUB_REPOSITORY: "zaks-io/splitch",
    GITHUB_TOKEN: "ephemeral-github-token",
    RELEASE_TAG: options.tag,
  };
  const fetcher = (repository: object, release: object) => async (url: string) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(url.endsWith(`/releases/tags/${options.tag}`) ? release : repository),
  });
  const validRelease = {
    tag_name: options.tag,
    draft: false,
    prerelease: false,
    immutable: true,
    published_at: "2026-07-17T00:00:00Z",
    target_commitish: commit,
  };

  describe(`${options.label} live publish-state validation`, () => {
    it("requires fresh public repository, release, remote tag, and checked-out SHA evidence", async () => {
      const result = await validateLivePublishState(options.targetKey, repoRoot, environment, {
        fetcher: fetcher({ private: false, visibility: "public" }, validRelease),
        head: () => commit,
        peeledTag: () => commit,
      });
      expect(result.remote_peeled_tag).toBe(commit);
    });

    it("fails closed when live source or repository visibility is invalid", async () => {
      await expect(
        validateLivePublishState(options.targetKey, repoRoot, environment, {
          fetcher: fetcher(
            { private: false, visibility: "public" },
            {
              ...validRelease,
              target_commitish: "fedcba9876543210fedcba9876543210fedcba98",
            },
          ),
          head: () => commit,
          peeledTag: () => commit,
        }),
      ).rejects.toThrow("live release source SHAs disagree");
      await expect(
        validateLivePublishState(options.targetKey, repoRoot, environment, {
          fetcher: fetcher({ private: true, visibility: "private" }, validRelease),
          head: () => commit,
          peeledTag: () => commit,
        }),
      ).rejects.toThrow("not publicly visible");
    });

    it.each([
      ["prerelease", { prerelease: true, immutable: true }],
      ["mutable", { prerelease: false, immutable: false }],
    ])("fails closed when the live release is %s", async (_label, releaseState) => {
      await expect(
        validateLivePublishState(options.targetKey, repoRoot, environment, {
          fetcher: fetcher(
            { private: false, visibility: "public" },
            { ...validRelease, ...releaseState },
          ),
          head: () => commit,
          peeledTag: () => commit,
        }),
      ).rejects.toThrow("not a published immutable release");
    });
  });
}

function registerContextTests(options: PublishContractOptions): void {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
  const environment = {
    REPOSITORY_PRIVATE: "false",
    RELEASE_TAG: options.tag,
    RELEASE_TARGET_COMMITISH: commit,
    GITHUB_REF: `refs/tags/${options.tag}`,
    GITHUB_SHA: commit,
  };
  const resolveCommit = (ref: string) =>
    ref === `refs/tags/${options.tag}` || ref === "HEAD" || ref === commit ? commit : otherCommit;

  describe(`${options.label} trusted-publish validation behavior`, () => {
    it("requires the release target to resolve to the immutable tag commit", () => {
      expect(
        validatePublishContext(options.targetKey, repoRoot, environment, resolveCommit),
      ).toMatchObject({
        packageName: options.packageName,
        version: "0.1.0",
        releaseTag: options.tag,
        tagSha: commit,
      });
      expect(() =>
        validatePublishContext(
          options.targetKey,
          repoRoot,
          { ...environment, RELEASE_TARGET_COMMITISH: "main" },
          resolveCommit,
        ),
      ).toThrow("release target commitish must be a full commit SHA");
      expect(() =>
        validatePublishContext(
          options.targetKey,
          repoRoot,
          { ...environment, RELEASE_TARGET_COMMITISH: otherCommit },
          resolveCommit,
        ),
      ).toThrow("differs from release tag commit");
      expect(() =>
        validatePublishContext(
          options.targetKey,
          repoRoot,
          { ...environment, REPOSITORY_PRIVATE: "true" },
          resolveCommit,
        ),
      ).toThrow(`refusing ${options.label} trusted publishing`);
      expect(() =>
        validatePublishContext(
          options.targetKey,
          repoRoot,
          {
            ...environment,
            RELEASE_TAG: `${options.targetKey}-v0.1.1`,
            GITHUB_REF: `refs/tags/${options.targetKey}-v0.1.1`,
          },
          resolveCommit,
        ),
      ).toThrow(`does not match expected ${options.label} tag`);
    });
  });
}

function registerPublishedVersionTests(options: PublishContractOptions): void {
  describe(`${options.label} exact-version publication check`, () => {
    it("returns true only for the exact immutable npm version", () => {
      expect(
        checkPublishedVersion({
          targetKey: options.targetKey,
          version: "0.1.0",
          run: () => ({ status: 0, stdout: '"0.1.0"\n', stderr: "" }),
        }),
      ).toBe(true);
      expect(
        checkPublishedVersion({
          targetKey: options.targetKey,
          version: "0.1.0",
          run: () => ({ status: 1, stdout: "", stderr: "npm ERR! code E404" }),
        }),
      ).toBe(false);
      expect(() =>
        checkPublishedVersion({
          targetKey: options.targetKey,
          version: "0.1.0",
          run: () => ({ status: 0, stdout: '"0.1.1"\n', stderr: "" }),
        }),
      ).toThrow("refusing an ambiguous result");
    });
  });
}
