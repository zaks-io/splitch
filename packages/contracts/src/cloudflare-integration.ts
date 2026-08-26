import { z } from "zod";
import { ConfigSnapshotSchema } from "./config-snapshot";
import {
  ConvexExposureVerificationConfigSchema,
  ConvexServerExposureItemSchema,
  ConvexServerExposureResponseSchema,
} from "./convex-integration";

const UuidSchema = z.uuid();
const EnvironmentVersionSchema = z.number().int().nonnegative();

export const CLOUDFLARE_SNAPSHOT_MAX_BODY_BYTES = 1024 * 1024;
export const CLOUDFLARE_SERVER_EXPOSURE_MAX_BODY_BYTES = 32 * 1024;
export const CLOUDFLARE_SERVER_EXPOSURE_MAX_ITEMS = 25;

export const CloudflareInstallationCreateRequestSchema = z
  .object({
    installationId: UuidSchema,
    endpoint: z.url(),
    pushSecret: z.string().min(43).max(128),
  })
  .strict();

export const CloudflareInstallationSchema = z
  .object({
    installationId: UuidSchema,
    appId: z.string(),
    environmentId: z.string(),
    environmentVersion: EnvironmentVersionSchema,
    status: z.enum(["active", "revoked"]),
  })
  .strict();

export const CloudflareInstallationStatusSchema = CloudflareInstallationSchema.extend({
  endpoint: z.url(),
  lastAppliedVersion: EnvironmentVersionSchema.nullable(),
  lastAppliedAt: z.iso.datetime().nullable(),
  pendingCount: z.number().int().nonnegative(),
  oldestPendingAgeMs: z.number().int().nonnegative().nullable(),
  terminalCount: z.number().int().nonnegative(),
  latestDeliveryError: z
    .object({
      kind: z.enum(["transport", "http", "protocol", "internal"]),
      code: z.string().min(1),
      httpStatus: z.number().int().min(100).max(599).optional(),
      causeName: z.string().min(1).optional(),
      occurredAt: z.iso.datetime(),
    })
    .strict()
    .nullable(),
}).strict();

export const CloudflareConfigSnapshotSchema = ConfigSnapshotSchema;
export const CloudflareServerExposureItemSchema = ConvexServerExposureItemSchema;
export const CloudflareExposureVerificationConfigSchema = ConvexExposureVerificationConfigSchema;

export const CloudflareServerExposureRequestSchema = z
  .object({
    exposures: z
      .array(CloudflareServerExposureItemSchema)
      .min(1)
      .max(CLOUDFLARE_SERVER_EXPOSURE_MAX_ITEMS),
  })
  .strict();

export const CloudflareServerExposureResponseSchema = ConvexServerExposureResponseSchema;

export type CloudflareConfigSnapshot = z.infer<typeof CloudflareConfigSnapshotSchema>;
export type CloudflareInstallation = z.infer<typeof CloudflareInstallationSchema>;
export type CloudflareInstallationStatus = z.infer<typeof CloudflareInstallationStatusSchema>;
export type CloudflareServerExposureItem = z.infer<typeof CloudflareServerExposureItemSchema>;
export type CloudflareServerExposureResponse = z.infer<
  typeof CloudflareServerExposureResponseSchema
>;
