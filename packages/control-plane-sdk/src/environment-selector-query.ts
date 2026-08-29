import type { EnvironmentSelectorInput } from "@splitch/contracts/route-types";

export function environmentSelectorQuery(input: EnvironmentSelectorInput) {
  return input.by === undefined ? {} : { query: { by: input.by } };
}
