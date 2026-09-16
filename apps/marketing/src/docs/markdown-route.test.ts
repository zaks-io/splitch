import { describe, expect, it } from "vitest";
import { quickstartMarkdown } from "./markdown";
import { markdownForPath, staticMarkdownPaths } from "./markdown-route";

function markdownUrlForPage(path: string): string {
  if (path === "/") return "/.md";
  return path.endsWith("/") ? `${path.slice(0, -1)}.md` : `${path}.md`;
}

describe("markdownForPath", () => {
  it("serves the agent index for the homepage", () => {
    const markdown = markdownForPath("/");
    expect(markdown).toMatch(/^# splitch/m);
    expect(markdown).toContain("https://splitch.dev/docs/flags.md");
    expect(markdown).toContain("https://splitch.dev/docs/cli.md");
    expect(markdown).toContain("https://splitch.dev/docs/code-agents.md");
    expect(markdown).toContain("https://splitch.dev/docs/errors.md");
    expect(markdown).toContain("https://splitch.dev/quickstart.md");
  });

  it("serves static and dynamic documentation", () => {
    expect(markdownForPath("/docs/flags")).toMatch(/^# /);
    expect(markdownForPath("/docs/sdk/install")).toMatch(/^# /);
    expect(markdownForPath("/docs/error/UNAUTHORIZED")).toContain("# UNAUTHORIZED");
  });

  it("serves /quickstart.md as the same markdown as the rendered quickstart page", () => {
    const markdown = markdownForPath("/quickstart.md");
    expect(markdown).toBe(quickstartMarkdown());
    expect(markdown).toBe(markdownForPath("/quickstart"));
    expect(markdown).toMatch(/^# Zero to a resolving Flag/m);
  });

  it("serves the .md suffix for every static HTML page, including top-level ones", () => {
    expect(staticMarkdownPaths).toContain("/quickstart");
    expect(staticMarkdownPaths.filter((path) => !path.startsWith("/docs"))).toEqual([
      "/",
      "/quickstart",
    ]);

    for (const path of staticMarkdownPaths) {
      const markdown = markdownForPath(path);
      expect(markdown, path).not.toBeNull();
      expect(markdownForPath(markdownUrlForPage(path)), markdownUrlForPage(path)).toBe(markdown);
    }
  });

  it("does not invent markdown for unknown routes", () => {
    expect(markdownForPath("/docs/sdk/not-a-topic")).toBeNull();
    expect(markdownForPath("/missing")).toBeNull();
    expect(markdownForPath("/missing.md")).toBeNull();
  });
});
