import { z } from "zod";
import {
  type ResolutionDetails,
  ResolutionDetailsSchema,
  type VariantValue,
} from "./leaves/resolution-details";
import {
  type ResolutionReason,
  ResolutionReasonSchema,
  resolutionReasons,
} from "./leaves/resolution-reason";
import { VariantValueSchema } from "./leaves/variant-value";
import { OrganizationSlugSchema } from "./organization-slug";
import { OWN_PROTO_KEY, protoSafeRecord } from "./proto-safe-record";

export {
  type ResolutionDetails,
  ResolutionDetailsSchema,
  type ResolutionReason,
  ResolutionReasonSchema,
  resolutionReasons,
  type VariantValue,
  VariantValueSchema,
};

/**
 * Canonical Zod leaf schemas for the runtime/identity glossary nouns:
 * EvaluationContext, Exposure event, ResolutionDetails, and the
 * Organization / App / Environment / User / credential block.
 * Source of truth: docs/spec/contracts/leaf-schemas-runtime.md
 *
 * Every envelope (request, response, storage) composes these leaves and never
 * redefines them. Any field addition here propagates automatically.
 */

// ---------------------------------------------------------------------------
// EvaluationContext
//
// `targetingKey` is first-class and separate from `attributes`. The attribute
// bag is open: scalars or arrays only (no nested objects), and may be empty.
// ---------------------------------------------------------------------------

const AttributeValueSchema = z.union([z.boolean(), z.string(), z.number(), z.array(z.unknown())]);

/** Proto-safe attributes map (`record` + refine so OpenAPI/CLI help keep the record shape). */
const EvaluationAttributesSchema = protoSafeRecord(
  AttributeValueSchema,
  `must not contain a "${OWN_PROTO_KEY}" key`,
);

export const EvaluationContextSchema = z.object({
  targetingKey: z.string(),
  idType: z.string(),
  attributes: EvaluationAttributesSchema,
});
export type EvaluationContext = z.infer<typeof EvaluationContextSchema>;

// ---------------------------------------------------------------------------
// Exposure event
//
// The single canonical row on the Assignment/Exposure seam; activations share
// this schema via the `type` discriminator. EVERY field is required so the wire
// `dedup_key` is always satisfiable — except `counterfactual`, which is a
// REQUIRED boolean that DEFAULTS to false per spec (a row omitting it parses as
// `false`, never null). That default is spec-mandated, not a silent fallback.
//
// Tinybird physical aliases map to these canonical names; no downstream slice
// should re-alias them:
//   serverReceivedAt → server_received_at
//   ingestTs         → ingest_ts
//   clientTimestamp  → client_timestamp
// ---------------------------------------------------------------------------

export const exposureTypes = ["exposure", "activation"] as const;

export const ExposureTypeSchema = z.enum(exposureTypes);
export type ExposureType = z.infer<typeof ExposureTypeSchema>;

export const ExposureEventSchema = z.object({
  dedupKey: z.string(),
  eventId: z.string(),
  appId: z.string(),
  environmentId: z.string(),
  experimentId: z.string(),
  runId: z.string(),
  idType: z.string(),
  targetingKeyHash: z.string(),
  variantName: z.string(),
  type: ExposureTypeSchema,
  sourceId: z.string(),
  // Spec-mandated default (NOT a silent fallback): a row that omits
  // `counterfactual` parses as `false`, never null.
  counterfactual: z.boolean().default(false),
  clientTimestamp: z.string(),
  serverReceivedAt: z.string(),
  ingestTs: z.string(),
});
export type ExposureEvent = z.infer<typeof ExposureEventSchema>;

// ResolutionDetails leaves are defined in ./leaves/* and re-exported above.

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export const orgPlans = ["free", "pro", "enterprise"] as const;

export const OrgPlanSchema = z.enum(orgPlans);
export type OrgPlan = z.infer<typeof OrgPlanSchema>;

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** URL handle the Control Panel routes on; unique across all Organizations. */
  slug: OrganizationSlugSchema,
  plan: OrgPlanSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const AppSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type App = z.infer<typeof AppSchema>;

// ---------------------------------------------------------------------------
// Environment (first-class axis under App, ADR-0027)
// ---------------------------------------------------------------------------

export const environmentPolicyLevels = ["allow", "confirm"] as const;
export const reservedEnvironmentPolicyLevels = ["approve"] as const;
export const approvalPolicyLevels = [
  ...environmentPolicyLevels,
  ...reservedEnvironmentPolicyLevels,
] as const;

export const EnvironmentPolicyLevelSchema = z.enum(environmentPolicyLevels);
export type EnvironmentPolicyLevel = z.infer<typeof EnvironmentPolicyLevelSchema>;

// `approve` is reserved for the Approval contract only. Environment writes keep
// rejecting it until the second-person authority slice activates that level.
export const ApprovalPolicyLevelSchema = z.enum(approvalPolicyLevels);
export type ApprovalPolicyLevel = z.infer<typeof ApprovalPolicyLevelSchema>;

export const EnvironmentPolicySchema = z
  .object({
    variantAvailability: EnvironmentPolicyLevelSchema,
    targetingRolloutValue: EnvironmentPolicyLevelSchema,
    enabledState: EnvironmentPolicyLevelSchema,
    startExperimentRun: EnvironmentPolicyLevelSchema,
  })
  .strict();
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  key: z.string(),
  name: z.string(),
  policy: EnvironmentPolicySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

// ---------------------------------------------------------------------------
// User
//
// A wire response assembled from WorkOS profile data plus D1 membership rows.
// It is NOT a D1 PII storage table — splitch stores no PII columns; identity
// fields (email, etc.) are sourced live from WorkOS, never persisted here.
// ---------------------------------------------------------------------------

export const userRoles = ["owner", "admin", "member"] as const;

export const UserRoleSchema = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  organizationId: z.string(),
  role: UserRoleSchema,
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

/**
 * A member of ONE App (`app_memberships`), which is a different grant from
 * Organization membership: the App role decides who may rename the App, manage
 * its members, and delete it (organization-and-membership.md App role matrix).
 *
 * `email` is nullable ON PURPOSE. It is resolved from the identity profile cache
 * written at first sign-in, so a member who has been granted access but has not
 * signed in yet genuinely has no email here. Rendering a placeholder would be a
 * silent substitution (ADR-0036); the absence is modelled so the surface can say
 * so out loud.
 */
export const AppMemberSchema = z.object({
  appId: z.string(),
  userId: z.string(),
  email: z.string().nullable(),
  role: UserRoleSchema,
  createdAt: z.string(),
});
export type AppMember = z.infer<typeof AppMemberSchema>;

// ---------------------------------------------------------------------------
// ClientKey (public, publishable)
//
// `keyMaterial` is intentionally present — Client Keys are safe to embed in
// client code. `originAllowlist`: null = open to all origins (auto-provision
// default, loudly flagged); [] = closed, serves nothing; non-empty = closed
// except listed origins (ADR-0034 §1). `isOriginOpen` is the explicit UI/agent
// warning bit derived from `originAllowlist === null`.
//
// `.strict()` (like APIKey) keeps the leaf a CLOSED shape: an unknown key —
// notably an API Key's `scopes` — is REJECTED, not silently dropped. This makes
// ClientKey and APIKey structurally DISJOINT, so the `Credential` union over them
// cannot absorb an API-key-shaped object (one carrying a secret `keyMaterial`)
// into the public ClientKey member. Fail loud, no secret leak (ADR-0018).
// ---------------------------------------------------------------------------

export const ClientKeySchema = z
  .object({
    keyId: z.string(),
    appId: z.string(),
    environmentId: z.string(),
    keyMaterial: z.string(),
    originAllowlist: z.array(z.string()).nullable().optional(),
    isOriginOpen: z.boolean(),
    rateLimitRps: z.number().nullable().optional(),
    revokedAt: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .strict();
export type ClientKey = z.infer<typeof ClientKeySchema>;

// ---------------------------------------------------------------------------
// APIKey (secret, server-side)
//
// The raw value is surfaced ONCE at creation and is never stored or returned
// later — so the leaf carries NO key-material field. `.strict()` makes that a
// loud parse failure: an extra `keyMaterial` (or any unknown key) is rejected,
// preventing a secret from ever riding this shape.
// ---------------------------------------------------------------------------

export const APIKeySchema = z
  .object({
    keyId: z.string(),
    appId: z.string(),
    environmentId: z.string(),
    scopes: z.array(z.string()),
    revokedAt: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .strict();
export type APIKey = z.infer<typeof APIKeySchema>;
