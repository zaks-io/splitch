import { z } from "zod";
import { canonicalHash } from "./canonical-json";
import { resultTokenStats } from "./result-token-stats";
import { PreRegistrationSchema } from "./run-preregistration";
import type { StatsOutput } from "./stats-result-contract";

/**
 * What a Run commits to at Start beyond its assignment config (ADR-0059): the
 * analysis version that will read its evidence, the sequential tuning target,
 * the planned duration the decision gate measures evidence against, and
 * optional pre-registration (plan 2.2).
 *
 * A Run started before these were recorded is a legacy Run. It is read under a
 * labeled compatibility version and is never given a target or duration it did
 * not record, because that would be a commitment the Run never made.
 */

/**
 * Named analysis implementations. Never date-shaped: tooling that shifts
 * fixture dates would rewrite them. Bump CURRENT only for a deliberate change
 * in how locked evidence is computed: every Run started afterwards gets a
 * different result token for the same raw facts, which is the point.
 *
 * | Version              | SRM gate                         | Family correction | Guardrail bound                         | Supported for Start/Results |
 * | -------------------- | -------------------------------- | ----------------- | --------------------------------------- | --------------------------- |
 * | legacy-unversioned   | Chi-square p < 0.001             | BH                | Two-sided Fieller relative lower        | legacy read path only       |
 * | analysis-v1          | Chi-square p < 0.001             | BH                | Two-sided Fieller relative lower        | yes (supported)             |
 * | analysis-v2          | Sequential Dirichlet-multinomial | BH-G              | Prop. B.1 one-sided contrast (C4)       | yes (current)               |
 *
 * analysis-v2 orders the SRM observation path by eligibility ingest time
 * (`first_ingest_ts` / pairwise activation eligibility ingest) so a later
 * watermark extends an earlier path; event-time ordering is not used for the
 * filtration (ADR-0059).
 */
export const ANALYSIS_V1_VERSION = "analysis-v1";
export const ANALYSIS_V2_VERSION = "analysis-v2";
/**
 * New Runs freeze this named implementation. analysis-v2 is the current engine:
 * sequential Dirichlet-multinomial SRM with an ingestion-ordered path, and BH-G.
 * Keep the literal (not `ANALYSIS_V2_VERSION`) so the two exports stay distinct
 * names for knip / intentional version bumps.
 */
export const CURRENT_ANALYSIS_VERSION = "analysis-v2";

/**
 * The label a legacy Run is read under. Its compatibility implementation is the
 * engine as it stood when versioning began, so its result token stays
 * byte-identical to the token it had before this field existed.
 */
export const LEGACY_ANALYSIS_VERSION = "legacy-unversioned";

/**
 * Versions this deployment will Start or analyze. A Run frozen under any other
 * version refuses loudly. analysis-v1 stays supported so Runs frozen under it
 * keep their chi-square / BH implementation.
 */
export const SUPPORTED_ANALYSIS_VERSIONS: readonly string[] = [
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
];

/** GrowthBook's documented default; recorded as defaulted when the caller names none. */
export const DEFAULT_SEQUENTIAL_TARGET_N = 5_000;

/** One full weekly cycle (Kohavi and Longbotham), the default planned duration. */
export const DEFAULT_PLANNED_DURATION_DAYS = 7;
export const PLANNED_DURATION_WEEK_DAYS = 7;
/**
 * A year. Past this a plan is not a decision schedule, and an unbounded day
 * count can overflow the decision timestamp the gate has to compute.
 */
export const MAX_PLANNED_DURATION_DAYS = 365;

export const TargetNSourceSchema = z.enum(["caller", "default"]);
export type TargetNSource = z.infer<typeof TargetNSourceSchema>;

const frozenCommitmentsFields = {
  analysis_version: z.string().min(1),
  /** Null on a fixed-horizon Run, which has no sequential tuning target. */
  target_n: z.number().int().positive().nullable(),
  target_n_source: TargetNSourceSchema.nullable(),
  planned_duration_days: z.number().int().positive().max(MAX_PLANNED_DURATION_DAYS),
  /** Present only when the planned duration departs from whole weeks. */
  planned_duration_override_reason: z.string().min(1).nullable(),
  /**
   * Optional: absent when Start omitted pre-registration. Never invented for a
   * legacy Run. Scorecard / ship recommendation (2.4) are out of scope here.
   */
  pre_registration: PreRegistrationSchema.optional(),
} as const;

export const RunCommitmentsSchema = z.discriminatedUnion("analysis_version_source", [
  z
    .object({
      analysis_version_source: z.literal("frozen"),
      ...frozenCommitmentsFields,
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
