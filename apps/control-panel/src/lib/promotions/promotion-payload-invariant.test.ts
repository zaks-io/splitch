import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { promotionDiff } from "#lib/promotions/promotion-diff";
import { promotionView, stagingView } from "#lib/promotions/promotion-fixture";
import { promotionSelect, selectedRows } from "#lib/promotions/promotion-selection";
import { type FlagPromotionScope, promotionRequest } from "#lib/flags/use-flag-promotion";

// The hook is imported for `promotionRequest`, a pure function; its module graph
// reaches the Worker binding, which does not exist outside workerd.
vi.mock("#lib/flags/control-plane-flag-mutations", () => ({
  promoteControlPanelFlagConfig: vi.fn(),
  loadControlPanelApprovalRequest: vi.fn(),
  reviewControlPanelApprovalRequest: vi.fn(),
}));

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Where the promote server function is declared; the declaration is not a caller. */
const DECLARATION = "lib/flags/control-plane-flag-mutations.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** POSIX-separated and relative to `SRC`, so the expectations below read the same everywhere. */
function relative(path: string): string {
  return path.slice(SRC.length).replaceAll(sep, "/");
}

function files(needle: string): { path: string; source: string }[] {
  return sourceFiles(SRC)
    .map((path) => ({ path: relative(path), source: code(readFileSync(path, "utf8")) }))
    .filter(({ path }) => path !== DECLARATION)
    .filter(({ source }) => source.includes(needle));
}

/**
 * The diff shown IS the diff submitted.
 *
 * Two layers, because the risk has two shapes. The structural half below rules out
 * a SECOND path to the payload — a surface that re-derives `select` on its way to
 * the wire, which is how a screen ends up rendering one proposal and sending
 * another. The value half proves the one remaining constructor is faithful to the
 * ticked rows for every selection there is.
 *
 * The rendered half — that the ticks on screen, the `data-promotion-payload`
 * attribute, and the request the Worker receives all agree after real clicks —
 * lives in `e2e/control-panel/promotion.spec.ts`, which is the only place a click
 * exists. Neither half is sufficient alone.
 */
describe("the diff shown is the diff submitted", () => {
  it("keeps exactly one caller of the promote server function", () => {
    expect(files("promoteControlPanelFlagConfig").map(({ path }) => path)).toEqual([
      "lib/flags/use-flag-promotion.ts",
    ]);
  });

  it("sends the rendered request object verbatim, adding only the idempotency key", () => {
    const source = files("promoteControlPanelFlagConfig")[0]?.source ?? "";

    // `...request` is the same memoized object the screen renders as its payload.
    // Anything else here — a rebuilt object literal, a second `selectedRows` walk —
    // is a payload the operator never saw.
    expect(source).toContain("promoteControlPanelFlagConfig({ data: { ...request,");
    expect(source).toMatch(/\.\.\.request, idempotencyKey: newKey\(\) \}/);
  });

  it("leaves promotionRequest the only constructor of a promote select", () => {
    const constructors = files("promotionSelect(").map(({ path }) => path);

    expect(constructors).toEqual([
      "lib/flags/use-flag-promotion.ts",
      "lib/promotions/promotion-selection.ts",
    ]);
    // And inside the hook, exactly once: in `promotionRequest`, from `preview`.
    const hook = files("promotionSelect(").find(({ path }) =>
      path.endsWith("use-flag-promotion.ts"),
    );
    expect(hook?.source.match(/promotionSelect\(/g)).toHaveLength(1);
    expect(hook?.source).toContain("select: promotionSelect(preview)");
  });

  it("carries the ticked rows and nothing else into the payload, for every selection", () => {
    const source = stagingView();
    const target = promotionView();
    const rows = promotionDiff(source, target).rows;
    const scope: FlagPromotionScope = {
      appId: "app_1",
      targetEnvironmentId: "env_prod",
      targetEnv: "prod",
      fromEnvironmentId: "env_staging",
      sourceEnv: "staging",
      flagId: "flag_new_checkout",
      variantLabels: { var_control: "control", var_beta: "beta" },
    };

    for (let mask = 0; mask < 2 ** rows.length; mask += 1) {
      const selected = new Set(
        rows.filter((_, index) => (mask & (1 << index)) !== 0).map((row) => row.id),
      );
      const preview = selectedRows(rows, selected);

      const request = promotionRequest(scope, preview);

      expect(request.select).toEqual(promotionSelect(preview));
      expect(request.fromEnvironmentId).toBe("env_staging");
      expect(request.targetEnvironmentId).toBe("env_prod");
      // Every name in the payload traces back to a row the operator can see ticked.
      for (const name of request.select.availability ?? []) {
        expect(preview.some((row) => row.variantName === name)).toBe(true);
      }
    }
  });
});
