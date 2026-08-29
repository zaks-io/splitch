import type { FlagConfigurationSummary } from "@splitch/contracts";
import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import { type FlagConfigSummary, flagListConfigSummary } from "./flag-config-summary";

export type FlagsMatrixCell = FlagConfigSummary;

export type FlagsMatrixRow = {
  definition: {
    id: string;
    key: string;
    variantCount: number;
    variantLabels: Record<string, string>;
  };
  cells: Record<string, FlagsMatrixCell | null>;
};

export type FlagsMatrixData = {
  rows: FlagsMatrixRow[];
  readTruncated: boolean;
  readLimit: number;
};

type MatrixColumn = {
  environmentId: string;
  flags: Pick<FlagsClient, "list">;
};

/**
 * The matrix columns arrive from the browser. Refuse a foreign Environment
 * before starting the parallel list reads so the failure names the invalid scope.
 */
export function assertMatrixEnvironments(
  requested: readonly string[],
  known: ReadonlyArray<{ environmentId: string }>,
): void {
  const knownIds = new Set(known.map((environment) => environment.environmentId));
  const foreign = requested.filter((environmentId) => !knownIds.has(environmentId));
  if (foreign.length > 0) {
    throw new Error(
      `Flags matrix requested ${foreign.length} Environment(s) outside the App: ${foreign.join(", ")}`,
    );
  }
}

export async function readFlagsMatrix(
  columns: ReadonlyArray<MatrixColumn>,
  appId: string,
): Promise<ControlPlaneOperationResult<FlagsMatrixData>> {
  const catalogClient = columns[0];
  if (!catalogClient) throw new Error("Flags matrix requires at least one Environment");

  const listed = await Promise.all(
    columns.map(async (column) => ({
      environmentId: column.environmentId,
      result: await column.flags.list({ appId, environmentId: column.environmentId }),
    })),
  );
  for (const column of listed) {
    if (!column.result.ok) return column.result;
  }
  const catalog = listed[0]?.result;
  if (!catalog?.ok) throw new Error("Flags matrix catalog result is missing");
  const configurations = listed.map((column) => {
    if (!column.result.ok) throw new Error("Flags matrix Environment result is missing");
    const items = column.result.data.items.map((item) => {
      if ("configurations" in item) {
        throw new Error("Flags matrix received hydrated data without requesting include=config");
      }
      return item;
    });
    return {
      environmentId: column.environmentId,
      items: new Map(items.map((item) => [item.id, item])),
    };
  });

  return {
    ok: true,
    status: 200,
    data: {
      readTruncated: catalog.data.readTruncated,
      readLimit: catalog.data.readLimit,
      rows: catalog.data.items.map((definition) => ({
        definition: {
          id: definition.id,
          key: definition.key,
          variantCount: definition.variants.length,
          variantLabels: Object.fromEntries(
            definition.variants.map((variant) => [variant.id, variant.name]),
          ),
        },
        cells: Object.fromEntries(
          configurations.map((column) => [
            column.environmentId,
            configurationCell(column.items, definition.id),
          ]),
        ),
      })),
    },
  };
}

function configurationCell(
  items: Map<string, { flagConfiguration?: FlagConfigurationSummary }>,
  flagId: string,
): FlagsMatrixCell | null {
  const configuration = items.get(flagId)?.flagConfiguration;
  return configuration ? flagListConfigSummary(configuration) : null;
}

export type DriftKind =
  | "in-sync"
  | "enabled-differs"
  | "availability-differs"
  | "rollout-differs"
  | "missing-in-target"
  | "missing-in-source"
  | "unconfigured";

export function classifyDrift(
  source: FlagsMatrixCell | null,
  target: FlagsMatrixCell | null,
): DriftKind {
  if (source === null && target === null) return "unconfigured";
  if (target === null) return "missing-in-target";
  if (source === null) return "missing-in-source";
  if (source.enabled !== target.enabled) return "enabled-differs";
  if (!sameValues(source.availableVariantNames, target.availableVariantNames)) {
    return "availability-differs";
  }
  if (!sameValues(source.rolloutPercentages, target.rolloutPercentages)) {
    return "rollout-differs";
  }
  return "in-sync";
}

export function createDelegationEnvironment<T extends { guarded: boolean }>(
  environments: readonly T[],
): T {
  const environment = environments.find((candidate) => !candidate.guarded) ?? environments[0];
  if (!environment) throw new Error("Flag creation requires at least one Environment");
  return environment;
}

function sameValues<T extends string | number>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
