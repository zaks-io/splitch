import { describe, expect, it } from "vitest";
import { flagsDoc } from "./flags";
import { flagsDocMarkdown, llmsTxt } from "./markdown";
import { DOCS_ORIGIN, docsPath } from "./site";

describe("flags docs surface", () => {
  it("indexes the Flags page from llms.txt with the .md URL", () => {
    const index = llmsTxt();
    expect(index).toContain("## Flags");
    expect(index).toContain(
      `- [${flagsDoc.title}](${DOCS_ORIGIN}${docsPath.flagsMarkdown()}): ${flagsDoc.summary}`,
    );
    expect(index).toContain("availableVariantNames");
  });

  it("documents enable, rollout, availableVariantNames, and Targeting Rules", () => {
    const markdown = flagsDocMarkdown();
    expect(markdown).toContain("--enabled true --rollout 100");
    expect(markdown).toContain("availableVariantNames");
    expect(markdown).toContain("never narrowed");
    expect(markdown).toContain("Targeting Rules");
    expect(markdown).toContain('"DISABLED"');
    expect(markdown).toContain('"SPLIT"');
    expect(markdown).toContain(`Source: ${DOCS_ORIGIN}${docsPath.flags()}`);
  });

  it("teaches that DISABLED is inert, not a pass", () => {
    expect(
      flagsDoc.blocks.some((block) => block.kind === "prose" && block.text.includes("inert")),
    ).toBe(true);
  });
});
