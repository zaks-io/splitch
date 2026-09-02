import { documentedErrorCodes } from "./errors";
import { sdkTopics } from "./sdk";
import { DOCS_ORIGIN, docsPath } from "./site";

const staticPagePaths = [
  "/",
  "/quickstart",
  docsPath.index(),
  docsPath.flags(),
  docsPath.cli(),
  docsPath.errors(),
  docsPath.codeAgents(),
] as const;

export const canonicalPageUrls = [
  ...staticPagePaths,
  ...sdkTopics.map((topic) => docsPath.sdkTopic(topic.slug)),
  ...documentedErrorCodes.map((code) => docsPath.errorCode(code)),
].map((path) => new URL(path, DOCS_ORIGIN).href);

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function sitemapXml(): string {
  const entries = canonicalPageUrls
    .map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function robotsTxt(): string {
  return `User-agent: *\nContent-Signal: ai-train=no, search=yes, ai-input=no\nAllow: /\n\nSitemap: ${DOCS_ORIGIN}/sitemap.xml\n`;
}
