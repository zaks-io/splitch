import { describe, expect, it } from "vitest";
import { llmsTxt, sdkTopicMarkdown } from "../markdown";
import { markdownSlug } from "../serve-markdown";
import { DOCS_ORIGIN, docsPath } from "../site";
import { browserTopic } from "./browser";
import { evaluateAllTopic } from "./evaluate-all";
import { findSdkTopic, sdkTopics } from "./index";
import { reactTopic } from "./react";
import { installTopic } from "./setup";

const addedSlugs = ["evaluate-all", "browser", "react", "convex"] as const;

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

  it("documents the 0.3.0 dependency and export surface", () => {
    const markdown = sdkTopicMarkdown(installTopic);
    expect(markdown).toContain("`@splitch/sdk@0.3.0`");
    expect(markdown).toContain("zero runtime dependencies");
    expect(markdown).toContain("`./browser`");
    expect(markdown).toContain("`./react`");
    expect(markdown).not.toContain("sole dependency");
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
