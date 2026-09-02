import { describe, expect, it } from "vitest";
import {
  acceptsMarkdown,
  hasMarkdownMediaRange,
  markdownResponse,
  withVaryAccept,
} from "./serve-markdown";

describe("acceptsMarkdown", () => {
  it("accepts markdown among multiple media types", () => {
    const request = new Request("https://splitch.dev", {
      headers: { accept: "text/html, text/markdown; q=0.8" },
    });
    expect(acceptsMarkdown(request)).toBe(true);
  });

  it("does not accept an explicitly disabled markdown representation", () => {
    const request = new Request("https://splitch.dev", {
      headers: { accept: "text/markdown; q=0, text/html" },
    });
    expect(acceptsMarkdown(request)).toBe(false);
  });
});

describe("hasMarkdownMediaRange", () => {
  it("detects an explicitly disabled markdown representation", () => {
    const request = new Request("https://splitch.dev", {
      headers: { accept: "text/markdown; q=0" },
    });
    expect(hasMarkdownMediaRange(request)).toBe(true);
  });
});

describe("withVaryAccept", () => {
  it("marks a markdown response as an Accept cache variant", async () => {
    const response = withVaryAccept(markdownResponse("# splitch"));
    expect(await response.text()).toBe("# splitch");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toBe("Accept");
  });

  it("preserves existing cache variants", () => {
    const response = withVaryAccept(
      new Response("<main>splitch</main>", {
        headers: { "content-type": "text/html", vary: "Accept-Encoding" },
      }),
    );

    expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept");
  });
});
