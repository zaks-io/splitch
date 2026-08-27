import { z } from "zod";
import { CachedClientKeyRateLimitRpsFieldSchema } from "./client-key-rate-limit";
import { ExperimentStatusSchema } from "./leaf-schemas-experiment";
import {
  PercentageRolloutSchema,
  ResolvedTargetingRuleSchema,
  VariantSchema,
} from "./leaf-schemas-flag";
import { memberProfileCacheKey } from "./storage-keys-kv";

/**
 * The one schema version every KV blob is written and read at. The envelope below
 * pins `schemaVersion` to this literal, so a blob written at any OTHER version
 * (old or future) FAILS the parse loudly rather than being mistaken for current
 * (fail-loud, ADR-0025/0036). Bumping the on-disk shape is a deliberate edit to
 * this constant plus a writer/reader rollout, never a silently-tolerated drift.
 */
export const CURRENT_KV_SCHEMA_VERSION = 1;

/**
 * Canonical Zod schemas for every KV value blob plus the schemaVersion envelope.
 * Source of truth: docs/spec/contracts/storage-schemas-kv.md (ADR-0025/0027/0009).
 *
 * Storage shapes carry internals (timestamps, dedup pointers, immutability
 * markers) that wire envelopes must never expose, so they live here — separate
 * from wire-envelopes-core.ts — and compose existing leaves (Variant,
 * TargetingRule) rather than redefining them (ADR-0025 "reuse at the leaf").
 *
 * Every KV value is Zod-parsed on EVERY read, including the hot path. A
 * malformed or partial blob FAILS the parse (fail-loud, ADR-0025/0036); a
 * half-valid object must never flow into evaluation. `.strict()` is applied so
 * an unexpected extra key is rejected loudly rather than silently carried.
 */

// ---------------------------------------------------------------------------
// FlagConfigKV
//
// Per-Environment resolved Flag CONFIGURATION (ADR-0027): the App-level Variant
// catalog narrowed by `availableVariantNames` plus the Environment's enabled
// state, default, and targeting.
//
// `experimentId` is NULLABLE-NOT-ABSENT (present-with-null): the controlling
// Experiment for this Flag in this Environment, or `null` when none controls it.
// It is denormalized here so the evaluate path resolves flag -> experiment in
// the ONE getFlag read it already makes — never a second KV lookup that could
// disagree with the flag read (ADR-0034 seam note). A null flows straight to the
// "no live Run" branch. Because the field is required (not `.optional()`), an
// OMITTED `experimentId` fails the parse — the writer must commit to null or an
// id, never leave the controlling-Experiment pointer ambiguous.
//
// `rollout` is the baseline PercentageRollout applied to traffic that matches no
// Targeting Rule (a matched rule wins and honours its own `percentageRollout`).
// Like `experimentId` it is NULLABLE-NOT-ABSENT so the writer must commit to a
// rollout or to `null`, never leave the baseline ambiguous. Its `salt` is minted
// server-side once and carried verbatim through every rewrite of this blob, so
// bucket membership is stable across percentage changes.
// ---------------------------------------------------------------------------

export const FlagConfigKVSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    environmentId: z.string(),
    experimentId: z.string().nullable(),
    enabled: z.boolean(),
    defaultVariantId: z.string(),
    variants: z.array(VariantSchema),
    availableVariantNames: z.array(z.string()),
    targetingRules: z.array(ResolvedTargetingRuleSchema),
    rollout: PercentageRolloutSchema.nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type FlagConfigKV = z.infer<typeof FlagConfigKVSchema>;

// ---------------------------------------------------------------------------
// RunConfigKV
//
// Hot-path live Experiment Run config. `allocation` is keyed by Variant NAME and
// `targetingRules` is the resolved snapshot frozen at Start ([] = all eligible),
// mirroring the Run leaf exactly so the edge buckets by name without resolving a
// Segment or joining ids at read time. `configHash` equals the D1 Run's.
//
// `targetingKey` is intentionally NOT here — it lives on Experiment and reaches
// the edge through ExperimentConfigKV.
// ---------------------------------------------------------------------------

export const RunConfigKVSchema = z
  .object({
    id: z.string(),
    experimentId: z.string(),
    salt: z.string(),
    allocation: z.record(z.string(), z.number().min(0).max(100)),
    variantSet: z.array(VariantSchema),
    targetingRules: z.array(ResolvedTargetingRuleSchema),
    configHash: z.string(),
    startedAt: z.string(),
  })
  .strict();
export type RunConfigKV = z.infer<typeof RunConfigKVSchema>;

// ---------------------------------------------------------------------------
// ExperimentConfigKV
//
// The Experiment-level fields the edge evaluate path needs that are NOT on the
// Run: which Evaluation Context field to bucket on, the id_type label stamped on
// the Exposure, the lifecycle `status` the resolved ExperimentConfig view
// surfaces (provider-port.md marks it Required), and the live Run pointer
// (present-with-null before first Start). `status` reuses the Experiment leaf's
// ExperimentStatus enum so the edge never redefines the lifecycle states.
// ---------------------------------------------------------------------------

export const ExperimentConfigKVSchema = z
  .object({
    id: z.string(),
    environmentId: z.string(),
    flagId: z.string(),
    targetingKey: z.string(),
    targetingKeyType: z.string(),
    status: ExperimentStatusSchema,
    liveRunId: z.string().nullable(),
  })
  .strict();
export type ExperimentConfigKV = z.infer<typeof ExperimentConfigKVSchema>;

// ---------------------------------------------------------------------------
// CredentialCacheKV
//
// Short-TTL credential validation cache, per-Environment (ADR-0027), evicted on
// revoke. `revoked` is carried so an in-window read still fails loud after a
// revoke writes through. Client Key entries also carry the edge abuse controls
// needed by the hot path; API Key entries omit those fields.
// ---------------------------------------------------------------------------

export const credentialKinds = ["api_key", "client_key"] as const;

export const CredentialKindSchema = z.enum(credentialKinds);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/** Schema-v1 credential payloads remain readable during the backfill rollout. */
export const CredentialCacheKVSchemaV1 = z
  .object({
    appId: z.string(),
    environmentId: z.string(),
    kind: CredentialKindSchema,
    scopes: z.array(z.string()),
    originAllowlist: z.array(z.string()).nullable().optional(),
    rateLimitRps: CachedClientKeyRateLimitRpsFieldSchema,
    revoked: z.boolean(),
    cachedAt: z.string(),
  })
  .strict();

export const CredentialCacheKVSchema = z
  .object({
    appId: z.string(),
    environmentId: z.string(),
    // Active data-plane credentials are bound to an Organization so usage
    // telemetry has an authenticated tenant scope. Revoked tombstones retain
    // a nullable value because their only job is to reject the credential.
    credentialSchemaVersion: z.literal(2),
    organizationId: z.string().nullable(),
    kind: CredentialKindSchema,
    scopes: z.array(z.string()),
    originAllowlist: z.array(z.string()).nullable().optional(),
    rateLimitRps: CachedClientKeyRateLimitRpsFieldSchema,
    revoked: z.boolean(),
    cachedAt: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.revoked && value.organizationId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["organizationId"],
        message: "active credentials require an organizationId",
      });
    }
  });
export type CredentialCacheKV = z.infer<typeof CredentialCacheKVSchema>;

// ---------------------------------------------------------------------------
// LiveRunKV
//
// Written on Start; the edge reads this key to learn the live Experiment Run for
// an Environment (ADR-0027). The smallest possible pointer blob.
// ---------------------------------------------------------------------------

export const LiveRunKVSchema = z.object({ runId: z.string() }).strict();
export type LiveRunKV = z.infer<typeof LiveRunKVSchema>;

// ---------------------------------------------------------------------------
// AssignmentStoreValue (Assignment Store KV read model, ADR-0008/0009)
//
// The CANONICAL per-Entity read model: a Map<experimentId, { runId, variant }>.
// In KV/JSON a Map serializes to a record keyed by `experimentId`, so it is
// modeled as `z.record`. One read returns every Experiment's holdover for the
// Entity.
//
// Each entry is EXACTLY `{ runId, variant }` — `.strict()` REJECTS any extra
// key. In particular there is NO per-entry `schemaVersion`: versioning lives on
// the KV envelope ONLY (see KVEnvelope below). This is the final shape S14/S22
// consume, so a stray per-entry schemaVersion must fail parse, not be tolerated.
//
// `runId` is stamped from the live Run at first-touch Exposure fire-time, so a
// holdover keeps its original Run attribution across Run boundaries; `variant`
// is the Variant NAME.
// ---------------------------------------------------------------------------

export const AssignmentStoreEntrySchema = z
  .object({
    runId: z.string(),
    variant: z.string(),
  })
  .strict();
export type AssignmentStoreEntry = z.infer<typeof AssignmentStoreEntrySchema>;

export const AssignmentStoreValueSchema = z.record(z.string(), AssignmentStoreEntrySchema);
export type AssignmentStoreValue = z.infer<typeof AssignmentStoreValueSchema>;

// ---------------------------------------------------------------------------
// MemberProfileCache (SESSION_STORE identity cache)
//
// Email for Org member wire responses. Written at login; never a D1 column.
// No schemaVersion envelope: this blob is a single-field identity projection,
// not a config/credential cache that evolves through versioned rollouts.
// ---------------------------------------------------------------------------

export const MemberProfileCacheSchema = z
  .object({
    email: z.string().min(1),
  })
  .strict();
export type MemberProfileCache = z.infer<typeof MemberProfileCacheSchema>;

/**
 * Minimal put surface for the shared SESSION_STORE identity cache. Auth-api,
 * Control Panel, and control-plane tests write through this; Cloudflare's
 * KVNamespace satisfies it without coupling contracts to Worker types.
 */
export interface MemberProfileKv {
  put(key: string, value: string): Promise<void> | void;
}

/**
 * Persist `member-profile:{userId}` so Org member endpoints can resolve email
 * without a D1 PII column. Callers pass a verified address only.
 */
export async function rememberMemberProfile(
  kv: MemberProfileKv,
  userId: string,
  email: string,
): Promise<void> {
  const profile = MemberProfileCacheSchema.parse({ email });
  await kv.put(memberProfileCacheKey(userId), JSON.stringify(profile));
}

// ---------------------------------------------------------------------------
// KVEnvelope<T> (schema-version envelope, contracts-and-validation.md)
//
// schemaVersion is carried ONLY at this envelope level — never on the payload or
// on per-entry records. The reader parses the envelope first; the version is
// pinned to CURRENT_KV_SCHEMA_VERSION, so an UNKNOWN version (old or future)
// fails the parse — the version is gated, not merely bounded below.
//
// What happens on that failure is the READER's choice, not the schema's: the
// control plane (which has a D1 binding) may rebuild from D1 and log; the
// evaluation edge (no D1 binding) fails loud with INTERNAL_SERVER_ERROR. Either
// way an unknown version never flows into evaluation as if current. A factory
// keeps the wrapper generic while preserving the payload schema's inferred type.
// ---------------------------------------------------------------------------

export function kvEnvelope<DataSchema extends z.ZodTypeAny>(dataSchema: DataSchema) {
  return z
    .object({
      schemaVersion: z.literal(CURRENT_KV_SCHEMA_VERSION),
      data: dataSchema,
    })
    .strict();
}
