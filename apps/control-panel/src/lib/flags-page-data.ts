import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";

export type FlagsPageItem = {
  definition: {
    id: string;
    key: string;
    variantCount: number;
  };
  configuration: {
    enabled: boolean;
    availableVariantCount: number;
    rolloutPercentages: number[];
  } | null;
};

export type FlagsPageData = {
  items: FlagsPageItem[];
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
      items: listed.data.items.map((definition, index) => {
        const configuration = configurations[index];
        return {
          definition: {
            id: definition.id,
            key: definition.key,
            variantCount: definition.variants.length,
          },
          configuration: configuration?.ok
            ? {
                enabled: configuration.data.enabled,
                availableVariantCount: configuration.data.availableVariantNames.length,
                rolloutPercentages: configuration.data.targetingRules.flatMap((rule) =>
                  rule.percentageRollout ? [rule.percentageRollout.percentage] : [],
                ),
              }
            : null,
        };
      }),
    },
  };
}
