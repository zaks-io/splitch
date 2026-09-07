import type {
  ConvexExposureVerificationResult,
  ConvexServerExposureItem,
  ConvexServerExposureResponse,
} from "@splitch/contracts";

export const INTEGRATION_EXPOSURE_BATCH_CONCURRENCY = 4;

interface IndexedExposure {
  readonly index: number;
  readonly item: ConvexServerExposureItem;
}

/**
 * Runs independent items concurrently while preserving request order for both
 * claim identity and Assignment Store identity. Assignment identity excludes
 * runId because holdover state deliberately spans Experiment Runs.
 */
export async function mapIndependentExposureItems<Result>(
  items: readonly ConvexServerExposureItem[],
  run: (item: ConvexServerExposureItem, index: number) => Promise<Result>,
): Promise<Result[]> {
  const groups = conflictGroups(items);
  const settled = await mapWithConcurrency(
    groups,
    INTEGRATION_EXPOSURE_BATCH_CONCURRENCY,
    async (group) => {
      const results: Array<{ readonly index: number; readonly result: Result }> = [];
      for (const entry of group) {
        results.push({ index: entry.index, result: await run(entry.item, entry.index) });
      }
      return results;
    },
  );
  return settled
    .flat()
    .sort((left, right) => left.index - right.index)
    .map(({ result }) => result);
}

export async function settleVerifiedIntegrationExposureBatch(
  sourceKind: "convex" | "cloudflare",
  exposures: readonly ConvexServerExposureItem[],
  verifications: readonly ConvexExposureVerificationResult[],
  run: (
    verification: ConvexExposureVerificationResult,
    item: ConvexServerExposureItem,
  ) => Promise<ConvexServerExposureResponse["results"][number]>,
): Promise<ConvexServerExposureResponse["results"]> {
  if (verifications.length !== exposures.length) {
    throw new Error(
      `evaluation-api: ${sourceKind} Exposure verification returned ${String(verifications.length)} results for ${String(exposures.length)} items`,
    );
  }
  return mapIndependentExposureItems(exposures, (item, index) => {
    const verification = verifications[index];
    if (!verification) {
      throw new Error(`evaluation-api: missing ${sourceKind} verification at index ${index}`);
    }
    return run(verification, item);
  });
}

function conflictGroups(items: readonly ConvexServerExposureItem[]): IndexedExposure[][] {
  const parents = items.map((_, index) => index);
  const ownerByConflictKey = new Map<string, number>();

  for (const [index, item] of items.entries()) {
    for (const key of conflictKeys(item)) {
      const owner = ownerByConflictKey.get(key);
      if (owner === undefined) ownerByConflictKey.set(key, index);
      else union(parents, owner, index);
    }
  }

  const groups = new Map<number, IndexedExposure[]>();
  for (const [index, item] of items.entries()) {
    const root = find(parents, index);
    const group = groups.get(root) ?? [];
    group.push({ index, item });
    groups.set(root, group);
  }
  return [...groups.values()];
}

function conflictKeys(item: ConvexServerExposureItem): readonly string[] {
  return [
    JSON.stringify(["claim", item.exposureId]),
    JSON.stringify([
      "assignment",
      item.experimentId,
      item.evaluationContext.idType,
      item.evaluationContext.targetingKey,
    ]),
  ];
}

function find(parents: number[], index: number): number {
  const parent = parents[index];
  if (parent === undefined) throw new Error(`missing Exposure batch parent at index ${index}`);
  if (parent === index) return index;
  const root = find(parents, parent);
  parents[index] = root;
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot === rightRoot) return;
  parents[rightRoot] = leftRoot;
}

/** Order-preserving bounded map that stops pulling new work after a failure. */
async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  let failure: { readonly cause: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = await run(item);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failure) throw failure.cause;
  return results;
}
