import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRouteInventory, lintPublishedDocsText } from "./docs-link-lint.mjs";

const origin = "https://splitch.dev";

async function fixtureRoutes(t) {
  const root = await mkdtemp(path.join(tmpdir(), "splitch-doc-routes-"));
  const routes = path.join(root, "routes");
  await mkdir(routes);
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    writeFile(path.join(routes, "index.tsx"), 'createFileRoute("/")({});'),
    writeFile(
      path.join(routes, "docs.index.tsx"),
      'createFileRoute("/docs/")({});\n<section id="errors" /><section id="sdk" />',
    ),
    writeFile(path.join(routes, "docs.errors.tsx"), 'createFileRoute("/docs/errors")({});'),
    writeFile(path.join(routes, "docs.errors[.]md.ts"), 'createFileRoute("/docs/errors.md")({});'),
    writeFile(
      path.join(routes, "docs.error.$code.tsx"),
      'createFileRoute("/docs/error/$code")({});',
    ),
  ]);
  return routes;
}

test("accepts known routes, dynamic routes, and HTML-backed markdown routes", async (t) => {
  const inventory = await buildRouteInventory(await fixtureRoutes(t));
  const text = [
    `${origin}/docs/errors`,
    `${origin}/docs/errors.md`,
    `${origin}/docs/error/CLI_SCOPE_UNRESOLVED`,
    `${origin}/docs/error/{code}.md`,
    `${origin}/docs#sdk`,
  ].join("\n");

  assert.deepEqual(lintPublishedDocsText("README.md", text, inventory), []);
});

test("rejects a link-side mutation to a fabricated route", async (t) => {
  const inventory = await buildRouteInventory(await fixtureRoutes(t));
  const invalidUrl = `${origin}/docs/${"fabricated"}`;

  assert.match(
    lintPublishedDocsText("README.md", invalidUrl, inventory)[0].message,
    /names no marketing route/,
  );
});

test("rejects a route-side mutation that removes a published target", async (t) => {
  const routes = await fixtureRoutes(t);
  await rm(path.join(routes, "docs.errors.tsx"));
  const inventory = await buildRouteInventory(routes);

  assert.match(
    lintPublishedDocsText("README.md", `${origin}/docs/errors`, inventory)[0].message,
    /names no marketing route/,
  );
});

test("rejects markdown routes without an HTML twin", async (t) => {
  const routes = await fixtureRoutes(t);
  await rm(path.join(routes, "docs.errors.tsx"));
  const inventory = await buildRouteInventory(routes);

  assert.match(
    lintPublishedDocsText("README.md", `${origin}/docs/errors.md`, inventory)[0].message,
    /has no HTML twin/,
  );
});

test("rejects missing anchors and stale fragment collisions", async (t) => {
  const inventory = await buildRouteInventory(await fixtureRoutes(t));
  const missingAnchor = `${origin}/docs#${"missing"}`;
  const movedCatalog = `${origin}/docs#${"errors"}`;

  assert.match(
    lintPublishedDocsText("README.md", missingAnchor, inventory)[0].message,
    /names no section anchor/,
  );
  assert.match(lintPublishedDocsText("README.md", movedCatalog, inventory)[0].message, /is stale/);
});
