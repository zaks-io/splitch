import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walkRepoFiles } from "../../../scripts/lib/repo-file-sweep.mjs";
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
  // Match the sentence under any quote style (double, single, or template).
  const needle = KILL_SWITCH_OFF_EXEMPTION;
  const hits: string[] = [];
  walkRepoFiles(REPO_ROOT, (relativePath, absolutePath) => {
    if (!extensions.some((ext) => relativePath.endsWith(ext))) return;
    if (readFileSync(absolutePath, "utf8").includes(needle)) hits.push(relativePath);
  });
  return hits.sort();
}
