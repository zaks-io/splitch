import { describe, expect, it } from "vitest";
import { codeAgentsDoc } from "./code-agents";
import { codeAgentsDocMarkdown, llmsTxt } from "./markdown";
import { DOCS_ORIGIN, docsPath } from "./site";

describe("code-agent docs surface", () => {
  it("is indexed for agents through llms.txt", () => {
    expect(llmsTxt()).toContain(
      `- [${codeAgentsDoc.title}](${DOCS_ORIGIN}${docsPath.codeAgentsMarkdown()}): ${codeAgentsDoc.summary}`,
    );
  });

  it("pins the Exposure, Metric Event, credential, and completion contracts", () => {
    const markdown = codeAgentsDocMarkdown();
    expect(markdown).toContain("<splitch_configuration>");
    expect(markdown).toContain("Client Key is public");
    expect(markdown).toContain("API Key is secret");
    expect(markdown).toContain("Exposure");
    expect(markdown).toContain("Metric Event");
    expect(markdown).toContain("Ratio Metric is derived");
    expect(markdown).toContain("Do not deploy to production");
    expect(markdown).toContain(`Source: ${DOCS_ORIGIN}${docsPath.codeAgents()}`);
  });
});
