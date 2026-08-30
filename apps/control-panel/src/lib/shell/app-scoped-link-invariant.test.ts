import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appHomeHref, scopedHref } from "#lib/shell/app-shell-navigation";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

/**
 * The App home is the one sanctioned Environment-less App destination because
 * it shows every Environment instead of inventing one. Every other App-scoped
 * destination must carry its Environment.
 */
describe("App-scoped links name an Environment except for the App home", () => {
  it("allows exactly the App home alongside Environment-scoped routes", () => {
    const routes = readdirSync(join(SRC, "routes")).filter(
      (name) =>
        name.startsWith("$orgSlug.$appSlug.") && name.endsWith(".tsx") && !name.includes(".test."),
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route).toMatch(
        /^(?:\$orgSlug\.\$appSlug\.index|\$orgSlug\.\$appSlug\.\$env[.\w$]*)\.tsx$/,
      );
    }
    expect(routes).not.toContain("$orgSlug.$appSlug.tsx");
    expect(routes.filter((route) => !route.includes(".$env"))).toEqual([
      "$orgSlug.$appSlug.index.tsx",
    ]);
  });

  it("names no App-scoped destination that omits the Environment", () => {
    const offenders: string[] = [];
    // Any router `to` or `href` target naming an App must carry the Environment
    // or use the sanctioned App-home builder.
    const target = /(?:\bto\s*[:=]|\bhref\s*[:=])[^\n]*(?:\$appSlug|\$\{[^}]*appSlug)[^\n]*/g;

    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(target)) {
        if (!/appHomeHref\(|\$env|\$\{[^}]*env|environment/i.test(match[0])) {
          offenders.push(`${file.slice(SRC.length)}: ${match[0].trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("builds only the three-segment App home or four-segment Environment scope", () => {
    expect(scopedHref({ orgSlug: "acme-labs", appSlug: "checkout-api", env: "prod" })).toBe(
      "/acme-labs/checkout-api/prod",
    );
    expect(
      scopedHref({ orgSlug: "acme-labs", appSlug: "checkout-api", env: "prod" }).split("/").length,
    ).toBe(4);
    expect(appHomeHref({ orgSlug: "acme-labs", appSlug: "checkout-api" })).toBe(
      "/acme-labs/checkout-api",
    );
    expect(appHomeHref({ orgSlug: "acme-labs", appSlug: "checkout-api" }).split("/")).toHaveLength(
      3,
    );
  });
});
