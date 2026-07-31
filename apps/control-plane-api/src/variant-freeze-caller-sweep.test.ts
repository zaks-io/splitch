import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The consuming half of the Variant freeze sweep (SPL-267).
 *
 * `packages/db/src/repo/variant-rename-writer-sweep.test.ts` classifies the
 * writer's surface INSIDE the seam. It cannot see this layer, and this layer is
 * where every production caller of `updateVariant` lives — a reviewer added a
 * caller here that threw the result away and nothing in `packages/db` went red,
 * because there was nothing in `packages/db` to go red.
 *
 * So the rule is enforced where the callers are: a call to `updateVariant` whose
 * enclosing BLOCK never mentions `RUN_FROZEN` is a caller that would apply a
 * frozen write and report success. `updateVariant` still refuses it at the seam,
 * so this is not the security boundary; it is what stops a caller from silently
 * converting a refusal into a 200 (ADR-0036).
 *
 * Two evasions a previous version of this file lost to, both closed below:
 * matching the receiver (`repo.flags.updateVariant(`) was stepped over by one
 * line of destructuring, and scanning back to `function` declarations passed
 * VACUOUSLY on a module written entirely with arrow consts, because it found no
 * enclosing function at all. The match is now on the method alone, and the
 * enclosing scope is found by balancing braces, which every call shape has.
 *
 * Coverage this does NOT give: a brand-new package that imports `@splitch/db`
 * and calls `updateVariant` is outside this tree and outside the db sweep, and
 * would be swept by neither. Stated plainly rather than implied away.
 */

const SRC = fileURLToPath(new URL("./", import.meta.url));
const CALL = ".updateVariant(";
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

function callSites(source: string): number[] {
  const found: number[] = [];
  let at = source.indexOf(CALL);
  while (at >= 0) {
    found.push(at);
    at = source.indexOf(CALL, at + 1);
  }
  return found;
}

/** The offset of the `{` opening the innermost block containing `at`. */
function blockStart(source: string, at: number): number {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (source[i] === "}") depth += 1;
    else if (source[i] === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  throw new Error("call is not inside any block");
}

/**
 * The innermost `{ … }` the call sits inside, found by balancing braces rather
 * than by recognising a declaration keyword. `function`, arrow const, object
 * method and class method all produce one, so no call shape escapes.
 */
function enclosingBlock(source: string, at: number): string {
  const open = blockStart(source, at);
  let nesting = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") nesting += 1;
    else if (source[i] === "}") {
      nesting -= 1;
      if (nesting === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

describe("every control-plane caller of updateVariant handles the freeze refusal", () => {
  it("leaves no calling module unaccounted for", () => {
    const calling = sourceFiles(SRC).filter((rel) => read(rel).includes(CALL));

    expect(calling.sort()).toEqual(Object.keys(CALLERS).sort());
  });

  it("mentions the refusal in the block that makes each call", () => {
    for (const rel of Object.keys(CALLERS)) {
      const source = read(rel);
      const sites = callSites(source);
      expect(sites, `${rel} no longer calls the writer`).not.toEqual([]);
      for (const at of sites) {
        const line = source.slice(0, at).split("\n").length;
        expect(enclosingBlock(source, at), `${rel}:${line} discards the refusal`).toContain(
          REFUSAL,
        );
      }
    }
  });
});
