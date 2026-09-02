import { describe, expect, it } from "vitest";
import { homepageLinkHeader, withHomepageLinkHeaders } from "./agent-discovery";

describe("homepage agent discovery", () => {
  it("adds registered discovery relations to homepage responses", async () => {
    const response = withHomepageLinkHeaders(
      new Request("https://splitch.dev/"),
      new Response("homepage", { headers: { link: "</existing>; rel=alternate" } }),
    );

    expect(response.headers.get("link")).toBe(`</existing>; rel=alternate, ${homepageLinkHeader}`);
    expect(response.headers.get("link")).toContain('rel="api-catalog"');
    expect(response.headers.get("link")).toContain('rel="service-desc"');
    expect(response.headers.get("link")).toContain('rel="service-doc"');
    expect(response.headers.get("link")).toContain('rel="describedby"');
    await expect(response.text()).resolves.toBe("homepage");
  });

  it("does not add discovery links to non-homepage responses", () => {
    const response = withHomepageLinkHeaders(
      new Request("https://splitch.dev/docs"),
      new Response("docs"),
    );

    expect(response.headers.has("link")).toBe(false);
  });
});
