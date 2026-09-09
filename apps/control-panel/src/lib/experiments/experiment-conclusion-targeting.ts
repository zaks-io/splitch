import { type TargetingRuleInput, TargetingRuleInputSchema } from "@splitch/contracts";

export function parseConclusionTargetingRules(json: string): TargetingRuleInput[] {
  return TargetingRuleInputSchema.array().parse(JSON.parse(json));
}
