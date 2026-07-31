import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scopedHref } from "./app-shell-navigation";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

/**
 * Everything below an App is scoped to `(appId, environmentId)`, so a link that
 * stops at the App would have to invent an Environment — and the invented one is
 * always the dangerous one. This is the grep half of that proof; the Playwright
 * spec is the rendered half.
 */
describe("no link targets an App without an Environment", () => {
  it("has no route matching /$orgSlug/$appSlug", () => {
    const routes = readdirSync(join(SRC, "routes")).filter(
      (name) =>
        name.startsWith("$orgSlug.$appSlug.") && name.endsWith(".tsx") && !name.includes(".test."),
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route).toMatch(/^\$orgSlug\.\$appSlug\.\$env[.\w$]*\.tsx$/);
    }
    expect(routes).not.toContain("$orgSlug.$appSlug.tsx");
    expect(routes).not.toContain("$orgSlug.$appSlug.index.tsx");
  });

  it("names no App-scoped destination that omits the Environment", () => {
    const offenders: string[] = [];
    // Any navigation target naming an App: a router `to` path, or a string or
    // template literal that composes one. Each must also carry the Environment.
    const target = /(?:to=|href=|`|")[^\n`"]*(?:\$appSlug|\$\{[^}]*appSlug)[^\n`"]*/g;

    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(target)) {
        if (!/\$env|\$\{[^}]*env|environment/i.test(match[0])) {
          offenders.push(`${file.slice(SRC.length)}: ${match[0].trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("cannot build an App href without an Environment", () => {
    // The only URL builder for App scope requires all three segments, so there
    // is no partial-scope escape hatch for a caller to reach for.
    expect(scopedHref({ orgSlug: "acme-labs", appSlug: "checkout-api", env: "prod" })).toBe(
      "/acme-labs/checkout-api/prod",
    );
    expect(
      scopedHref({ orgSlug: "acme-labs", appSlug: "checkout-api", env: "prod" }).split("/").length,
    ).toBe(4);
  });
});
