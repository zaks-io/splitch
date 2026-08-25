import { z } from "zod";
import { EvaluationContextSchema } from "./leaf-schemas-runtime";
import {
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  RunConfigKVSchema,
} from "./storage-schemas-kv";

export const CONVEX_CONFIG_SCHEMA_VERSION = 1;
export const CONVEX_SERVER_EXPOSURE_MAX_ITEMS = 25;
export const CONVEX_SERVER_EXPOSURE_MAX_BODY_BYTES = 32 * 1024;

const UuidSchema = z.uuid();
const EnvironmentVersionSchema = z.number().int().nonnegative();

export const ConvexInstallationCreateRequestSchema = z
  .object({
    installationId: UuidSchema,
    callbackUrl: z.url(),
    webhookSecret: z.string().min(43).max(128),
  })
  .strict();

export const ConvexInstallationSchema = z
  .object({
    installationId: UuidSchema,
    appId: z.string(),
    environmentId: z.string(),
    environmentVersion: EnvironmentVersionSchema,
    status: z.enum(["active", "revoked"]),
  })
  .strict();

export const ConvexInstallationStatusSchema = ConvexInstallationSchema.extend({
  callbackUrl: z.url(),
  lastDeliveredVersion: EnvironmentVersionSchema.nullable(),
  lastDeliveredAt: z.iso.datetime().nullable(),
  pendingCount: z.number().int().nonnegative(),
  oldestPendingAgeMs: z.number().int().nonnegative().nullable(),
  terminalCount: z.number().int().nonnegative(),
  latestDeliveryError: z
    .object({
      kind: z.enum(["transport", "http"]),
      code: z.enum(["DNS_ERROR", "CONNECT_TIMEOUT", "TLS_ERROR", "HTTP_STATUS"]),
      httpStatus: z.number().int().min(100).max(599).optional(),
      retryAfterMs: z.number().int().nonnegative().optional(),
      occurredAt: z.iso.datetime(),
    })
    .strict()
    .nullable(),
}).strict();

export const ConvexSecretRotationRequestSchema = z
  .object({ rotationId: UuidSchema, webhookSecret: z.string().min(43).max(128) })
  .strict();

export const ConvexSecretRotationResponseSchema = z
  .object({ installationId: UuidSchema, rotationId: UuidSchema, status: z.literal("active") })
  .strict();

export const ConvexConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONVEX_CONFIG_SCHEMA_VERSION),
    environmentVersion: EnvironmentVersionSchema,
    appId: z.string(),
    environmentId: z.string(),
    flags: z.array(FlagConfigKVSchema),
    experiments: z.array(ExperimentConfigKVSchema),
    runs: z.array(RunConfigKVSchema),
  })
  .strict();

export const ConvexConfigChangedSchema = z
  .object({
    deliveryId: UuidSchema,
    type: z.literal("config.changed"),
    appId: z.string(),
    environmentId: z.string(),
    environmentVersion: EnvironmentVersionSchema,
    changed: z.object({ entity: z.string(), id: z.string() }).strict(),
  })
  .strict();

export const ConvexServerExposureItemSchema = z
  .object({
    exposureId: UuidSchema,
    installationId: UuidSchema,
    flagKey: z.string(),
    experimentId: z.string(),
    runId: z.string(),
    runConfigHash: z.string(),
    evaluationContext: EvaluationContextSchema,
    variantName: z.string(),
    exposureAt: z.iso.datetime(),
  })
  .strict();

export const ConvexExposureVerificationRequestSchema = z
  .object({
    appId: z.string(),
    environmentId: z.string(),
    installationId: UuidSchema,
    flagKey: z.string(),
    experimentId: z.string(),
    runId: z.string(),
  })
  .strict();

export const ConvexExposureVerificationConfigSchema = z
  .object({
    appId: z.string(),
    environmentId: z.string(),
    flagKey: z.string(),
    experimentId: z.string(),
    runId: z.string(),
    runConfigHash: z.string(),
    targetingKey: z.string(),
    targetingKeyType: z.string(),
    controlVariantId: z.string(),
    salt: z.string(),
    allocation: z.record(z.string(), z.number()),
    variantSet: z.array(FlagConfigKVSchema.shape.variants.element),
    targetingRules: z.array(RunConfigKVSchema.shape.targetingRules.element),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const ConvexExposureVerificationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("installation_not_found") }).strict(),
  z.object({ status: z.literal("configuration_not_found") }).strict(),
  z.object({ status: z.literal("found"), config: ConvexExposureVerificationConfigSchema }).strict(),
]);

export const ConvexServerExposureRequestSchema = z
  .object({
    exposures: z.array(ConvexServerExposureItemSchema).min(1).max(CONVEX_SERVER_EXPOSURE_MAX_ITEMS),
  })
  .strict();

export const ConvexServerExposureResultSchema = z.discriminatedUnion("status", [
  z.object({ exposureId: UuidSchema, status: z.literal("accepted") }).strict(),
  z.object({ exposureId: UuidSchema, status: z.literal("deduplicated") }).strict(),
  z
    .object({
      exposureId: UuidSchema,
      status: z.literal("rejected"),
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const ConvexServerExposureResponseSchema = z
  .object({ results: z.array(ConvexServerExposureResultSchema) })
  .strict();

export type ConvexConfigChanged = z.infer<typeof ConvexConfigChangedSchema>;
export type ConvexConfigSnapshot = z.infer<typeof ConvexConfigSnapshotSchema>;
export type ConvexExposureVerificationConfig = z.infer<
  typeof ConvexExposureVerificationConfigSchema
>;
export type ConvexExposureVerificationRequest = z.infer<
  typeof ConvexExposureVerificationRequestSchema
>;
export type ConvexExposureVerificationResult = z.infer<
  typeof ConvexExposureVerificationResultSchema
>;
export type ConvexInstallation = z.infer<typeof ConvexInstallationSchema>;
export type ConvexInstallationStatus = z.infer<typeof ConvexInstallationStatusSchema>;
export type ConvexServerExposureItem = z.infer<typeof ConvexServerExposureItemSchema>;
export type ConvexServerExposureResponse = z.infer<typeof ConvexServerExposureResponseSchema>;
