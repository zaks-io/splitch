import { z } from "zod";

/**
 * Machine-stable recovery guidance carried in `details` on operational 409s. An
 * agent branches on the token, never on prose. Stable across message wording and
 * localization.
 */
export const recommendedActions = [
  "CREATE_NEW_RUN",
  "END_RUNNING_RUN_FIRST",
  "START_A_RUN",
  "EDIT_DRAFT_THEN_START",
  "ADD_VARIANT_TO_ENV",
  "RETRY_AFTER",
  "REVIEW_APPROVAL_REQUEST",
  "REFRESH_AND_REPROPOSE",
  "RETRY_REVIEW",
  "CHOOSE_DIFFERENT_SLUG",
  "CHOOSE_DIFFERENT_KEY",
  "READ_PER_ENVIRONMENT",
] as const;

export const RecommendedActionSchema = z.enum(recommendedActions);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Environment-Policy change types (ADR-0029). Approval errors carry these so
 * the caller can render the immutable Policy context without guessing.
 */
export const policyChangeTypes = [
  "variant_availability",
  "targeting_rollout_value",
  "enabled_state",
  "start_experiment_run",
] as const;

export const PolicyChangeTypeSchema = z.enum(policyChangeTypes);
export type PolicyChangeType = z.infer<typeof PolicyChangeTypeSchema>;
