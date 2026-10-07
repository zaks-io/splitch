import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { DOCS_ORIGIN } from "./docs/site";
import { canonicalPageUrls } from "./docs/sitemap";
import { routeTree } from "./routeTree.gen";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function routerFor(path: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: true,
  });
}

function expectPageMetadata(router: ReturnType<typeof routerFor>, canonicalUrl: string) {
  const matches = router.state.matches;
  const meta = matches.flatMap((match) => match.meta ?? []);
  const links = matches.flatMap((match) => match.links ?? []);

  expect(meta.filter((entry) => entry?.property === "og:url")).toEqual([
    { property: "og:url", content: canonicalUrl },
  ]);
  expect(links.filter((entry) => entry?.rel === "canonical")).toEqual([
    { rel: "canonical", href: canonicalUrl },
  ]);
  expect(meta.some((entry) => entry?.property === "og:title")).toBe(false);
  expect(meta.filter((entry) => entry?.title).at(-1)?.title).toBeTruthy();
  expect(meta.find((entry) => entry?.property === "og:image")?.content).toBe(
    new URL("/og-card.png", DOCS_ORIGIN).href,
  );
}

describe("marketing page metadata", () => {
  it.each(canonicalPageUrls)(
    "declares the page URL for %s without query parameters",
    async (url) => {
      const pathname = new URL(url).pathname;
      const router = routerFor(`${pathname}?utm_source=metadata-test&search=private#section`);
      await router.load();

      expectPageMetadata(router, url);
    },
  );

  it("retains per-route titles", async () => {
    const router = routerFor("/docs/flags?utm_source=metadata-test");
    await router.load();
    expectPageMetadata(router, `${DOCS_ORIGIN}/docs/flags`);
    expect(router.state.matches.at(-1)?.meta).toContainEqual({
      title: "Flags · splitch",
    });

    const quickstart = routerFor("/quickstart");
    await quickstart.load();
    expectPageMetadata(quickstart, `${DOCS_ORIGIN}/quickstart`);
    expect(quickstart.state.matches.at(-1)?.meta).toContainEqual({
      title: "Quickstart · splitch",
    });
  });
});
