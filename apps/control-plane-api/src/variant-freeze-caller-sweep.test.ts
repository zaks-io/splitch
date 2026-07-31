import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the Variant freeze sweep (SPL-267).
 *
 * `packages/db/src/repo/variant-rename-writer-sweep.test.ts` classifies the
 * writer's surface INSIDE the seam. It cannot see this layer, and this layer is
 * where every production caller of `updateVariant` actually lives — a reviewer
 * added a caller here that threw the result away and nothing in `packages/db`
 * went red, because there was nothing in `packages/db` to go red.
 *
 * So the rule is enforced where the callers are: a call to `updateVariant` whose
 * enclosing function never mentions `RUN_FROZEN` is a caller that would apply a
 * frozen write and report success. `updateVariant` still refuses it at the seam,
 * so this is not the security boundary; it is the thing that stops a caller from
 * silently converting a refusal into a 200 (ADR-0036).
 *
 * Coverage this does NOT give: a brand-new package that imports `@splitch/db`
 * and calls `updateVariant` is outside this tree and outside the db sweep, and
 * would be swept by neither. Stated plainly rather than implied away.
 */

const SRC = fileURLToPath(new URL("./", import.meta.url));
const CALL = "repo.flags.updateVariant(";
const REFUSAL = "RUN_FROZEN";

/** Every module here calling the writer, with how it surfaces the refusal. */
const CALLERS: Record<string, string> = {
  "approval-application.ts":
    "renders the refusal onto the Review as a RUN_FROZEN application error",
  "flag-definition-variant-handlers.ts": "renders the refusal as a 409 RUN_FROZEN response",
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

/** The top-level declaration each call sits inside, by scanning back to it. */
function enclosingFunctions(source: string, needle: string): string[] {
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const found: string[] = [];
  let at = source.indexOf(needle);
  while (at >= 0) {
    const owner = declarations.filter((d) => (d.index ?? 0) < at).pop();
    if (owner?.[1]) found.push(owner[1]);
    at = source.indexOf(needle, at + 1);
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

describe("every control-plane caller of updateVariant handles the freeze refusal", () => {
  it("leaves no calling module unaccounted for", () => {
    const calling = sourceFiles(SRC).filter((rel) => read(rel).includes(CALL));

    expect(calling.sort()).toEqual(Object.keys(CALLERS).sort());
  });

  it("mentions the refusal inside the function that makes each call", () => {
    for (const rel of Object.keys(CALLERS)) {
      const source = read(rel);
      const callers = enclosingFunctions(source, CALL);
      expect(callers, `${rel} no longer calls the writer`).not.toEqual([]);
      for (const caller of callers) {
        expect(bodyOf(source, caller), `${rel}:${caller} discards the refusal`).toContain(REFUSAL);
      }
    }
  });
});
