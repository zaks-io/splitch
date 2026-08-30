import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { createServerFn } from "@tanstack/react-start";
import {
  authorizedExperimentsClient,
  authorizedFlagsClient,
} from "#lib/auth/panel-authorized-clients";
import { readPaletteIndex, type PaletteIndex } from "#lib/shell/palette-index";

export const loadControlPanelPaletteIndex = createServerFn({ method: "GET" })
  .validator((data: { appId: string; environmentId: string }) => data)
  .handler(async ({ data }): Promise<ControlPlaneOperationResult<PaletteIndex>> => {
    const flags = await authorizedFlagsClient(data.environmentId);
    if (!flags.ok) return flags.result;
    const experiments = await authorizedExperimentsClient();
    if (!experiments.ok) return experiments.result;
    return readPaletteIndex(flags.client, experiments.client, data);
  });
