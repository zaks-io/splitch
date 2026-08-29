import { type EnvironmentPolicy, KILL_SWITCH_OFF_EXEMPTION } from "@splitch/sdk/control-plane";
import { humanizeLabel } from "./format-payload.js";

/**
 * Human-readable Environment Policy for CLI `env-policy get` / `set` when
 * `--json` is off. Surfaces the ADR-0029 kill-switch-off exemption next to the
 * enabled-state level so a confirm Policy is not read as gating a disable.
 */
export function formatEnvironmentPolicy(policy: EnvironmentPolicy): string {
  return [
    level("variantAvailability", policy.variantAvailability),
    level("targetingRolloutValue", policy.targetingRolloutValue),
    level("enabledState", policy.enabledState),
    `  ${KILL_SWITCH_OFF_EXEMPTION}`,
    level("startExperimentRun", policy.startExperimentRun),
  ].join("\n");
}

/** Change types are labelled the way every other CLI field is. */
function level(changeType: keyof EnvironmentPolicy, value: string): string {
  return `${humanizeLabel(changeType)}: ${value}`;
}

export function isEnvironmentPolicy(value: unknown): value is EnvironmentPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isPolicyLevel(record.variantAvailability) &&
    isPolicyLevel(record.targetingRolloutValue) &&
    isPolicyLevel(record.enabledState) &&
    isPolicyLevel(record.startExperimentRun)
  );
}

function isPolicyLevel(value: unknown): value is EnvironmentPolicy[keyof EnvironmentPolicy] {
  return value === "allow" || value === "confirm";
}
