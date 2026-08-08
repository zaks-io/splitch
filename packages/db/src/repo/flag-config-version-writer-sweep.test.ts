import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bumpWins, isBumpExpr } from "./flag-config-version-writer-sweep-lib";
import {
  FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT,
  resolveFlagConfigUpdates,
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
 * `packages/db/tsconfig.json` (scan root asserted against the resolver below):
 * every `CallExpression` whose receiver/argument resolves — by symbol/type
 * identity — to the `flag_configs` scoped-table facade or table, including
 * detached `update` callees whose apparent type matches the facade's `update`
 * member (parameter destructure, multi-hop alias, callback). `.call`/`.apply`
 * still go through the receiver path. Direct `.update(...)` on a typed facade
 * receiver is the same rule as a detached ref — one callee-type match.
 *
 * Assertions are the property (every discovered site bumps) plus anti-vacuity
 * (non-trivial site count spanning the known writer modules). There is no
 * hand-maintained `file:line` inventory — line numbers move under unrelated
 * edits and are not the invariant.
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

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/**
 * Floor on how many UPDATE sites the resolver must find. Today's production
 * tree has five; a silently empty or ops-only-narrowed resolver falls below
 * this. Not an inventory of identities — just anti-vacuity.
 */
const MIN_WRITER_SITES = 5;

/** Modules that currently host writers; site set must span both. */
const KNOWN_WRITER_FILES = ["repo/flag-config-ops.ts", "repo/flag-variant-approval.ts"] as const;

function siteKey(site: ResolvedUpdateSite): string {
  return `${site.file}:${site.line}`;
}

describe("every flag_configs UPDATE bumps version", () => {
  it("states a scan root that the production tsconfig actually covers", () => {
    const { scanRoot, scannedFiles } = resolveFlagConfigUpdates();
    expect(scanRoot).toBe(SCAN_ROOT);
    expect(relative(REPO_ROOT, FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT).replaceAll("\\", "/")).toBe(
      SCAN_ROOT,
    );
    // Anti-narrowing on the walk list: both known writer modules must be among
    // the files the resolver visited.
    for (const file of KNOWN_WRITER_FILES) {
      expect(scannedFiles, `resolver must walk ${file}`).toContain(file);
    }
    expect(scannedFiles.length).toBeGreaterThan(KNOWN_WRITER_FILES.length);
  });

  it("discovers a non-trivial writer set and every site bumps version", () => {
    const { sites } = resolveFlagConfigUpdates();

    expect(
      sites.length,
      "resolver returned too few writers — vacuous or narrowed",
    ).toBeGreaterThanOrEqual(MIN_WRITER_SITES);

    // Anti-narrowing on the site set itself (independent of scannedFiles): a
    // loop that still walks every file but only collects from one module fails.
    const siteFiles = new Set(sites.map((s) => s.file));
    for (const file of KNOWN_WRITER_FILES) {
      expect(siteFiles, `discovered sites must include ${file}`).toContain(file);
    }

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
