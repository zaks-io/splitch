import { cliCommandReference } from "@splitch/cli/commands";
import { describe, expect, it } from "vitest";
import { cliDoc } from "./cli";
import { cliDocMarkdown, llmsTxt } from "./markdown";
import { DOCS_ORIGIN, docsPath } from "./site";

describe("CLI docs surface", () => {
  it("indexes the CLI page from llms.txt with the .md URL", () => {
    const index = llmsTxt();
    expect(index).toContain("## CLI");
    expect(index).toContain(
      `- [${cliDoc.title}](${DOCS_ORIGIN}${docsPath.cliMarkdown()}): ${cliDoc.summary}`,
    );
    expect(index).toContain("--confirm");
  });

  it("teaches the three things a cold agent reverse-engineered instead", () => {
    const markdown = cliDocMarkdown();
    expect(markdown).toContain("--json");
    expect(markdown).toContain("--confirm");
    expect(markdown).toContain("docsUrl");
    expect(markdown).toContain("details.approvalRequestId");
    expect(markdown).toContain("SPLITCH_APP");
    expect(markdown).toContain("splitch.json");
    expect(markdown).toContain('"version": 1');
    expect(markdown).toContain("each parent directory");
    expect(markdown).toContain("safe to commit");
    expect(markdown).toContain("CLI_SCOPE_UNRESOLVED");
    expect(markdown).toContain("--output-file");
    expect(markdown).toContain("valueWrittenTo");
    expect(markdown).toContain(`Source: ${DOCS_ORIGIN}${docsPath.cli()}`);
  });

  /**
   * The reference is generated from the CLI's own registry; this holds the
   * rendering honest so a command cannot be dropped from the page while the
   * binary still answers to it.
   */
  it("lists every registered command with its scope and --confirm support", () => {
    const markdown = cliDocMarkdown();
    const reference = cliCommandReference();
    expect(reference.length).toBeGreaterThan(20);
    for (const entry of reference) {
      expect(markdown).toContain(`\`${entry.command}\``);
    }
    expect(reference.some((entry) => entry.supportsConfirm)).toBe(true);
    expect(markdown).toContain("| `splitch flag-config update` | App + Environment | yes |");
  });
});
