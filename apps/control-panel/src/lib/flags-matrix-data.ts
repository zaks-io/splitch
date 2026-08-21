import type { ControlPlaneOperationResult, FlagsClient } from "@splitch/control-plane-sdk";
import { flagConfigSummary, type FlagConfigSummary } from "./flag-config-summary";

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
  flags: Pick<FlagsClient, "list" | "getConfig">;
};

export async function readFlagsMatrix(
  columns: ReadonlyArray<MatrixColumn>,
  appId: string,
): Promise<ControlPlaneOperationResult<FlagsMatrixData>> {
  const catalogClient = columns[0];
  if (!catalogClient) throw new Error("Flags matrix requires at least one Environment");

  const listed = await catalogClient.flags.list({ appId });
  if (!listed.ok) return listed;

  const configurations = await Promise.all(
    columns.map(async (column) => ({
      environmentId: column.environmentId,
      results: await Promise.all(
        listed.data.items.map((definition) =>
          column.flags.getConfig({
            appId,
            environmentId: column.environmentId,
            flagId: definition.id,
          }),
        ),
      ),
    })),
  );

  for (const column of configurations) {
    const failed = column.results.find(
      (result) => !result.ok && result.error.code !== "FLAG_NOT_FOUND",
    );
    if (failed && !failed.ok) return failed;
  }

  return {
    ok: true,
    status: 200,
    data: {
      readTruncated: listed.data.readTruncated,
      readLimit: listed.data.readLimit,
      rows: listed.data.items.map((definition, definitionIndex) => ({
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
            configurationCell(column.results, definitionIndex),
          ]),
        ),
      })),
    },
  };
}

function configurationCell(
  results: Awaited<ReturnType<FlagsClient["getConfig"]>>[],
  index: number,
): FlagsMatrixCell | null {
  const result = results[index];
  if (!result) throw new Error(`Flags matrix Configuration result ${index} is missing`);
  return result.ok ? flagConfigSummary(result.data) : null;
}

export type DriftKind =
  | "in-sync"
  | "enabled-differs"
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
  if (!sameNumbers(source.rolloutPercentages, target.rolloutPercentages)) {
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

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
