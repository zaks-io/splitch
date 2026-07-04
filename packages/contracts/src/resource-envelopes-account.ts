import { z } from "zod";
import { MetricSchema, MetricRefSchema } from "./leaf-schemas-experiment";
import {
  APIKeySchema,
  AppSchema,
  ClientKeySchema,
  EnvironmentSchema,
  OrganizationSchema,
} from "./leaf-schemas-runtime";

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
// `eventValueField` (count/revenue) and `denominator` (ratio) are conditionally
// required — the Worker validates the kind→field correspondence and that the
// ratio denominator belongs to the same App. The envelope keeps them optional so
// the conditional lives in one place (the Worker), matching the spec table.
// ---------------------------------------------------------------------------

export const CreateMetricRequestSchema = z.object({
  appId: z.string(),
  name: z.string(),
  key: z.string(),
  kind: MetricSchema.shape.kind,
  eventName: z.string(),
  eventValueField: z.string().optional(),
  denominator: MetricRefSchema.optional(),
  description: z.string().optional(),
  idempotency_key: z.string().optional(),
});
export type CreateMetricRequest = z.infer<typeof CreateMetricRequestSchema>;

// All fields optional; Metric patches are measurement edits that recompute over
// the existing Run (never RUN_FROZEN). `.strict()` rejects unknown keys. `key`
// IS patchable here per spec (unlike Flag/App key), so it is intentionally listed.
export const PatchMetricRequestSchema = z
  .object({
    name: z.string().optional(),
    key: z.string().optional(),
    kind: MetricSchema.shape.kind.optional(),
    eventName: z.string().optional(),
    eventValueField: z.string().optional(),
    denominator: MetricRefSchema.optional(),
    description: z.string().optional(),
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

export const CreateAppRequestSchema = z.object({
  organizationId: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().optional(),
  idempotency_key: z.string().optional(),
});
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;

// `.strict()` rejects an immutable `key`, `id`, or `organizationId` on patch.
export const PatchAppRequestSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
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
// Organization endpoints
//
// `.strict()` rejects an immutable `id` on patch. `plan` changes are gated by the
// Stripe seam in the Worker (future); the envelope only shapes the input.
// ---------------------------------------------------------------------------

export const PatchOrganizationRequestSchema = z
  .object({
    name: z.string().optional(),
    plan: OrganizationSchema.shape.plan.optional(),
  })
  .strict();
export type PatchOrganizationRequest = z.infer<typeof PatchOrganizationRequestSchema>;

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

export const ListCredentialsResponseSchema = z.object({
  items: z.array(CredentialSchema),
});
export type ListCredentialsResponse = z.infer<typeof ListCredentialsResponseSchema>;
