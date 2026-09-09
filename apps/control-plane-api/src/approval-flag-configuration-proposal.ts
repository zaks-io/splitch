import {
  type ApprovalDiffEntry,
  type ApprovalRequest,
  FlagConfigResponseSchema,
} from "@splitch/contracts";
import type { FlagConfigResult } from "./config-store-types";

export function flagConfigurationApplication(request: ApprovalRequest): {
  proposed: FlagConfigResult;
  diffEntries: ApprovalDiffEntry[];
} {
  if (request.operation !== "experiment_winner_promote") {
    return {
      proposed: request.diff.proposed as unknown as FlagConfigResult,
      diffEntries: request.diff.entries,
    };
  }
  const wrapper = request.diff.proposed as Record<string, unknown>;
  return {
    proposed: FlagConfigResponseSchema.parse(wrapper.flagConfiguration),
    diffEntries: request.diff.entries
      .filter((entry) => entry.path.startsWith("/flagConfiguration/"))
      .map((entry) => ({
        ...entry,
        path: entry.path.slice("/flagConfiguration".length),
      })),
  };
}
