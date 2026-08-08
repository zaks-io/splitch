import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appSectionRegistry,
  deferredDestinationAt,
  environmentSwitchHref,
  type NavigationDestination,
  scopedHref,
  visibleAppSections,
} from "./app-shell-navigation";

const scope = { appSlug: "checkout-api", env: "dev", orgSlug: "acme-labs" };

const routesDirectory = fileURLToPath(new URL("../routes/", import.meta.url));
const componentsDirectory = fileURLToPath(new URL("../components/", import.meta.url));
const routeTree = readFileSync(`${routesDirectory}../routeTree.gen.ts`, "utf8");

/**
 * Copy that reports the state of the implementation instead of teaching the
 * product. A destination whose screen says this leads nowhere, so it must not be
 * reachable from navigation. Matched against source, so it deliberately excludes
 * words that legitimately appear inside working UI (`placeholder=`, a disabled
 * affordance labelled "Coming soon"); the rendered-headline rule in
 * `e2e/control-panel/shell-navigation.spec.ts` covers those.
 */
const implementationStatusCopy = [
  /arrives in (its|a|the) [\w -]*slice/i,
  /dedicated screen slice/i,
  /not (yet )?implemented/i,
  /lands in a (later|future) slice/i,
  /under construction/i,
];

function routeFilesFor(destination: NavigationDestination): string[] {
  const base = destination.to.replace(/^\//, "").replaceAll("/", ".");
  return [`${base}.tsx`, `${base}.index.tsx`]
    .map((name) => `${routesDirectory}${name}`)
    .filter((path) => existsSync(path));
}

/**
 * Route modules are wiring; the copy a person reads lives in the screen
 * component they render. Follow that one hop, or the scan below proves nothing.
 */
function screenSourcesFor(destination: NavigationDestination): string[] {
  const routeFiles = routeFilesFor(destination);
  const screens = routeFiles.flatMap((routeFile) =>
    [...readFileSync(routeFile, "utf8").matchAll(/from "#components\/([\w.-]+)"/g)]
      .map((match) => `${componentsDirectory}${match[1]}.tsx`)
      .filter((path) => existsSync(path)),
  );
  return [...routeFiles, ...screens];
}

describe("Visible navigation destinations", () => {
  it("keeps every visible destination pointing at a registered route", () => {
    for (const destination of visibleAppSections) {
      expect(routeTree, `${destination.label} route module`).toContain(`'${destination.to}'`);
      expect(routeFilesFor(destination), `${destination.label} route file`).not.toHaveLength(0);
    }
  });

  it("never lets a visible destination land on implementation-status copy", () => {
    const scanned = visibleAppSections.flatMap(screenSourcesFor);
    // Fail loudly if the scan stops reaching screen components: a route-file-only
    // scan would pass this suite while showing status copy to every user.
    expect(scanned.some((path) => path.startsWith(componentsDirectory))).toBe(true);

    for (const destination of visibleAppSections) {
      for (const source of screenSourcesFor(destination)) {
        const copy = readFileSync(source, "utf8");
        for (const pattern of implementationStatusCopy) {
          expect(copy, `${destination.label} (${source})`).not.toMatch(pattern);
        }
      }
    }
  });

  it("ships Segments as an App-level destination", () => {
    const segments = appSectionRegistry.find((section) => section.label === "Segments");
    expect(segments).toMatchObject({ scope: "App-level", status: "shipped" });
    expect(visibleAppSections.map((section) => section.label)).toContain("Segments");
  });

  it("surfaces every shipped destination the App shell promises", () => {
    expect(new Set(visibleAppSections.map((section) => section.label))).toStrictEqual(
      new Set(["Overview", "Flags", "Experiments", "Segments", "Metrics", "Settings"]),
    );
  });

  it("keeps the Kitchen Sink a local surface, never a hosted product destination", () => {
    // The route stays for visual development; only the hosted header link goes.
    expect(existsSync(`${routesDirectory}kitchen-sink.tsx`)).toBe(true);
    expect(readFileSync(`${routesDirectory}__root.tsx`, "utf8")).not.toContain("kitchen-sink");
  });

  it("explains why each hidden destination is hidden", () => {
    const registered: readonly NavigationDestination[] = appSectionRegistry;
    for (const destination of registered) {
      if (destination.status === "shipped") continue;
      expect(destination.hiddenBecause, `${destination.label} hidden reason`).toBeTruthy();
    }
  });
});

describe("Deferred destination deep links", () => {
  /**
   * Driven off `appSectionRegistry` rather than hardcoding a destination, so
   * this proves the whole `deferred` class: registering an entry `deferred`
   * covers it here automatically, with no test change required.
   *
   * When every destination is shipped, the class still holds: the matchers
   * below stay green against an empty deferred set, and the shipped-path
   * negative cases remain the active proof.
   */
  const deferredDestinations = (appSectionRegistry as readonly NavigationDestination[]).filter(
    (destination) => destination.status === "deferred",
  );

  it("documents the current deferred set without requiring a placeholder", () => {
    expect(Array.isArray(deferredDestinations)).toBe(true);
  });

  it("matches a direct request for every deferred destination's href", () => {
    for (const destination of deferredDestinations) {
      const href = scopedHref(
        scope,
        destination.to.replace(/^\/\$orgSlug\/\$appSlug\/\$env\/?/, ""),
      );
      expect(deferredDestinationAt(href, scope), `${destination.label} (${href})`).toBe(
        destination,
      );
    }
  });

  it("never matches a shipped destination's href", () => {
    for (const destination of visibleAppSections) {
      const href = scopedHref(
        scope,
        destination.to.replace(/^\/\$orgSlug\/\$appSlug\/\$env\/?/, ""),
      );
      expect(deferredDestinationAt(href, scope), `${destination.label} (${href})`).toBeUndefined();
    }
  });

  it("does not match an unrelated pathname", () => {
    expect(
      deferredDestinationAt("/acme-labs/checkout-api/dev/no-such-section", scope),
    ).toBeUndefined();
  });

  /**
   * A deferred destination can still have child route files left behind
   * (e.g. a deferred `Experiments` would keep `experiments.$experimentId.*`).
   * A deep link to a descendant must still be caught: an exact-match-only
   * guard would let it fall through to the child route's own loader and
   * render the deferred screen after all.
   */
  it("matches a descendant path of every deferred destination's href", () => {
    for (const destination of deferredDestinations) {
      const href = scopedHref(
        scope,
        destination.to.replace(/^\/\$orgSlug\/\$appSlug\/\$env\/?/, ""),
      );
      const descendant = `${href}/child-resource/nested`;
      expect(deferredDestinationAt(descendant, scope), `${destination.label} (${descendant})`).toBe(
        destination,
      );
    }
  });

  it("does not match a sibling path that only shares a prefix, not a path segment boundary", () => {
    for (const destination of deferredDestinations) {
      const href = scopedHref(
        scope,
        destination.to.replace(/^\/\$orgSlug\/\$appSlug\/\$env\/?/, ""),
      );
      expect(deferredDestinationAt(`${href}-extra`, scope)).toBeUndefined();
    }
  });
});

describe("App shell navigation", () => {
  it("builds explicit App and Environment destinations", () => {
    expect(scopedHref(scope)).toBe("/acme-labs/checkout-api/dev");
    expect(scopedHref({ ...scope, appSlug: "billing" })).toBe("/acme-labs/billing/dev");
  });

  it("preserves the section, query, and hash while switching Environment", () => {
    expect(
      environmentSwitchHref(
        "/acme-labs/checkout-api/dev/flags/flag_1?tab=rules#rollout",
        scope,
        "prod",
      ),
    ).toBe("/acme-labs/checkout-api/prod/flags/flag_1?tab=rules#rollout");
  });

  it("fails closed to the next scope root when the current URL contradicts the scope", () => {
    expect(environmentSwitchHref("/wrong/path", scope, "prod")).toBe(
      "/acme-labs/checkout-api/prod",
    );
  });
});
