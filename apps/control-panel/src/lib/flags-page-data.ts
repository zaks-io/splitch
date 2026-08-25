import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import { type FlagConfigSummary, flagListConfigSummary } from "./flag-config-summary";

export type FlagsPageItem = {
  definition: {
    id: string;
    key: string;
    variantCount: number;
    variantLabels: Record<string, string>;
  };
  configuration: FlagConfigSummary | null;
};

export type FlagsPageData = {
  items: FlagsPageItem[];
  /**
   * The Worker's catalog read hit its ceiling, so `items` is the newest page of
   * this App's Flags and not all of them. Carried through rather than recomputed
   * from `items.length`: only the read that issued it can tell a full page from a
   * complete catalog of the same size (ADR-0036).
   */
  readTruncated: boolean;
  readLimit: number;
};

export async function readFlagsPage(
  flags: Pick<FlagsClient, "list">,
  scope: { appId: string; environmentId: string },
): Promise<ControlPlaneOperationResult<FlagsPageData>> {
  const listed = await flags.list(scope);
  if (!listed.ok) return listed;

  return {
    ok: true,
    status: 200,
    data: {
      readTruncated: listed.data.readTruncated,
      readLimit: listed.data.readLimit,
      items: listed.data.items.map((definition) => {
        return {
          definition: {
            id: definition.id,
            key: definition.key,
            variantCount: definition.variants.length,
            variantLabels: Object.fromEntries(
              definition.variants.map((variant) => [variant.id, variant.name]),
            ),
          },
          configuration: definition.flagConfiguration
            ? flagListConfigSummary(definition.flagConfiguration)
            : null,
        };
      }),
    },
  };
}
