import {
  type Condition,
  ConditionSchema,
  type ResolvedTargetingRule,
  ResolvedTargetingRuleSchema,
  type TargetingRule,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";

export type TargetingRuleResolution =
  | { ok: true; rules: ResolvedTargetingRule[] }
  | { ok: false; missingSegmentIds: string[] };

export class SegmentNotFoundError extends Error {
  readonly missingSegmentIds: string[];

  constructor(missingSegmentIds: string[]) {
    super(`Targeting Rule references missing Segment(s): ${missingSegmentIds.join(", ")}`);
    this.name = "SegmentNotFoundError";
    this.missingSegmentIds = missingSegmentIds;
  }
}

export function requireResolvedTargetingRules(
  resolution: TargetingRuleResolution,
): ResolvedTargetingRule[] {
  if (!resolution.ok) throw new SegmentNotFoundError(resolution.missingSegmentIds);
  return resolution.rules;
}

/** Resolve authoring Segment references once, before any rule reaches KV or a Run. */
export async function resolveTargetingRules(
  repo: Repository,
  appId: string,
  rules: readonly TargetingRule[],
): Promise<TargetingRuleResolution> {
  const segmentIds = [
    ...new Set(rules.flatMap((rule) => (rule.segmentId ? [rule.segmentId] : []))),
  ];
  const segments = await repo.flags.listSegmentsByIds(appScope(appId), segmentIds);
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const missingSegmentIds = segmentIds.filter((id) => !byId.has(id));
  if (missingSegmentIds.length > 0) return { ok: false, missingSegmentIds };

  return {
    ok: true,
    rules: rules.map((rule) => {
      let segmentConditions: Condition[] = [];
      if (rule.segmentId) {
        const segment = byId.get(rule.segmentId);
        if (!segment) throw new Error("Targeting Rule Segment disappeared during resolution");
        segmentConditions = ConditionSchema.array().parse(JSON.parse(segment.conditions));
      }
      return ResolvedTargetingRuleSchema.parse({
        id: rule.id,
        flagId: rule.flagId,
        priority: rule.priority,
        conditions: [...rule.conditions, ...segmentConditions],
        variantId: rule.variantId,
        ...(rule.percentageRollout !== undefined
          ? { percentageRollout: rule.percentageRollout }
          : {}),
      });
    }),
  };
}
