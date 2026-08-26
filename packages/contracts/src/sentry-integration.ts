import { z } from "zod";

/**
 * Sentry change-tracking installation surface.
 *
 * One installation binds a splitch Organization to one Sentry organization's
 * Generic Flag Log endpoint, so the Organization is named in the path. Sentry
 * stores ONE signing secret per provider type per organization ("Create Generic
 * Flag Log", getsentry/sentry `src/sentry/flags/docs/api.md`), which is why this
 * cannot be an Environment-scoped resource: a second Environment wiring up the
 * same Sentry org would mint a second secret and silently break the first one.
 * Sentry has no project or environment axis on a flag change either, so every
 * App and Environment under the Organization publishes to the same log.
 *
 * The signing secret is write-only. It is what Sentry verifies
 * `X-Sentry-Signature` against, so reads return delivery health and never the
 * secret, the same treatment the Convex webhook secret gets.
 *
 * `webhookSecret` is optional on write because Sentry does not issue it: its
 * Add-Provider form says "paste the signing secret given by your provider", so
 * splitch is the provider and must be able to mint one. Omit it and the server
 * generates a secret and returns it ONCE in the response, the same handling as
 * a minted API Key. Supply it and the caller's value is stored verbatim, which
 * is what an agent rotating from its own keystore needs.
 */

const UuidSchema = z.uuid();

/** Sentry's own bound: the signing secret is 10-64 characters. */
export const SentryWebhookSecretSchema = z.string().min(10).max(64);

export const SentryInstallationCreateRequestSchema = z
  .object({
    installationId: UuidSchema,
    webhookUrl: z.url(),
    webhookSecret: SentryWebhookSecretSchema.optional(),
  })
  .strict();

export const SentryInstallationSchema = z
  .object({
    installationId: UuidSchema,
    orgId: z.string(),
    webhookUrl: z.url(),
    status: z.enum(["active", "revoked"]),
  })
  .strict();

/** Present only when the server minted the secret; it is never readable again. */
export const SentryInstallationCreateResponseSchema = SentryInstallationSchema.extend({
  webhookSecret: SentryWebhookSecretSchema.optional(),
}).strict();

export const SentryInstallationStatusSchema = SentryInstallationSchema.extend({
  /** Highest `flag_change_events.seq` Sentry has accepted; null before the first delivery. */
  lastDeliveredSeq: z.number().int().nonnegative().nullable(),
  lastDeliveredAt: z.iso.datetime().nullable(),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime(),
  latestDeliveryError: z
    .object({
      kind: z.enum(["transport", "http", "config"]),
      code: z.enum(["CONNECT_FAILED", "HTTP_STATUS", "URL_REJECTED"]),
      httpStatus: z.number().int().min(100).max(599).optional(),
      occurredAt: z.iso.datetime(),
    })
    .strict()
    .nullable(),
}).strict();

/**
 * At most one active installation per Organization, so this list is 0 or 1 long
 * today. It stays a collection because that is what lets the Panel ask "is
 * Sentry wired up here?" without already knowing an installation id, and
 * revoked rows remain readable as history.
 */
export const SentryInstallationListResponseSchema = z
  .object({ installations: z.array(SentryInstallationStatusSchema) })
  .strict();

export const SentrySecretRotationRequestSchema = z
  .object({ rotationId: UuidSchema, webhookSecret: SentryWebhookSecretSchema.optional() })
  .strict();

export const SentrySecretRotationResponseSchema = z
  .object({
    installationId: UuidSchema,
    rotationId: UuidSchema,
    status: z.literal("active"),
    webhookSecret: SentryWebhookSecretSchema.optional(),
  })
  .strict();

export type SentryInstallation = z.infer<typeof SentryInstallationSchema>;
export type SentryInstallationStatus = z.infer<typeof SentryInstallationStatusSchema>;
export type SentryInstallationCreateResponse = z.infer<
  typeof SentryInstallationCreateResponseSchema
>;
export type SentrySecretRotationResponse = z.infer<typeof SentrySecretRotationResponseSchema>;
