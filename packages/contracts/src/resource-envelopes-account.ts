import { z } from "zod";
import { MetricRefSchema, MetricSchema } from "./leaf-schemas-experiment";
import {
  IdempotencyKeySchema,
  PersistedDescriptionSchema,
  PersistedIdentifierSchema,
  PersistedNameSchema,
} from "./persisted-field-limits";
import {
  APIKeySchema,
  AppSchema,
  ClientKeySchema,
  EnvironmentSchema,
  OrganizationSchema,
} from "./leaf-schemas-runtime";
import { OrganizationSlugSchema } from "./organization-slug";
import { SlugSchema } from "./slug";
import { listResponse } from "./wire-envelopes-core";

/**
 * Create/patch/response wire envelopes for the account-tier resources: Metric,
 * App, Organization, and SDK Credentials. Composed from the runtime/experiment
 * leaves (never redefining them).
 * Source of truth: docs/spec/contracts/request-response-envelopes-org-app-credentials.md
 *
 * Field naming follows the canonical contract leaves (camelCase, `key`-keyed) per
 * packages/contracts/CONTEXT.md — the endpoint-inventory docs show the same
 * resources in snake_case at the HTTP edge, but the Zod contract is the single
 * source (ADR-0025) and the wire-serialization casing is a router concern.
 *
 * The API Key raw secret rides ONLY the once-only creation responses below. The
 * APIKey leaf carries no key-material field, and BOTH credential leaves are
 * `.strict()` (so they are structurally disjoint): the `Credential` union cannot
 * absorb a secret-bearing API-key-shaped object into its public ClientKey member.
 * A wrong-shaped credential FAILS parse rather than leaking the secret (ADR-0018).
 */

// ---------------------------------------------------------------------------
// Metric endpoints
//
// `eventFieldName` (count/revenue) and both operands (ratio) are conditionally
// required — the Worker validates the kind→field correspondence and that the
// ratio operands belong to the same App. The envelope keeps them optional so
// the conditional lives in one place (the Worker), matching the spec table.
//
// `downsideThresholdPct` and the three variance-reduction knobs accept an explicit
// null on patch, which is how a Metric goes back to the engine default. Leaving
// the field out means "unchanged"; sending null means "no preference".
// ---------------------------------------------------------------------------

const MetricAnalysisFields = {
  downsideThresholdPct: MetricSchema.shape.downsideThresholdPct,
  winsorize: MetricSchema.shape.winsorize,
  winsorizePct: MetricSchema.shape.winsorizePct,
  cuped: MetricSchema.shape.cuped,
  cupedCoverageThresholdPct: MetricSchema.shape.cupedCoverageThresholdPct,
};

export const CreateMetricRequestSchema = z
  .object({
    appId: PersistedIdentifierSchema,
    name: PersistedNameSchema,
    key: PersistedNameSchema,
    kind: MetricSchema.shape.kind,
    eventDefinitionId: PersistedIdentifierSchema.optional(),
    eventFieldName: PersistedNameSchema.optional(),
    numerator: MetricRefSchema.optional(),
    denominator: MetricRefSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
    ...MetricAnalysisFields,
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateMetricRequest = z.infer<typeof CreateMetricRequestSchema>;

// All fields optional; Metric patches are measurement edits that recompute over
// the existing Run (never RUN_FROZEN). `.strict()` rejects unknown keys. `key`
// IS patchable here per spec (unlike Flag/App key), so it is intentionally listed.
export const PatchMetricRequestSchema = z
  .object({
    name: PersistedNameSchema.optional(),
    key: PersistedNameSchema.optional(),
    kind: MetricSchema.shape.kind.optional(),
    eventDefinitionId: PersistedIdentifierSchema.nullable().optional(),
    eventFieldName: PersistedNameSchema.nullable().optional(),
    numerator: MetricRefSchema.optional(),
    denominator: MetricRefSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
    ...MetricAnalysisFields,
  })
  .strict();
export type PatchMetricRequest = z.infer<typeof PatchMetricRequestSchema>;

export const MetricResponseSchema = MetricSchema;
export type MetricResponse = z.infer<typeof MetricResponseSchema>;

// ---------------------------------------------------------------------------
// App endpoints
//
// `idempotency_key` guards a retried `apps_create`. The response surfaces the
// App plus the default Environments and public Client Keys created with it.
// ---------------------------------------------------------------------------

// An App key is unique per Org only, while an App ID is globally unique, and
// selector lookups (`splitch use --app`, token rebinds) accept either. A key
// shaped like an identifier could therefore name another tenant's App, which is
// why the shared slug alphabet (no `_`) is the constraint rather than a looser
// App-specific one.
// The owning Organization is the `:orgId` path parameter. It was once duplicated
// here as `organizationId`, which existed only to be compared against the path
// and discarded, and which every caller had to learn to send twice.
export const CreateAppRequestSchema = z
  .object({
    name: PersistedNameSchema,
    // Optional for the same reason an Organization's `slug` is: a caller who has a
    // display name should not have to invent a handle to get started, and the two
    // creation calls must not disagree about that. Derived from `name` when absent.
    key: SlugSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;

// `.strict()` rejects an immutable `id` or `organizationId` on patch. `key` IS
// patchable: it is the App's URL slug, the one identifier a human or agent picks
// and later needs to correct (endpoints-org-app.md `PATCH /apps/{app_id}`).
// Renaming it moves every URL for the App, so it is validated by the same
// `SlugSchema` creation uses and rejected on collision, never silently deduped.
export const PatchAppRequestSchema = z
  .object({
    name: PersistedNameSchema.optional(),
    key: SlugSchema.optional(),
    description: PersistedDescriptionSchema.optional(),
  })
  .strict();
export type PatchAppRequest = z.infer<typeof PatchAppRequestSchema>;

export const CreateAppResponseSchema = z.object({
  app: AppSchema,
  environments: z.tuple([EnvironmentSchema, EnvironmentSchema]),
  clientKeys: z.tuple([ClientKeySchema, ClientKeySchema]),
});
export type CreateAppResponse = z.infer<typeof CreateAppResponseSchema>;

export const AppResponseSchema = AppSchema;
export type AppResponse = z.infer<typeof AppResponseSchema>;

// ---------------------------------------------------------------------------
// Environment endpoints
//
// Creating an Environment auto-provisions its Client Key (ADR-0034), so the
// create response carries that key: an agent that has just made an Environment
// can point an SDK at it without discovering a second command. It is the same
// public `ClientKeySchema` leaf `client_key_get` returns, never a second shape,
// and the API Key (secret) stays off this response entirely.
//
// The key is nested on the Environment rather than wrapped in an envelope so the
// Environment fields stay where every other Environment response puts them.
// ---------------------------------------------------------------------------

export const CreateEnvironmentResponseSchema = EnvironmentSchema.extend({
  clientKey: ClientKeySchema,
});
export type CreateEnvironmentResponse = z.infer<typeof CreateEnvironmentResponseSchema>;

/**
 * Minimal per-Environment health signal for the App-list attention rollup.
 * `state` keeps no data distinct from a measured clear result, while the two
 * booleans preserve the exact SRM / Guardrail reason when attention is needed.
 */
export const EnvironmentAttentionRollupSchema = z
  .object({
    environmentId: z.string(),
    state: z.enum(["no_data", "clear", "attention"]),
    srm: z.boolean(),
    guardrail: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAttention = value.srm || value.guardrail;
    if (value.state === "attention" && !hasAttention) {
      context.addIssue({ code: "custom", message: "attention requires SRM or Guardrail evidence" });
    }
    if (value.state !== "attention" && hasAttention) {
      context.addIssue({
        code: "custom",
        message: "SRM or Guardrail evidence requires the attention state",
      });
    }
  });
export type EnvironmentAttentionRollup = z.infer<typeof EnvironmentAttentionRollupSchema>;

export const AppAttentionRollupResponseSchema = z
  .object({
    appId: z.string(),
    items: z.array(EnvironmentAttentionRollupSchema),
  })
  .strict();
export type AppAttentionRollupResponse = z.infer<typeof AppAttentionRollupResponseSchema>;

// ---------------------------------------------------------------------------
// Organization endpoints
//
// `.strict()` rejects an immutable `id` on patch. `plan` changes are gated by the
// Stripe seam in the Worker (future); the envelope only shapes the input.
// ---------------------------------------------------------------------------

export const PatchOrganizationRequestSchema = z
  .object({
    name: PersistedNameSchema.optional(),
    plan: OrganizationSchema.shape.plan.optional(),
  })
  .strict();
export type PatchOrganizationRequest = z.infer<typeof PatchOrganizationRequestSchema>;

/**
 * Explicit Organization creation (SPL-171).
 *
 * `slug` is optional and derived from `name` when absent. It is NOT defaulted
 * here: derivation can fail (a name that slugifies to nothing, or onto a
 * reserved handle), and a Zod default would have to invent a value to stay
 * total. The handler derives it so that failure is a structured 400 naming
 * `slug` as the fix.
 *
 * `plan` is absent by design: a caller must not be able to self-assign a paid
 * plan at creation. New Organizations start on the schema default.
 */
export const CreateOrganizationRequestSchema = z
  .object({
    name: PersistedNameSchema,
    slug: OrganizationSlugSchema.optional(),
  })
  .strict();
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const OrganizationResponseSchema = OrganizationSchema;
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

// ---------------------------------------------------------------------------
// Credential endpoints
//
// `CreateCredentialResponse` is the generic standalone-key create: the credential
// leaf (APIKey or ClientKey) plus its raw `value` (API Key once-only; Client Key
// same as its keyMaterial). `ListCredentialsResponse` returns the leaf union.
//
// Both leaves are `.strict()` and structurally DISJOINT (an APIKey has `scopes`
// and no `keyMaterial`; a ClientKey has `keyMaterial` and no `scopes`), so the
// union is unambiguous: an API-key-shaped object carrying a secret `keyMaterial`
// matches NEITHER member and is REJECTED — it cannot be silently reclassified as
// a public ClientKey with the secret surviving in the output. The APIKey leaf
// also has no key-material field, so a list entry has no secret to surface; the
// once-only raw value rides the create response `value` field alone (ADR-0018).
// ---------------------------------------------------------------------------

export const CredentialSchema = z.union([APIKeySchema, ClientKeySchema]);
export type Credential = z.infer<typeof CredentialSchema>;

export const CreateCredentialResponseSchema = z.object({
  credential: CredentialSchema,
  // API Key: once-only raw secret. Client Key: same as keyMaterial.
  value: z.string(),
});
export type CreateCredentialResponse = z.infer<typeof CreateCredentialResponseSchema>;

export const ListCredentialsResponseSchema = listResponse(CredentialSchema);
export type ListCredentialsResponse = z.infer<typeof ListCredentialsResponseSchema>;
