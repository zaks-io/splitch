import type { ResourceDeleteBlocker, ResourceDeleteChildType } from "@splitch/contracts";

/**
 * What a dry run found, phrased the way an operator reads it.
 *
 * The Worker answers in the CLI's resource vocabulary (`flag-config`,
 * `entity-privacy`); these are the same concepts said in the Panel's voice. The
 * map is exhaustive on purpose: a child type added to the contract fails the
 * typecheck here rather than reaching the confirmation dialog as a raw storage
 * word an operator has to guess at.
 */
const DELETE_CHILD_LABELS: Record<ResourceDeleteChildType, [string, string]> = {
  experiments: ["Experiment", "Experiments"],
  "flag-config": ["Flag Configuration", "Flag Configurations"],
  "flag-targeting-rules": ["Targeting Rule set", "Targeting Rule sets"],
  flags: ["Flag", "Flags"],
  segments: ["Segment", "Segments"],
  metrics: ["Metric", "Metrics"],
  "entity-privacy": ["privacy record", "privacy records"],
  "privacy-requests": ["privacy request", "privacy requests"],
  apps: ["App", "Apps"],
  environments: ["Environment", "Environments"],
};

export interface DeleteConsequence {
  readonly childType: ResourceDeleteChildType;
  readonly label: string;
  readonly count: number;
  readonly ids: string[];
}

/**
 * Flattens the blocker tree into one line per child type.
 *
 * Ids are carried in full and never truncated: this list is the operator's only
 * chance to notice that the App they are about to destroy contains something
 * they did not expect.
 */
export function deleteConsequences(
  blockers: readonly ResourceDeleteBlocker[],
): DeleteConsequence[] {
  const byType = new Map<ResourceDeleteChildType, string[]>();
  for (const blocker of blockers) {
    const ids = byType.get(blocker.childType) ?? [];
    for (const child of blocker.children) {
      if (!ids.includes(child.id)) ids.push(child.id);
    }
    byType.set(blocker.childType, ids);
  }
  return [...byType].map(([childType, ids]) => {
    const [singular, plural] = DELETE_CHILD_LABELS[childType];
    return {
      childType,
      label: ids.length === 1 ? singular : plural,
      count: ids.length,
      ids,
    };
  });
}
