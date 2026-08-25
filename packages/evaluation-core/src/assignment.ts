import { hashToUnitInterval } from "./hash";
import type { RunConfig } from "./types";

export type Rollout = Array<{ variantName: string; weight: number }>;

export function fractionalEval(salt: string, targetingKey: string, rollout: Rollout): string {
  const point = hashToUnitInterval(`${salt}:${targetingKey}`) * 100;
  let cumulative = 0;
  let lastName = "";
  for (const share of rollout) {
    cumulative += share.weight;
    lastName = share.variantName;
    if (point < cumulative) return share.variantName;
  }
  return lastName;
}

export function assign(run: RunConfig, targetingKey: string): string {
  const rollout = Object.entries(run.allocation)
    .map(([variantName, weight]) => ({ variantName, weight }))
    .sort((a, b) => (a.variantName < b.variantName ? -1 : a.variantName > b.variantName ? 1 : 0));
  return fractionalEval(run.salt, targetingKey, rollout);
}
