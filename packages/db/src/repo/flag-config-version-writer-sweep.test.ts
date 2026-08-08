import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bumpWins, isBumpExpr } from "./flag-config-version-writer-sweep-lib";
import {
  resolveFlagConfigUpdateSites,
  type ResolvedUpdateSite,
} from "./flag-config-version-writer-sweep-resolve";

/**
 * Structural sweep: every UPDATE of `flag_configs` bumps `version` (SPL-350).
 *
 * `flag_configs.version` is the documented primary defense against stale-config
 * writes. The compare-and-set in `flag-config-ops.ts` only works when every
 * writer advances the counter. A new UPDATE that forgets the bump compiles,
 * passes review, and silently disables the CAS for every path that races it.
 *
 * Writer set is derived by the TypeScript type checker from
 * `packages/db/tsconfig.json` (asserted below): every `CallExpression` whose
 * receiver/argument resolves — by symbol identity — to the `flag_configs`
 * scoped-table facade or table. Aliases, parameters, type aliases, generics,
 * optional chaining, `.call`/`.apply`, and cross-module type-only imports are
 * the same type to the checker, so they do not need per-spelling regexes.
 *
 * The narrowed `repo.flags.flagConfigs` export (findMany/findOne/insert only)
 * makes a facade bypass a compile error in typechecked source and a TypeError
 * everywhere else — including `apps/control-plane-api/test/` and the three
 * `@splitch/db` importers in `apps/cli` that sit outside every tsconfig
 * (`quickstart-local-harness.ts`, `dark-launch-experiment.ts`,
 * `dark-launch-http.ts`), where the runtime TypeError is what covers them.
 * Raw `D1Database.prepare` UPDATEs of `flag_configs` are outside both and are
 * not guarded — including the live `UPDATE flag_configs SET …` at
 * `apps/control-plane-api/src/config-store-fixture-data.ts:169` (test-fixture
 * helper imported only by `.test.ts` files, not a production writer).
 *
 * Including those harnesses in a tsconfig would typecheck them and their
 * transitive helpers under CI, lengthening typecheck and likely surfacing latent
 * harness-only type errors that are currently invisible; left alone on purpose.
 */

/** Repo-relative path of the production sources the checker program covers. */
const SCAN_ROOT = "packages/db/src";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(SRC, "../../..");

/**
 * Exact writer set the checker must resolve. Empty, shrunken, or grown-but-
 * unbumped sets all fail this equality (anti-vacuity). Lines are the `version`
 * property when present, else the set/values object start.
 */
const KNOWN_WRITER_SITES = [
  "repo/flag-config-ops.ts:115",
  "repo/flag-config-ops.ts:137",
  "repo/flag-config-ops.ts:195",
  "repo/flag-config-ops.ts:230",
  "repo/flag-variant-approval.ts:56",
] as const;

function siteKey(site: ResolvedUpdateSite): string {
  return `${site.file}:${site.line}`;
}

describe("every flag_configs UPDATE bumps version", () => {
  it("states a scan root that the production tsconfig actually covers", () => {
    expect(SCAN_ROOT).toBe("packages/db/src");
    expect(relative(REPO_ROOT, SRC).replaceAll("\\", "/")).toBe(SCAN_ROOT);
  });

  it("resolves exactly the known writer sites and each bump wins", () => {
    const sites = resolveFlagConfigUpdateSites();
    expect(sites.map(siteKey).sort()).toEqual([...KNOWN_WRITER_SITES].sort());

    const violators = sites.filter((site) => !bumpWins(site));
    expect(
      violators.map((s) => `${SCAN_ROOT}/${siteKey(s)} (${s.kind})`),
      "flag_configs UPDATE without a winning version bump",
    ).toEqual([]);
  });

  it("accepts any identifier.version + 1 and rejects spread-source / pinnable RHS", () => {
    expect(isBumpExpr("existing.version + 1")).toBe(true);
    expect(isBumpExpr("current.version + 1")).toBe(true);
    expect(isBumpExpr("patch.version + 1", new Set(["patch"]))).toBe(false);
    expect(isBumpExpr("patch.version ?? current.version + 1")).toBe(false);
  });
});
