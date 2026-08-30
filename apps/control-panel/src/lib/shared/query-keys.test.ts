import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deltaNudgeEntities } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { nudgeInvalidationPrefix, queryKeys } from "#lib/shared/query-keys";

const scope = { appId: "app_1", environmentId: "env_prod" };

describe("Control Panel query keys", () => {
  it("builds every pinned key from the App and Environment root", () => {
    expect([
      queryKeys.app.root(scope.appId, scope.environmentId),
      queryKeys.environment.exposureStatus(scope.appId, scope.environmentId),
      queryKeys.experiment.prefix(scope.appId, scope.environmentId),
      queryKeys.experiment.list(scope.appId, scope.environmentId),
      queryKeys.experiment.detailPrefix(scope.appId, scope.environmentId, "exp_1"),
      queryKeys.experiment.detail(scope.appId, scope.environmentId, "exp_1"),
      queryKeys.experiment.runs(scope.appId, scope.environmentId, "exp_1"),
      queryKeys.experiment.run(scope.appId, scope.environmentId, "exp_1", "run_1"),
      queryKeys.flag.prefix(scope.appId, scope.environmentId),
      queryKeys.flag.list(scope.appId, scope.environmentId),
      queryKeys.flag.detailPrefix(scope.appId, scope.environmentId, "flag_1"),
      queryKeys.flag.detail(scope.appId, scope.environmentId, "flag_1"),
      queryKeys.variant.prefix(scope.appId, scope.environmentId),
      queryKeys.variant.list(scope.appId, scope.environmentId, "flag_1"),
      queryKeys.flag.variants(scope.appId, scope.environmentId, "flag_1"),
      queryKeys.metric.prefix(scope.appId, scope.environmentId),
      queryKeys.metric.list(scope.appId, scope.environmentId),
      queryKeys.metric.detail(scope.appId, scope.environmentId, "metric_1"),
      queryKeys.segment.prefix(scope.appId, scope.environmentId),
      queryKeys.segment.list(scope.appId, scope.environmentId),
      queryKeys.segment.detail(scope.appId, scope.environmentId, "segment_1"),
    ]).toEqual([
      ["app", "app_1", "env", "env_prod"],
      ["app", "app_1", "env", "env_prod", "environment", "exposure-status"],
      ["app", "app_1", "env", "env_prod", "experiment"],
      ["app", "app_1", "env", "env_prod", "experiment", "list"],
      ["app", "app_1", "env", "env_prod", "experiment", "exp_1"],
      ["app", "app_1", "env", "env_prod", "experiment", "exp_1", "detail"],
      ["app", "app_1", "env", "env_prod", "experiment", "exp_1", "run"],
      ["app", "app_1", "env", "env_prod", "experiment", "exp_1", "run", "run_1"],
      ["app", "app_1", "env", "env_prod", "flag"],
      ["app", "app_1", "env", "env_prod", "flag", "list"],
      ["app", "app_1", "env", "env_prod", "flag", "flag_1"],
      ["app", "app_1", "env", "env_prod", "flag", "flag_1", "detail"],
      ["app", "app_1", "env", "env_prod", "variant"],
      ["app", "app_1", "env", "env_prod", "variant", "flag_1", "list"],
      ["app", "app_1", "env", "env_prod", "variant", "flag_1", "list"],
      ["app", "app_1", "env", "env_prod", "metric"],
      ["app", "app_1", "env", "env_prod", "metric", "list"],
      ["app", "app_1", "env", "env_prod", "metric", "metric_1", "detail"],
      ["app", "app_1", "env", "env_prod", "segment"],
      ["app", "app_1", "env", "env_prod", "segment", "list"],
      ["app", "app_1", "env", "env_prod", "segment", "segment_1", "detail"],
    ]);
  });

  const nudgeCases = [
    ["flag", queryKeys.flag.prefix(scope.appId, scope.environmentId)],
    ["experiment", queryKeys.experiment.prefix(scope.appId, scope.environmentId)],
    ["run", queryKeys.experiment.prefix(scope.appId, scope.environmentId)],
    ["segment", queryKeys.segment.prefix(scope.appId, scope.environmentId)],
  ] as const;

  it("maps every canonical nudge entity", () => {
    expect(nudgeCases.map(([entity]) => entity)).toEqual(deltaNudgeEntities);
  });

  it.each(nudgeCases)("maps %s nudges to the entity prefix", (entity, expected) => {
    expect(nudgeInvalidationPrefix[entity](scope.appId, scope.environmentId)).toEqual(expected);
  });

  it("does not allow inline TanStack query keys outside this factory", () => {
    const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const sources = sourceFiles(sourceRoot).filter((path) => !path.endsWith(".test.ts"));
    const inlineKey = /queryKey\s*:\s*\[/;

    for (const source of sources) {
      expect(readFileSync(source, "utf8"), source).not.toMatch(inlineKey);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
