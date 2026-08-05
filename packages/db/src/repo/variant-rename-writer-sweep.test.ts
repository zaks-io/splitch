import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The structural half of the Variant-rename freeze (SPL-267).
 *
 * The behavioural tests prove the two doors a reviewer walked through are shut.
 * This file exists so the NEXT caller cannot reach the writer without someone
 * deciding, in writing, whether a live Run may pass through it — the lesson
 * SPL-118 learned twice by guarding routes instead of the mutation layer.
 *
 * Everything below is DERIVED from the source tree rather than hand-listed, so a
 * module or a call site added later fails a test instead of going unnoticed.
 *
 * Scope, stated so it is not mistaken for more: this sweep reads `packages/db/src`
 * ONLY. Every production caller of `updateVariant` lives in the control plane, so
 * a caller added there is invisible here and is swept instead by
 * `apps/control-plane-api/src/variant-freeze-caller-sweep.test.ts`.
 */

const SRC = fileURLToPath(new URL("../", import.meta.url));
const WRITER = "renameAvailableVariant";
const WRITER_MODULE = "repo/flag-variant-approval.ts";

/**
 * Every module allowed to name `available_variant_names`, with the reason a live
 * Run cannot be stripped of an arm through it. A new one fails the sweep.
 */
const AVAILABILITY_WRITERS: Record<string, string> = {
  "repo/flag-config-ops.ts":
    "patch types for updateFlagConfig/applyApprovedFlagConfig; frozen at the config-store seam (SPL-118) and swept by apps/control-plane-api/test/flag-config-run-freeze-writer-sweep.test.ts",
  [WRITER_MODULE]: `${WRITER}, reachable only from updateVariant, which refuses a rename under a live Run`,
  "repo/flag-variant-run-freeze.ts": "the freeze lookup itself; names the column in prose only",
  "schema/flags.ts": "the column definition",
};

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceFiles(join(dir, entry.name), rel);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * The top-level function each match sits inside, by scanning back to the nearest
 * declaration. Nesting is what matters here: `updateVariant` is returned from
 * `makeUpdateVariant`, so the enclosing declaration is the factory.
 */
function enclosingFunctions(source: string, needle: string): string[] {
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const found: string[] = [];
  for (const call of source.matchAll(new RegExp(`\\b${needle}\\(`, "g"))) {
    const at = call.index ?? 0;
    const owner = declarations.filter((d) => (d.index ?? 0) < at).pop();
    if (owner?.[1] && owner[1] !== needle) found.push(owner[1]);
  }
  return [...new Set(found)];
}

function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`no declaration for ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function \w+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("the rename writer's reachable surface is classified", () => {
  it("leaves no module writing available_variant_names unaccounted for", () => {
    const touching = sourceFiles(SRC).filter((rel) =>
      /availableVariantNames|available_variant_names/.test(read(rel)),
    );

    expect(touching.sort()).toEqual(Object.keys(AVAILABILITY_WRITERS).sort());
  });

  it("keeps the writer unexported and unreachable from any other module", () => {
    const source = read(WRITER_MODULE);

    expect(source).not.toMatch(new RegExp(`export\\s+(?:async\\s+)?function ${WRITER}\\b`));
    expect(source).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${WRITER}\\b`));
    const elsewhere = sourceFiles(SRC).filter(
      (rel) => rel !== WRITER_MODULE && read(rel).includes(WRITER),
    );
    expect(elsewhere).toEqual([]);
  });

  it("routes every in-module caller through the freeze lookup", () => {
    const source = read(WRITER_MODULE);
    const callers = enclosingFunctions(source, WRITER);

    expect(callers).not.toEqual([]);
    for (const caller of callers) {
      expect(bodyOf(source, caller)).toContain("liveRunUsingVariant");
    }
  });
});
