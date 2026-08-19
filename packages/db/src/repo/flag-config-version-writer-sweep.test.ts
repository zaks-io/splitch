import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bumpWins, isBumpExpr } from "./flag-config-version-writer-sweep-lib";
import {
  FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT,
  type FlagConfigUpdateResolution,
  listExpectedScannedFiles,
  type ResolvedUpdateSite,
  resolveFlagConfigUpdates,
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
 * Assertions are the property (every discovered site bumps) plus pinned
 * anti-vacuity: `scannedFiles` must equal the tsconfig `fileNames` listing,
 * the current five-site floor cannot shrink, and discovered sites must span at
 * least two modules. A new writer may grow the set without updating an inventory.
 *
 * Inside production sources, raw SQL UPDATEs of `flag_configs` fail loud as
 * `sql\`UPDATE …\``, `sql.raw(...)`, or `.prepare(...)`. Quoted or qualified
 * identifiers are normalized, interpolations are resolved by symbol identity,
 * and any raw SQL argument or UPDATE table expression the checker cannot resolve
 * fails loud. `INSERT … ON CONFLICT DO UPDATE` of flag_configs is rejected
 * deliberately (unscored). Raw `D1Database.prepare` UPDATEs outside this package
 * remain unguarded, including the live UPDATE in
 * `apps/control-plane-api/src/config-store-fixture-data.ts` (test-fixture
 * helper imported only by `.test.ts` files, not a production writer).
 *
 * The baseline TypeChecker program is built once in `beforeAll`. The mutation
 * regressions each build a fresh program with their source injected in memory;
 * every program-construction path gets the repo's established 30s budget.
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

/**
 * Budget for anything that builds a TypeScript program (~1s warm locally, but
 * over 15s on a loaded CI runner; matches the 30s sweep budget in
 * apps/control-panel/src/lib/session-cookie.test.ts).
 */
const PROGRAM_HOOK_TIMEOUT_MS = 30_000;

/** Current production code has five writers; dropping any is a reviewable change. */
const MINIMUM_KNOWN_UPDATE_SITES = 5;

const MUTATION_PATH = resolve(
  FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT,
  "repo/spl350-writer-sweep-mutation.ts",
);

function expectSweepMutationToFail(source: string, message: RegExp): void {
  expect(() => resolveFlagConfigUpdates([{ path: MUTATION_PATH, content: source }])).toThrowError(
    message,
  );
}

function siteKey(site: ResolvedUpdateSite): string {
  return `${site.file}:${site.line}`;
}

function expectInMemoryFileScanned(baseline: FlagConfigUpdateResolution): void {
  const withVirtualFile = resolveFlagConfigUpdates([
    { path: MUTATION_PATH, content: "export {};" },
  ]);
  expect(withVirtualFile.scannedFiles).toContain("repo/spl350-writer-sweep-mutation.ts");
  expect(withVirtualFile.sites).toEqual(baseline.sites);
}

function expectProductionCollisionRejected(): void {
  const path = resolve(FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT, "repo/flag-variant-approval.ts");
  expect(() => resolveFlagConfigUpdates([{ path, content: "export {};" }])).toThrowError(
    "flag_configs version sweep: extra file collides with production source: repo/flag-variant-approval.ts",
  );
}

describe("every flag_configs UPDATE bumps version", () => {
  let resolution: FlagConfigUpdateResolution;

  // Program construction is the slow part; pay for the baseline once.
  beforeAll(() => {
    resolution = resolveFlagConfigUpdates();
  }, PROGRAM_HOOK_TIMEOUT_MS);

  it(
    "states a scan root that the production tsconfig actually covers",
    () => {
      const { scanRoot, scannedFiles } = resolution;
      expect(scanRoot).toBe(SCAN_ROOT);
      expect(relative(REPO_ROOT, FLAG_CONFIG_VERSION_SWEEP_SRC_ROOT).replaceAll("\\", "/")).toBe(
        SCAN_ROOT,
      );
      expect(scannedFiles).toEqual(listExpectedScannedFiles());
      expectInMemoryFileScanned(resolution);
    },
    PROGRAM_HOOK_TIMEOUT_MS,
  );

  it("rejects a production-file collision", expectProductionCollisionRejected);

  it("discovers a non-trivial writer set and every site bumps version", () => {
    const { sites } = resolution;
    const siteFiles = new Set(sites.map((s) => s.file));

    expect(
      sites.length,
      "resolver dropped a known flag_configs update site",
    ).toBeGreaterThanOrEqual(MINIMUM_KNOWN_UPDATE_SITES);
    expect(
      siteFiles.size,
      "discovered sites must span at least two modules",
    ).toBeGreaterThanOrEqual(2);

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

  it.each([
    [
      "schema-qualified target",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE main.flag_configs SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "bracket-quoted target",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE [flag_configs] SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "single-quoted target",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE 'flag_configs' SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "schema-qualified single-quoted target",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE main.'flag_configs' SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "single-quoted target after OR REPLACE",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE OR REPLACE 'flag_configs' SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "gapless single-quoted target",
      [
        'import { sql } from "drizzle-orm";',
        "sql`UPDATE'flag_configs'SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "gapless double-quoted target after OR REPLACE",
      [
        'import { sql } from "drizzle-orm";',
        'sql`UPDATE OR REPLACE"flag_configs"SET version = version`;',
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:2: raw SQL UPDATE of flag_configs/,
    ],
    [
      "gapless flag_configs interpolation",
      [
        'import { sql } from "drizzle-orm";',
        'import { flagConfigs } from "../schema/flags";',
        "sql`UPDATE$" + "{flagConfigs} SET version = version`;",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:3: raw SQL UPDATE of flag_configs via flagConfigs/,
    ],
    [
      "dynamic sql.raw argument",
      [
        'import { sql } from "drizzle-orm";',
        'const tableName: string = "flag_configs";',
        "const statement = `UPDATE $" + "{tableName} SET version = version`;",
        "sql.raw(statement);",
      ].join("\n"),
      /spl350-writer-sweep-mutation\.ts:4: raw SQL argument statement cannot be resolved statically/,
    ],
  ])(
    "fails loud for a planted raw SQL bypass: %s",
    (_name, source, message) => {
      expectSweepMutationToFail(source, message);
    },
    PROGRAM_HOOK_TIMEOUT_MS,
  );
});
