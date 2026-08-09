import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bumpWins, isBumpExpr } from "./flag-config-version-writer-sweep-lib";
import {
  FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT,
  listExpectedScannedFiles,
  resolveFlagConfigUpdates,
  type FlagConfigUpdateResolution,
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
 * `packages/db/tsconfig.json` `fileNames` (the sole walk source — no mirrored
 * exclude list). Every `CallExpression` whose receiver/argument resolves — by
 * symbol/type identity — to the `flag_configs` scoped-table facade or table,
 * including detached `update` callees whose apparent type matches the facade's
 * `update` member (parameter destructure, multi-hop alias, callback).
 * `.call`/`.apply` still go through the receiver path.
 *
 * Assertions are the property (every discovered site bumps) plus derived
 * anti-vacuity: `scannedFiles` must equal the tsconfig `fileNames` listing,
 * discovered sites must span at least two modules, and `sites.length` must
 * equal the independent candidate CallExpression count (so a silent
 * first-match-per-file narrow cannot pass). No hand-maintained inventory.
 *
 * Inside production sources, raw SQL UPDATEs of `flag_configs` fail loud as
 * `sql\`UPDATE …\``, `sql.raw(...)`, or `.prepare(...)` — including `${alias}`
 * interpolations resolved by symbol identity, string-literal `"flag_configs"`,
 * and UPDATE table expressions the checker cannot resolve (unknown ≠
 * not-flag_configs). `INSERT … ON CONFLICT DO UPDATE` of flag_configs is
 * rejected deliberately (unscored). Raw `D1Database.prepare` UPDATEs outside
 * this package remain unguarded — including the live UPDATE in
 * `apps/control-plane-api/src/config-store-fixture-data.ts` (test-fixture
 * helper imported only by `.test.ts` files, not a production writer).
 *
 * The TypeChecker program is built once in `beforeAll` (paid once for all
 * assertions below). Individual `it`s keep vitest's 5s default; only the hook
 * that constructs the program is allowed the repo's established 15s budget.
 *
 * The narrowed `repo.flags.flagConfigs` export (findMany/findOne/insert only)
 * makes a facade bypass a compile error in typechecked source and a TypeError
 * everywhere else — including `apps/control-plane-api/test/` and the three
 * `@splitch/db` importers in `apps/cli` that sit outside every tsconfig
 * (`quickstart-local-harness.ts`, `dark-launch-experiment.ts`,
 * `dark-launch-http.ts`), where the runtime TypeError is what covers them.
 *
 * Including those harnesses in a tsconfig would typecheck them and their
 * transitive helpers under CI, lengthening typecheck and likely surfacing latent
 * harness-only type errors that are currently invisible; left alone on purpose.
 */

/** Repo-relative path of the production sources the checker program covers. */
const SCAN_ROOT = "packages/db/src";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/** Repo-standard budget for hooks that build a TypeScript program (not per-`it`). */
const PROGRAM_HOOK_TIMEOUT_MS = 15_000;

function siteKey(site: ResolvedUpdateSite): string {
  return `${site.file}:${site.line}`;
}

describe("every flag_configs UPDATE bumps version", () => {
  let resolution: FlagConfigUpdateResolution;

  // Program construction is the slow part (~seconds). Pay it once; leave the
  // default 5s `testTimeout` protecting every other db unit test.
  beforeAll(() => {
    resolution = resolveFlagConfigUpdates();
  }, PROGRAM_HOOK_TIMEOUT_MS);

  it("states a scan root that the production tsconfig actually covers", () => {
    const { scanRoot, scannedFiles } = resolution;
    expect(scanRoot).toBe(SCAN_ROOT);
    expect(relative(REPO_ROOT, FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT).replaceAll("\\", "/")).toBe(
      SCAN_ROOT,
    );
    expect(scannedFiles).toEqual(listExpectedScannedFiles());
  });

  it("discovers a non-trivial writer set and every site bumps version", () => {
    const { candidateCount, sites } = resolution;
    const siteFiles = new Set(sites.map((s) => s.file));

    expect(
      siteFiles.size,
      "discovered sites must span at least two modules",
    ).toBeGreaterThanOrEqual(2);
    expect(sites.length, "resolver dropped flag_configs update CallExpressions").toBe(
      candidateCount,
    );

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
