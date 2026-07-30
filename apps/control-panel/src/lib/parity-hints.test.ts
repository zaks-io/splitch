import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { parityHint, VERIFY_PARITY } from "./parity-hints";

/**
 * Every CLI/MCP equivalent the panel prints, read off the call sites themselves
 * rather than hand-listed here. A command the shipped skins do not answer to is
 * a defect, and `parityHint` throws on one — but it throws at render time, in a
 * user's browser, if the only thing watching is a list someone has to remember
 * to update. Scanning the source means a new teaching surface is covered the
 * moment it is written.
 */
const DISPLAYED_OPERATIONS = collectDisplayedOperations();

function collectDisplayedOperations(): readonly string[] {
  const srcDir = fileURLToPath(new URL("..", import.meta.url));
  const found = new Set<string>();
  for (const file of globSync(["**/*.ts", "**/*.tsx"], { cwd: srcDir })) {
    if (file.endsWith("parity-hints.test.ts")) continue;
    for (const [, operationId] of readFileSync(`${srcDir}/${file}`, "utf8").matchAll(
      /parityHint\(\s*"([a-z0-9_]+)"\s*\)/g,
    )) {
      if (operationId) {
        found.add(operationId);
      }
    }
  }
  expect(found.size).toBeGreaterThan(0);
  return [...found].sort();
}

describe("parityHint", () => {
  it.each(DISPLAYED_OPERATIONS)("derives both skins for %s", (operationId) => {
    const hint = parityHint(operationId);
    expect(hint.mcp).toBe(operationId);
    expect(hint.cli.startsWith("splitch ")).toBe(true);
    expect(getRoute(operationId)).toBeDefined();
  });

  it("renders the aliased resource groups the CLI actually registers", () => {
    expect(parityHint("client_key_get").cli).toBe("splitch client-key get");
    expect(parityHint("flags_create").cli).toBe("splitch flags create");
  });

  it("throws on an operation that does not exist", () => {
    expect(() => parityHint("flags_summon")).toThrow(/not a registered operation/);
  });
});

describe("VERIFY_PARITY", () => {
  it("points at a real MCP tool, since verify itself is not one", () => {
    expect(getRoute(VERIFY_PARITY.mcp)).toBeDefined();
    expect(getRoute("sdk_verify")?.operationId).toBe("sdk_verify");
  });
});
