import { describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ markdown: 0 }));
vi.mock("./markdown-route", async (importOriginal) => {
  loads.markdown += 1;
  return importOriginal<typeof import("./markdown-route")>();
});

import { negotiateMarkdownRequest } from "./negotiate-markdown";

describe("Markdown documentation loading", () => {
  it("loads the catalog once, only when a request needs Markdown", async () => {
    expect(loads.markdown).toBe(0);
    expect((await negotiateMarkdownRequest(new Request("https://splitch.dev/"))).kind).toBe(
      "render",
    );
    await negotiateMarkdownRequest(
      new Request("https://splitch.dev/quickstart.md", { method: "POST" }),
    );
    expect(loads.markdown).toBe(0);

    const first = await negotiateMarkdownRequest(new Request("https://splitch.dev/docs/cli.md"));
    const second = await negotiateMarkdownRequest(new Request("https://splitch.dev/docs/cli.md"));
    expect(first.kind).toBe("response");
    expect(second.kind).toBe("response");
    expect(loads.markdown).toBe(1);
    if (first.kind !== "response" || second.kind !== "response") return;
    expect(await second.response.text()).toBe(await first.response.text());
  });
});
