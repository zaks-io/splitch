import { describe, expect, it } from "vitest";
import { llmsTxt, sdkTopicMarkdown } from "../markdown";
import { markdownSlug } from "../serve-markdown";
import { DOCS_ORIGIN, docsPath } from "../site";
import { browserTopic } from "./browser";
import { evaluateAllTopic } from "./evaluate-all";
import { findSdkTopic, sdkGuideTopics, sdkIntegrationTopics, sdkTopics } from "./index";
import { reactTopic } from "./react";
import { failuresTopic, methodsTopic } from "./semantics";
import { credentialsTopic, installTopic } from "./setup";

const addedSlugs = [
  "evaluate-all",
  "browser",
  "react",
  "convex",
  "node",
  "cloudflare",
  "sentry",
] as const;

describe("SDK topic routes", () => {
  it("resolves every added topic through the HTML and Markdown route lookups", () => {
    for (const slug of addedSlugs) {
      expect(findSdkTopic(slug), `${slug} HTML`).toBeDefined();

      const markdownRouteSlug = markdownSlug(`${slug}.md`);
      expect(markdownRouteSlug, `${slug} Markdown suffix`).toBe(slug);
      expect(findSdkTopic(markdownRouteSlug ?? ""), `${slug} Markdown`).toBeDefined();
    }
  });

  it("indexes every SDK topic in llms.txt with its Markdown URL", () => {
    const index = llmsTxt();
    for (const topic of sdkTopics) {
      expect(index, topic.slug).toContain(
        `- [${topic.title}](${DOCS_ORIGIN}${docsPath.sdkTopicMarkdown(topic.slug)}): ${topic.summary}`,
      );
    }
  });

  /**
   * Pinning a version in prose is what let the install page sit on 0.3.0 while
   * the package shipped 0.4.0 with three new subpaths. The page names the export
   * surface instead, and this asserts every subpath `packages/sdk/package.json`
   * publishes has a row on it.
   */
  it("documents every published export subpath and pins no version", () => {
    const markdown = sdkTopicMarkdown(installTopic);
    for (const subpath of [
      "`@splitch/sdk`",
      "`@splitch/sdk/browser`",
      "`@splitch/sdk/react`",
      "`@splitch/sdk/sentry`",
      "`@splitch/sdk/local-evaluation`",
      "`@splitch/sdk/control-plane`",
    ]) {
      expect(markdown, subpath).toContain(subpath);
    }
    expect(markdown).not.toMatch(/@splitch\/sdk@\d/);
    expect(markdown).not.toContain("sole dependency");
  });

  /**
   * The zero-dependency claim is true of the three bundled evaluation entrypoints
   * and false of the three that keep `zod` and `@sentry/core` external. An
   * unqualified claim would send a reader looking for a dependency that is
   * deliberately theirs to install.
   */
  it("scopes the zero-dependency claim to the bundled entrypoints", () => {
    const markdown = sdkTopicMarkdown(installTopic);
    expect(markdown).not.toMatch(/It has zero runtime dependencies/);
    expect(markdown).toContain("pull in no runtime dependency");
    expect(markdown).toContain("leave theirs external");
  });

  it("gives every integration its own runtime guide", () => {
    for (const topic of sdkIntegrationTopics) {
      expect(topic.section, topic.slug).toBe("integration");
    }
    for (const topic of sdkGuideTopics) {
      expect(topic.section, topic.slug).toBe("guide");
    }
    expect(sdkIntegrationTopics.map((topic) => topic.slug)).toEqual([
      "node",
      "browser",
      "react",
      "convex",
      "cloudflare",
      "sentry",
    ]);
  });

  /**
   * `useFlag` before `init()` resolves throws SDK_NOT_INITIALIZED during render
   * (packages/sdk/src/react/index.test.ts pins it). An unqualified "never
   * throws" here reads as a promise the shipped client does not keep.
   */
  it("scopes the never-throws contract to the server client", () => {
    const markdown = sdkTopicMarkdown(failuresTopic);

    expect(markdown).toContain("SDK_NOT_INITIALIZED");
    expect(markdown).toContain("useFlag");
    expect(markdown).not.toMatch(/These never throw/);
  });

  /**
   * `credential-cache.ts` grants a Client Key both `data-plane:evaluate` and
   * `data-plane:write`. The page previously said it holds "only evaluate", which
   * sent a reader minting an API Key for `track` that a Client Key already covers.
   */
  it("matches the scopes a Client Key is actually granted", () => {
    const markdown = sdkTopicMarkdown(credentialsTopic);
    expect(markdown).toContain("`data-plane:evaluate`");
    expect(markdown).toContain("`data-plane:write`");
    expect(markdown).not.toMatch(/Client Key holds only/);
  });

  /** `track` is on the shipped client (packages/sdk/src/client.ts) and bills a Metric Event. */
  it("documents track alongside the evaluation methods", () => {
    const markdown = sdkTopicMarkdown(methodsTopic);
    expect(markdown).toContain("`track`");
    expect(markdown).toContain("Metric Event");
    expect(markdown).not.toContain("The five methods");
  });

  it("keeps literal credentials on their correct side of the server boundary", () => {
    const browser = sdkTopicMarkdown(browserTopic);
    const react = sdkTopicMarkdown(reactTopic);
    const bootstrap = sdkTopicMarkdown(evaluateAllTopic);

    expect(browser).toContain('clientKey: "pk_..."');
    expect(browser).not.toContain('apiKey: "sk_..."');
    expect(react).toContain('clientKey: "pk_..."');
    expect(react).not.toContain('apiKey: "sk_..."');
    expect(bootstrap).toContain('apiKey: "sk_..."');
    expect(bootstrap).toContain('clientKey: "pk_..."');
  });
});
