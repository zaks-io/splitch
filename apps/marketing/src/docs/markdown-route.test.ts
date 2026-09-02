import { describe, expect, it } from "vitest";
import { markdownForPath } from "./markdown-route";

describe("markdownForPath", () => {
  it("serves the agent index for the homepage", () => {
    const markdown = markdownForPath("/");
    expect(markdown).toMatch(/^# splitch/m);
    expect(markdown).toContain("https://splitch.dev/docs/flags.md");
    expect(markdown).toContain("https://splitch.dev/docs/cli.md");
    expect(markdown).toContain("https://splitch.dev/docs/code-agents.md");
    expect(markdown).toContain("https://splitch.dev/docs/errors.md");
  });

  it("serves static and dynamic documentation", () => {
    expect(markdownForPath("/docs/flags")).toMatch(/^# /);
    expect(markdownForPath("/docs/sdk/install")).toMatch(/^# /);
    expect(markdownForPath("/docs/error/UNAUTHORIZED")).toContain("# UNAUTHORIZED");
  });

  it("does not invent markdown for unknown routes", () => {
    expect(markdownForPath("/docs/sdk/not-a-topic")).toBeNull();
    expect(markdownForPath("/missing")).toBeNull();
  });
});
