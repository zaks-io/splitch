import { z } from "zod";

/**
 * Sentry change-tracking installation surface.
 *
 * One installation binds an Environment to one Sentry organization's Generic
 * Flag Log endpoint. The Environment comes from the API Key, never the body:
 * Sentry's payload has no environment field, so a prod Sentry org must not be
 * reachable from a dev credential.
 *
 * The signing secret is write-only. It is what Sentry verifies
 * `X-Sentry-Signature` against, so reads return a fingerprint instead, the same
 * treatment the Convex webhook secret gets.
 */

const UuidSchema = z.uuid();

/** Sentry's own bound: the signing secret is 10-64 characters. */
export const SentryWebhookSecretSchema = z.string().min(10).max(64);

export const SentryInstallationCreateRequestSchema = z
  .object({
    installationId: UuidSchema,
    webhookUrl: z.url(),
    webhookSecret: SentryWebhookSecretSchema,
  })
  .strict();

export const SentryInstallationSchema = z
  .object({
    installationId: UuidSchema,
    appId: z.string(),
    environmentId: z.string(),
    webhookUrl: z.url(),
    status: z.enum(["active", "revoked"]),
  })
  .strict();

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

export const SentrySecretRotationRequestSchema = z
  .object({ rotationId: UuidSchema, webhookSecret: SentryWebhookSecretSchema })
  .strict();

export const SentrySecretRotationResponseSchema = z
  .object({ installationId: UuidSchema, rotationId: UuidSchema, status: z.literal("active") })
  .strict();

export type SentryInstallation = z.infer<typeof SentryInstallationSchema>;
export type SentryInstallationStatus = z.infer<typeof SentryInstallationStatusSchema>;
