import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentListItem,
  PanelExperimentsListInput,
  PanelExperimentsListOutput,
} from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it, vi } from "vitest";
import { readPaletteIndex } from "./palette-index";

const scope = { appId: "app_checkout", environmentId: "env_dev" };

describe("palette index", () => {
  it("projects Flag keys and Experiment names", async () => {
    const flags = flagsClient(false);
    const experiments = experimentsClient();

    await expect(readPaletteIndex(flags, experiments, scope)).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        flags: [{ key: "new-checkout" }],
        flagsTruncated: false,
        experiments: [{ id: "experiment_checkout", name: "New Checkout" }],
      },
    });
    expect(flags.list).toHaveBeenCalledWith({ appId: "app_checkout" });
    expect(experiments.list).toHaveBeenCalledWith(scope);
  });

  it("returns a Flags refusal without reading Experiments", async () => {
    const flags = flagsClient(false);
    flags.list = vi.fn(async () => refused("Flags refused"));
    const experiments = experimentsClient();

    const result = await readPaletteIndex(flags, experiments, scope);

    expect(result).toMatchObject({ ok: false, error: { message: "Flags refused" } });
    expect(experiments.list).not.toHaveBeenCalled();
  });

  it("returns an Experiments refusal after the Flags read", async () => {
    const experiments = experimentsClient();
    experiments.list = vi.fn(async () => refused("Experiments refused"));

    const result = await readPaletteIndex(flagsClient(false), experiments, scope);

    expect(result).toMatchObject({ ok: false, error: { message: "Experiments refused" } });
  });

  it("carries the Flags read truncation signal", async () => {
    const result = await readPaletteIndex(flagsClient(true), experimentsClient(), scope);

    expect(result).toMatchObject({ ok: true, data: { flagsTruncated: true } });
  });
});

function flagsClient(readTruncated: boolean): Pick<FlagsClient, "list"> {
  return {
    list: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: {
        readTruncated,
        readLimit: 200,
        items: [
          {
            id: "flag_checkout",
            appId: "app_checkout",
            key: "new-checkout",
            name: "New Checkout",
            schema: { type: "boolean" as const },
            variants: [
              { id: "var_off", name: "off", value: false },
              { id: "var_on", name: "on", value: true },
            ],
            defaultVariantId: "var_off",
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
          },
        ],
      },
    })),
  };
}

function experimentsClient() {
  const item: PanelExperimentListItem = {
    id: "experiment_checkout",
    name: "New Checkout",
    status: "running",
    flag: { id: "flag_checkout", name: "New Checkout" },
    liveRunId: "run_checkout",
    hasRuns: true,
    health: null,
  };
  return {
    list: vi.fn<
      (
        input: PanelExperimentsListInput,
      ) => Promise<ControlPlaneOperationResult<PanelExperimentsListOutput>>
    >(async () => ({ ok: true as const, status: 200, data: { items: [item] } })),
  };
}

function refused(message: string) {
  return {
    ok: false as const,
    status: 403,
    error: { code: "FORBIDDEN" as const, message, details: {} },
  };
}
