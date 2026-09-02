import { describe, expect, it } from "vitest";
import { negotiateMarkdownRequest } from "./negotiate-markdown";

describe("negotiateMarkdownRequest", () => {
  it.each(["GET", "HEAD"])("serves an accepted Markdown %s request", async (method) => {
    const result = negotiateMarkdownRequest(
      new Request("https://splitch.dev/", {
        method,
        headers: { accept: "text/markdown" },
      }),
    );

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await result.response.text();
    if (method === "HEAD") {
      expect(body).toBe("");
    } else {
      expect(body).toMatch(/^# splitch/m);
    }
  });

  it.each(["GET", "HEAD"])("renders a rejected Markdown %s request as HTML", (method) => {
    const result = negotiateMarkdownRequest(
      new Request("https://splitch.dev/", {
        method,
        headers: { accept: "text/markdown; q=0" },
      }),
    );

    expect(result.kind).toBe("render");
    if (result.kind !== "render") return;
    expect(result.request.headers.get("accept")).toBe("text/html");
  });

  it("renders an unknown Markdown route as HTML", () => {
    const result = negotiateMarkdownRequest(
      new Request(new URL("/missing", "https://splitch.dev"), {
        headers: { accept: "text/markdown" },
      }),
    );

    expect(result.kind).toBe("render");
    if (result.kind !== "render") return;
    expect(result.request.headers.get("accept")).toBe("text/html");
  });
});
