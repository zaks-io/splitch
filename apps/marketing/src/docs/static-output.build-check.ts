import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { robotsTxt, sitemapXml } from "./sitemap";

it.each([
  ["robots.txt", robotsTxt],
  ["sitemap.xml", sitemapXml],
] as const)("emits %s bytes from the canonical source", async (path, content) => {
  const output = await readFile(new URL(`../../dist/client/${path}`, import.meta.url));
  expect(output).toEqual(Buffer.from(content()));
});
