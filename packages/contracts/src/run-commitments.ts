import { z } from "zod";
import { canonicalHash } from "./canonical-json";
import { resultTokenStats } from "./result-token-stats";
import type { StatsOutput } from "./stats-result-contract";

/**
 * What a Run commits to at Start beyond its assignment config (ADR-0059): the
 * analysis version that will read its evidence, the sequential tuning target,
 * and the planned duration the decision gate measures evidence against.
 *
 * A Run started before these were recorded is a legacy Run. It is read under a
 * labeled compatibility version and is never given a target or duration it did
 * not record, because that would be a commitment the Run never made.
 */

/**
 * The analysis implementation new Runs freeze. Bump it only for a deliberate
 * change in how locked evidence is computed: every Run started afterwards gets a
 * different result token for the same raw facts, which is the point. Never
 * date-shaped: tooling that shifts fixture dates would rewrite it.
 */
export const CURRENT_ANALYSIS_VERSION = "analysis-v1";

/**
 * The label a legacy Run is read under. Its compatibility implementation is the
 * engine as it stood when versioning began, so its result token stays
 * byte-identical to the token it had before this field existed.
 */
export const LEGACY_ANALYSIS_VERSION = "legacy-unversioned";

/** Versions this deployment can analyze. A Run frozen under any other refuses. */
export const SUPPORTED_ANALYSIS_VERSIONS: readonly string[] = [CURRENT_ANALYSIS_VERSION];

/** GrowthBook's documented default; recorded as defaulted when the caller names none. */
export const DEFAULT_SEQUENTIAL_TARGET_N = 5_000;

/** One full weekly cycle (Kohavi and Longbotham), the default planned duration. */
export const DEFAULT_PLANNED_DURATION_DAYS = 7;
export const PLANNED_DURATION_WEEK_DAYS = 7;

export const TargetNSourceSchema = z.enum(["caller", "default"]);
export type TargetNSource = z.infer<typeof TargetNSourceSchema>;

export const RunCommitmentsSchema = z.discriminatedUnion("analysis_version_source", [
  z
    .object({
      analysis_version_source: z.literal("frozen"),
      analysis_version: z.string().min(1),
      /** Null on a fixed-horizon Run, which has no sequential tuning target. */
      target_n: z.number().int().positive().nullable(),
      target_n_source: TargetNSourceSchema.nullable(),
      planned_duration_days: z.number().int().positive(),
      /** Present only when the planned duration departs from whole weeks. */
      planned_duration_override_reason: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      analysis_version_source: z.literal("legacy"),
      analysis_version: z.literal(LEGACY_ANALYSIS_VERSION),
      /** The Run never committed these, so none is reported. */
      target_n: z.null(),
      target_n_source: z.null(),
      planned_duration_days: z.null(),
      planned_duration_override_reason: z.null(),
    })
    .strict(),
]);
export type RunCommitments = z.infer<typeof RunCommitmentsSchema>;

export const LEGACY_RUN_COMMITMENTS: RunCommitments = {
  analysis_version_source: "legacy",
  analysis_version: LEGACY_ANALYSIS_VERSION,
  target_n: null,
  target_n_source: null,
  planned_duration_days: null,
  planned_duration_override_reason: null,
};

export interface ResultTokenInput {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  runConfigHash: string;
  /** Null for a legacy Run: the key is then absent, exactly as it was before versioning. */
  analysisVersion: string | null;
  stats: StatsOutput;
}

/**
 * Evidence identity for Conclude. Analysis mints it and the Control Plane
 * recomputes it, so both read this one definition. Stats are hashed without the
 * estimand disclosure (result-token-stats.ts) on every Run.
 */
export async function createResultToken(input: ResultTokenInput): Promise<`sha256:${string}`> {
  const { analysisVersion, stats, ...identity } = input;
  const legacyIdentity = { ...identity, stats: resultTokenStats(stats) };
  return canonicalHash(
    analysisVersion === null ? legacyIdentity : { ...legacyIdentity, analysisVersion },
  );
}
