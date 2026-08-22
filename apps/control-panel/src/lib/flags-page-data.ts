import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import { type FlagConfigSummary, flagConfigSummary } from "./flag-config-summary";

export type FlagsPageItem = {
  definition: {
    id: string;
    key: string;
    variantCount: number;
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
  flags: Pick<FlagsClient, "list" | "getConfig">,
  scope: { appId: string; environmentId: string },
): Promise<ControlPlaneOperationResult<FlagsPageData>> {
  const listed = await flags.list({ appId: scope.appId });
  if (!listed.ok) return listed;

  const configurations = await Promise.all(
    listed.data.items.map((definition) =>
      flags.getConfig({
        appId: scope.appId,
        environmentId: scope.environmentId,
        flagId: definition.id,
      }),
    ),
  );

  const failed = configurations.find(
    (result) => !result.ok && result.error.code !== "FLAG_NOT_FOUND",
  );
  if (failed && !failed.ok) return failed;

  return {
    ok: true,
    status: 200,
    data: {
      readTruncated: listed.data.readTruncated,
      readLimit: listed.data.readLimit,
      items: listed.data.items.map((definition, index) => {
        const configuration = configurations[index];
        return {
          definition: {
            id: definition.id,
            key: definition.key,
            variantCount: definition.variants.length,
          },
          configuration: configuration?.ok ? flagConfigSummary(configuration.data) : null,
        };
      }),
    },
  };
}
