import { z } from "zod";

/**
 * Canonical Experiment Entity type vocabulary (`targetingKeyType` / wire `idType`).
 * Source: docs/spec/contracts/leaf-schemas-experiment.md and
 * docs/spec/domain-model/entities.md.
 *
 * Create/patch requests must enumerate only these values. The leaf and storage
 * shapes stay as plain strings so historical rows with an unrecognized value
 * remain readable; write-time validation is the fail-loud gate.
 */
export const targetingKeyTypes = ["user", "session", "workspace"] as const;

export const TargetingKeyTypeSchema = z.enum(targetingKeyTypes, {
  error: () => `allowed targetingKeyType values: ${targetingKeyTypes.join(", ")}`,
});

export type TargetingKeyType = z.infer<typeof TargetingKeyTypeSchema>;
