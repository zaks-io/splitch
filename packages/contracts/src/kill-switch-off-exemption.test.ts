import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KILL_SWITCH_OFF_EXEMPTION } from "./kill-switch-off-exemption";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFINITION_RELATIVE = "packages/contracts/src/kill-switch-off-exemption.ts";
const SPEC_RELATIVE = "docs/spec/control-plane/endpoints-flag-segment.md";

describe("KILL_SWITCH_OFF_EXEMPTION", () => {
  it("is user-facing: no Policy field plumbing vocabulary", () => {
    expect(KILL_SWITCH_OFF_EXEMPTION.startsWith("Turning a Flag Config off")).toBe(true);
    expect(KILL_SWITCH_OFF_EXEMPTION).toContain("without approval");
    expect(KILL_SWITCH_OFF_EXEMPTION).not.toMatch(/enabled_state|enabledState|changeTypes/);
  });

  it("lives in exactly one TypeScript definition site", () => {
    const hits = findLiteralHits([".ts", ".tsx"]);
    const definitionHits = hits.filter((path) => path === DEFINITION_RELATIVE);
    const otherHits = hits.filter((path) => path !== DEFINITION_RELATIVE);
    expect(definitionHits).toEqual([DEFINITION_RELATIVE]);
    expect(otherHits).toEqual([]);
  });

  it("is quoted verbatim in the flag-config update endpoint spec", () => {
    const spec = readFileSync(join(REPO_ROOT, SPEC_RELATIVE), "utf8");
    expect(spec).toContain(KILL_SWITCH_OFF_EXEMPTION);
  });
});

function findLiteralHits(extensions: readonly string[]): string[] {
  const needle = JSON.stringify(KILL_SWITCH_OFF_EXEMPTION);
  const hits: string[] = [];
  walk(REPO_ROOT, (absolutePath) => {
    if (!extensions.some((ext) => absolutePath.endsWith(ext))) return;
    const relativePath = relative(REPO_ROOT, absolutePath);
    if (shouldSkip(relativePath)) return;
    const contents = readFileSync(absolutePath, "utf8");
    if (contents.includes(needle)) hits.push(relativePath);
  });
  return hits.sort();
}

function shouldSkip(relativePath: string): boolean {
  return (
    relativePath.startsWith("node_modules/") ||
    relativePath.includes("/node_modules/") ||
    relativePath.startsWith("dist/") ||
    relativePath.includes("/dist/") ||
    relativePath.startsWith(".git/") ||
    relativePath.includes("/coverage/") ||
    relativePath.includes("/.turbo/") ||
    relativePath.includes("/.wrangler/") ||
    relativePath.includes("/.output/") ||
    relativePath.endsWith(".snap")
  );
}

function walk(dir: string, visit: (absolutePath: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === ".git" ||
        entry === "dist" ||
        entry === "coverage"
      ) {
        continue;
      }
      walk(absolutePath, visit);
      continue;
    }
    visit(absolutePath);
  }
}
