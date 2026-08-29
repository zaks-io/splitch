import { z } from "@hono/zod-openapi";

export const EntityAssignmentPrivacyRequestSchema = z
  .object({
    idType: z.string().min(1),
    targetingKey: z.string().min(1),
    deleteBeforeTs: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const EntityAssignmentPrivacyExportSchema = z
  .object({
    appId: z.string(),
    idType: z.string(),
    targetingKeyHashes: z.array(z.string()),
    entityFamilyHash: z.string(),
    records: z.array(
      z.object({
        targetingKeyHash: z.string(),
        assignments: z.record(z.string(), z.object({ runId: z.string(), variant: z.string() })),
        assignmentWriterAssignments: z.record(
          z.string(),
          z.object({ runId: z.string(), variant: z.string() }),
        ),
        holdoverWrites: z.array(z.record(z.string(), z.unknown())),
        holdoverSuppression: z
          .object({ deleteBeforeTsMs: z.number().finite() })
          .strict()
          .nullable(),
      }),
    ),
    proofs: z.array(z.string().min(1)),
  })
  .strict();

export const EntityAssignmentPrivacyDeleteSchema = z
  .object({
    appId: z.string(),
    idType: z.string(),
    targetingKeyHashes: z.array(z.string()),
    entityFamilyHash: z.string(),
    deletedKeyCount: z.number().int().nonnegative(),
    deletedWriterCount: z.number().int().nonnegative(),
    deletedOutboxCount: z.number().int().nonnegative(),
    proofs: z.array(z.string().min(1)),
  })
  .strict();

export const EntityStorePrivacyRequestSchema = z
  .object({
    idType: z.string().min(1),
    targetingKeyHashes: z.array(z.string().min(1)).min(1),
    entityFamilyHash: z.string().min(1),
    deleteBeforeTs: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const EntityStorePrivacyExportSchema = z
  .object({
    appId: z.string(),
    idType: z.string(),
    targetingKeyHashes: z.array(z.string()),
    entityFamilyHash: z.string(),
    records: z.array(z.record(z.string(), z.unknown())),
    proofs: z.array(z.string().min(1)),
  })
  .strict();

export const EntityStorePrivacyMutationSchema = z
  .object({
    appId: z.string(),
    idType: z.string(),
    targetingKeyHashes: z.array(z.string()),
    entityFamilyHash: z.string(),
    proofs: z.array(z.string().min(1)),
  })
  .strict();
