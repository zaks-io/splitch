import { describe, expect, it } from "vitest";
import {
  canonicalExperimentHref,
  experimentKeyRouteRef,
  experimentNotFoundData,
  experimentRouteReference,
} from "#lib/experiments/experiment-route-navigation";

const scope = { orgSlug: "zaks-io", appSlug: "neuron", env: "dev" };

describe("Experiment route navigation", () => {
  it("preserves the selected Run, tab, search, and hash when canonicalizing", () => {
    expect(
      canonicalExperimentHref(
        scope,
        "assistant-model",
        "/zaks-io/neuron/dev/experiments/exp_old/runs/run_1/results?window=all#decision",
        "run_1",
      ),
    ).toBe(
      "/zaks-io/neuron/dev/experiments/~assistant-model/runs/run_1/results?window=all#decision",
    );
  });

  it("namespaces every stable key away from static Experiment routes", () => {
    expect(experimentKeyRouteRef("new")).toBe("~new");
    expect(experimentRouteReference("~new")).toEqual({
      experimentRef: "new",
      referenceKind: "key",
    });
    expect(experimentRouteReference("exp_legacy")).toEqual({
      experimentRef: "exp_legacy",
      referenceKind: "legacy",
    });
  });

  it("builds the owning Environment action for a Run found elsewhere", () => {
    expect(
      experimentNotFoundData(
        {
          kind: "run_elsewhere",
          env: "prod",
          experimentId: "exp_prod",
          experimentKey: "assistant-model",
          runId: "run_1",
        },
        scope,
        "/zaks-io/neuron/dev/experiments/assistant-model/runs/run_1/results",
      ),
    ).toEqual({
      kind: "run_elsewhere",
      env: "dev",
      sourceEnv: "prod",
      href: "/zaks-io/neuron/prod/experiments/~assistant-model/runs/run_1/results",
    });
  });

  it("maps unknown Experiment and Run references to the correct not-found state", () => {
    expect(experimentNotFoundData({ kind: "experiment_not_found" }, scope, "/ignored")).toEqual({
      kind: "experiment",
      env: "dev",
    });
    expect(
      experimentNotFoundData(
        { kind: "run_not_found", experimentKey: "assistant-model" },
        scope,
        "/ignored",
      ),
    ).toEqual({ kind: "run", env: "dev" });
  });
});
