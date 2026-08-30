import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import type {
  PanelExperimentsListInput,
  PanelExperimentsListOutput,
} from "@splitch/control-plane-sdk/panel-experiments";

export type PaletteIndex = {
  flags: { key: string }[];
  flagsTruncated: boolean;
  experiments: { id: string; name: string }[];
};

type PaletteExperimentsClient = {
  list(
    input: PanelExperimentsListInput,
  ): Promise<ControlPlaneOperationResult<PanelExperimentsListOutput>>;
};

export async function readPaletteIndex(
  flagsClient: Pick<FlagsClient, "list">,
  experimentsClient: PaletteExperimentsClient,
  scope: { appId: string; environmentId: string },
): Promise<ControlPlaneOperationResult<PaletteIndex>> {
  const flags = await flagsClient.list({ appId: scope.appId });
  if (!flags.ok) return flags;

  const experiments = await experimentsClient.list(scope);
  if (!experiments.ok) return experiments;

  return {
    ok: true,
    status: 200,
    data: {
      flags: flags.data.items.map((definition) => ({ key: definition.key })),
      flagsTruncated: flags.data.readTruncated,
      experiments: experiments.data.items.map((experiment) => ({
        id: experiment.id,
        name: experiment.name,
      })),
    },
  };
}
