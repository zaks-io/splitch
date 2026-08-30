import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Server functions that write an existing Experiment or open one of its Runs. */
const EXPERIMENT_WRITES = [
  "updateControlPanelExperiment",
  "stageAndStartControlPanelExperimentRun",
];

/** Where those server functions are declared; the declaration is not a caller. */
const DECLARATION = "lib/experiments/control-plane-experiment-functions.ts";

/** `const refresh = useExperimentDetailRefresh(...)`, capturing whatever it was bound to. */
const BOUND_REFRESH = /const (\w+) = useExperimentDetailRefresh\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

/**
 * Comments only, so the match below can be the bare identifier and still not fire
 * on prose. `experiment-draft-run-step.tsx` names a write in its doc comment to
 * say it does NOT call one directly, and that sentence must not make it a caller.
 * Deliberately conservative — a trailing `// name` after code survives, which is
 * a false red, never a false green.
 */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The bare identifier, not a call shape. Requiring `name({` would see only call
 * sites that inline their object argument, so hoisting the payload to a `const`
 * because it outgrew the line width — the ordinary thing to do — would take the
 * file out of the guard entirely, along with an aliased import or a wrapper module.
 */
function experimentWriters(): { path: string; source: string }[] {
  return sourceFiles(SRC)
    .map((path) => ({ path: path.slice(SRC.length), source: code(readFileSync(path, "utf8")) }))
    .filter(({ path }) => path !== DECLARATION)
    .filter(({ source }) => EXPERIMENT_WRITES.some((fn) => source.includes(fn)));
}

/**
 * The Experiment detail is served by a React Query cache, so `router.invalidate()`
 * alone re-runs the loaders and leaves the pre-write row on screen — the operator
 * reads back the state before their own write (ADR-0036). `useExperimentDetailRefresh`
 * is the one read-back that clears both, and SPL-264 is what it costs when a surface
 * uses only half of it: a started Run was invisible in Run history until a reload.
 *
 * This is the whole regression story for the two forms SPL-268 fixed, because their
 * staleness is currently latent: nothing mounted re-reads `conversionWindowMs`,
 * `description`, `owner`, or `tags`, so no Playwright assertion can fail without the
 * fix. Latent is not unreachable, and it is one commit away from being neither. The
 * router builds a bare `new QueryClient()` (`router.tsx:8`), so a newly mounted
 * `useSuspenseQuery` subscriber renders the cached value first and refetches behind
 * it — and any component seeding `useState` from that first render keeps the stale
 * value for good. Add a client-side `<Link>` between the setup tab and the draft
 * wizard (the path is a full document load today, which is the only reason this
 * hides), or render one of those fields read-only anywhere, and it becomes
 * assertable. Do not read "latent" here as "cannot be observed".
 *
 * `e2e/control-panel/experiments-setup.spec.ts` is the rendered half of the proof,
 * and it can only cover a field some mounted surface actually re-reads.
 */
describe("every Experiment write reads the Experiment back through one refresh", () => {
  it("finds the Experiment-writing surfaces", () => {
    expect(
      experimentWriters()
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "components/experiments/experiment-measurement-form.tsx",
      "components/experiments/experiment-metadata-form.tsx",
      "lib/experiments/use-experiment-draft-patch.ts",
      "lib/experiments/use-experiment-run-start.ts",
    ]);
  });

  it("routes every one of them through an awaited useExperimentDetailRefresh", () => {
    // The bound name has to be awaited, not merely imported: a file that names the
    // hook in an import it never calls does no read-back at all, and this test has
    // to stand on its own rather than leaning on the pinned list above.
    const offenders = experimentWriters()
      .filter(({ source }) => {
        const bound = BOUND_REFRESH.exec(source)?.[1];
        return bound === undefined || !source.includes(`await ${bound}()`);
      })
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
