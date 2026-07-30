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
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

function panelSources(): readonly { readonly file: string; readonly text: string }[] {
  return globSync(["**/*.ts", "**/*.tsx"], { cwd: SRC_DIR })
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, text: readFileSync(`${SRC_DIR}/${file}`, "utf8") }));
}

function collectDisplayedOperations(): readonly string[] {
  const found = new Set<string>();
  for (const { text } of panelSources()) {
    for (const [, operationId] of text.matchAll(/parityHint\(\s*"([a-z0-9_]+)"\s*\)/g)) {
      if (operationId) {
        found.add(operationId);
      }
    }
  }
  expect(found.size).toBeGreaterThan(0);
  return [...found].sort();
}

/**
 * `apps-empty-state.tsx` renders `splitch apps create` as a literal. It arrived
 * from main with SPL-103 (#211), not from this surface, and is ticketed
 * separately; it is listed here so the guard below stays armed for everything
 * else instead of being deleted for one known offender.
 */
const KNOWN_HARDCODED_COMMANDS = new Set(["components/apps-empty-state.tsx"]);

/** Comments are documentation, not rendered output, so they are not offenders. */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

const DISPLAYED_OPERATIONS = collectDisplayedOperations();

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

/**
 * The scanner above only sees `parityHint("…")` call sites, so it is blind to the
 * failure mode that actually shipped: someone types the command out as a raw
 * string in a component that imports `parityHint` one file over. This closes
 * that hole from the other direction — a rendered command literal is the defect,
 * wherever it appears.
 */
describe("no hand-typed CLI commands in rendered output", () => {
  it.each(
    panelSources().map(({ file, text }) => [file, text] as const),
  )("%s derives every command it renders", (file, text) => {
    const source = stripComments(text);
    const literals = [
      // <code>splitch flags create</code>
      ...source.matchAll(/<code>\s*splitch\s+[a-z]/g),
      // "splitch flags create" / `splitch flags create`
      ...source.matchAll(/["'`]splitch\s+[a-z][a-z-]*\s/g),
    ].map((match) => match[0]);

    expect(KNOWN_HARDCODED_COMMANDS.has(file) ? [] : literals).toEqual([]);
  });

  it("still flags a command literal when one is present", () => {
    const offending = "<p>Run <code>splitch client-key get</code></p>";
    expect([...stripComments(offending).matchAll(/<code>\s*splitch\s+[a-z]/g)]).toHaveLength(1);
  });

  it("does not flag prose or doc comments that mention splitch", () => {
    const benign = "/** `splitch flags verify` */\n<p>splitch never pools data across Runs</p>";
    const source = stripComments(benign);
    expect([...source.matchAll(/<code>\s*splitch\s+[a-z]/g)]).toHaveLength(0);
    expect([...source.matchAll(/["'`]splitch\s+[a-z][a-z-]*\s/g)]).toHaveLength(0);
  });
});

describe("VERIFY_PARITY", () => {
  it("points at a real MCP tool, since verify itself is not one", () => {
    expect(getRoute(VERIFY_PARITY.mcp)).toBeDefined();
    expect(getRoute("sdk_verify")?.operationId).toBe("sdk_verify");
  });
});
