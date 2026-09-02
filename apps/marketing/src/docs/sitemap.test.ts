import { describe, expect, it } from "vitest";
import { robotsResponse } from "../routes/robots[.]txt";
import { sitemapResponse } from "../routes/sitemap[.]xml";
import { documentedErrorCodes } from "./errors";
import { sdkTopics } from "./sdk";
import { DOCS_ORIGIN, docsPath } from "./site";
import { canonicalPageUrls, robotsTxt, sitemapXml } from "./sitemap";

describe("sitemap", () => {
  it("lists every public HTML page at its canonical production URL", () => {
    expect(canonicalPageUrls).toEqual([
      `${DOCS_ORIGIN}/`,
      `${DOCS_ORIGIN}/quickstart`,
      `${DOCS_ORIGIN}${docsPath.index()}`,
      `${DOCS_ORIGIN}${docsPath.flags()}`,
      `${DOCS_ORIGIN}${docsPath.cli()}`,
      `${DOCS_ORIGIN}${docsPath.errors()}`,
      `${DOCS_ORIGIN}${docsPath.codeAgents()}`,
      ...sdkTopics.map((topic) => `${DOCS_ORIGIN}${docsPath.sdkTopic(topic.slug)}`),
      ...documentedErrorCodes.map((code) => `${DOCS_ORIGIN}${docsPath.errorCode(code)}`),
    ]);
    expect(new Set(canonicalPageUrls).size).toBe(canonicalPageUrls.length);
  });

  it("renders a Sitemaps protocol urlset", () => {
    const xml = sitemapXml();

    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.match(/<url><loc>/g)).toHaveLength(canonicalPageUrls.length);
    for (const url of canonicalPageUrls) expect(xml).toContain(`<loc>${url}</loc>`);
  });

  it("declares AI content preferences and advertises the sitemap", () => {
    expect(robotsTxt()).toBe(
      `User-agent: *\nContent-Signal: ai-train=no, search=yes, ai-input=no\nAllow: /\n\nSitemap: ${DOCS_ORIGIN}/sitemap.xml\n`,
    );
  });

  it("serves both discovery files with HTTP 200 and their correct content types", async () => {
    const [sitemap, robots] = [sitemapResponse(), robotsResponse()];

    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await sitemap.text()).toBe(sitemapXml());
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await robots.text()).toBe(robotsTxt());
  });
});
