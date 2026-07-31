import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Server functions that write an existing Experiment or open one of its Runs. */
const EXPERIMENT_WRITES = [
  "updateControlPanelExperiment",
  "stageAndStartControlPanelExperimentRun",
];

/** Where those server functions are declared; the declaration is not a caller. */
const DECLARATION = "lib/control-plane-experiment-functions.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

function experimentWriters(): { path: string; source: string }[] {
  return sourceFiles(SRC)
    .map((path) => ({ path: path.slice(SRC.length), source: readFileSync(path, "utf8") }))
    .filter(({ path }) => path !== DECLARATION)
    .filter(({ source }) => EXPERIMENT_WRITES.some((fn) => source.includes(`${fn}({`)));
}

/**
 * The Experiment detail is served by a React Query cache, so `router.invalidate()`
 * alone re-runs the loaders and leaves the pre-write row on screen — the operator
 * reads back the state before their own write (ADR-0036). `useExperimentDetailRefresh`
 * is the one read-back that clears both, and SPL-264 is what it costs when a surface
 * uses only half of it: a started Run was invisible in Run history until a reload.
 *
 * This is the grep half of the proof; `e2e/control-panel/experiments-setup.spec.ts`
 * is the rendered half, and it can only cover a field some mounted surface re-reads.
 */
describe("every Experiment write reads the Experiment back through one refresh", () => {
  it("finds the Experiment-writing surfaces", () => {
    expect(
      experimentWriters()
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "components/experiment-measurement-form.tsx",
      "components/experiment-metadata-form.tsx",
      "lib/use-experiment-draft-patch.ts",
      "lib/use-experiment-run-start.ts",
    ]);
  });

  it("routes every one of them through useExperimentDetailRefresh", () => {
    const offenders = experimentWriters()
      .filter(({ source }) => !source.includes("useExperimentDetailRefresh"))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("leaves no second read-back mechanism beside it", () => {
    const offenders = experimentWriters()
      .filter(({ source }) => source.includes("router.invalidate()"))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
