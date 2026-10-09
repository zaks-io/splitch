import { z } from "zod";

/**
 * Structured before/after for one flag_change_events row.
 *
 * The Control Plane projects stored `diff_json` into this wire shape; it never
 * fills a missing field from live config or from another row.
 */

export const FlagChangeActionSchema = z.enum(["created", "updated", "deleted"]);
export type FlagChangeAction = z.infer<typeof FlagChangeActionSchema>;

export const FlagChangeTargetTypeSchema = z.enum([
  "flag",
  "flag_config",
  "variant",
  "targeting_rule",
  "run",
]);
export type FlagChangeTargetType = z.infer<typeof FlagChangeTargetTypeSchema>;

export const FlagChangeFieldDiffSchema = z
  .object({
    name: z.string(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();
export type FlagChangeFieldDiff = z.infer<typeof FlagChangeFieldDiffSchema>;

export const FlagChangeDiffSchema = z
  .object({
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    fields: z.array(FlagChangeFieldDiffSchema),
    /**
     * Set only for historical deletion rows whose triggers store `diff_json`
     * NULL. Missing payloads on any other action fail the read.
     */
    unavailable: z.literal(true).optional(),
  })
  .strict();
export type FlagChangeDiff = z.infer<typeof FlagChangeDiffSchema>;
