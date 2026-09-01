import type {
  PanelExperimentDetailOutput,
  PanelExperimentListItem,
} from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it, vi } from "vitest";
import {
  type ExperimentDetailReader,
  type ExperimentEnvironmentCatalog,
  resolveExperimentEnvironmentFromCatalogs,
} from "#lib/experiments/experiment-environment-resolution";

const catalogs: ExperimentEnvironmentCatalog[] = [
  {
    environment: { environmentId: "env_dev", env: "dev" },
    items: [experiment("exp_dev")],
  },
  {
    environment: { environmentId: "env_prod", env: "prod" },
    items: [experiment("exp_prod")],
  },
];

describe("Experiment Environment route resolution", () => {
  it("maps an Environment-specific Experiment ID to the target row by stable key", async () => {
    const detail = vi.fn();
    const result = await resolveExperimentEnvironmentFromCatalogs(
      { detail } as ExperimentDetailReader,
      {
        appId: "app_neuron",
        targetEnvironmentId: "env_dev",
        experimentRef: "exp_prod",
      },
      catalogs,
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        kind: "experiment",
        experimentId: "exp_dev",
        experimentKey: "neuron-model-evaluation",
      },
    });
    expect(detail).not.toHaveBeenCalled();
  });

  it("finds the owning Environment for a pinned Run without pooling Run data", async () => {
    const reader: ExperimentDetailReader = {
      detail: vi.fn(async ({ experimentId }) => ({
        ok: true as const,
        status: 200,
        data: {
          runs: experimentId === "exp_prod" ? [{ id: "run_prod" }] : [],
        } as PanelExperimentDetailOutput,
      })),
    };

    const result = await resolveExperimentEnvironmentFromCatalogs(
      reader,
      {
        appId: "app_neuron",
        targetEnvironmentId: "env_dev",
        experimentRef: "neuron-model-evaluation",
        runId: "run_prod",
      },
      catalogs,
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        kind: "run_elsewhere",
        env: "prod",
        experimentId: "exp_prod",
        experimentKey: "neuron-model-evaluation",
        runId: "run_prod",
      },
    });
  });
});

function experiment(id: string): PanelExperimentListItem {
  return {
    id,
    key: "neuron-model-evaluation",
    name: "Neuron model evaluation",
    status: "running",
    flag: { id: "flag_model", name: "Model" },
    liveRunId: id === "exp_prod" ? "run_prod" : "run_dev",
    hasRuns: true,
    health: null,
  };
}
