import { z } from "@hono/zod-openapi";
import type { DeleteFlagRequestSchema, FlagRemovalBriefResponseSchema } from "./flag-removal";
import type {
  CreateFlagRequestSchema,
  CreateVariantRequestSchema,
  ExpiredFlagListResponseSchema,
  FlagListReadResponseSchema,
  FlagMutationResponseSchema,
  FlagReadResponseSchema,
  FlagResponseSchema,
  PatchFlagRequestSchema,
  PatchVariantRequestSchema,
  PrincipalFlagListReadResponseSchema,
} from "./resource-envelopes-flag";
import type {
  FlagInventoryHealthResponseSchema,
  StaleFlagListResponseSchema,
} from "./resource-envelopes-flag-health";
import type {
  AppParams,
  FlagGetQuerySchema,
  FlagListQuerySchema,
  FlagParams,
  FlagVariantParams,
  PrincipalFlagListQuerySchema,
} from "./routes/route-shapes";

const DeletedResponseSchema = z.object({ deleted: z.literal(true) });

export type FlagsListInput = z.infer<typeof AppParams> & z.infer<typeof FlagListQuerySchema>;
export type FlagsListOutput = z.infer<typeof FlagListReadResponseSchema>;
export type ExpiredFlagsListInput = z.infer<typeof AppParams>;
export type ExpiredFlagsListOutput = z.infer<typeof ExpiredFlagListResponseSchema>;
export type StaleFlagsListInput = z.infer<typeof AppParams>;
export type StaleFlagsListOutput = z.infer<typeof StaleFlagListResponseSchema>;
export type FlagInventoryHealthGetInput = z.infer<typeof AppParams>;
export type FlagInventoryHealthGetOutput = z.infer<typeof FlagInventoryHealthResponseSchema>;
export type PrincipalFlagsListInput = z.infer<typeof PrincipalFlagListQuerySchema>;
export type PrincipalFlagsListOutput = z.infer<typeof PrincipalFlagListReadResponseSchema>;
export type FlagsCreateInput = z.infer<typeof AppParams> & z.infer<typeof CreateFlagRequestSchema>;
export type FlagsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsGetInput = z.infer<typeof FlagParams> & z.infer<typeof FlagGetQuerySchema>;
export type FlagsGetOutput = z.infer<typeof FlagReadResponseSchema>;
export type FlagsUpdateInput = z.infer<typeof FlagParams> & z.infer<typeof PatchFlagRequestSchema>;
export type FlagsUpdateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagsDeleteInput = z.infer<typeof FlagParams> & z.infer<typeof DeleteFlagRequestSchema>;
export type FlagsDeleteOutput = z.infer<typeof DeletedResponseSchema>;
export type FlagRemovalBriefInput = z.infer<typeof FlagParams>;
export type FlagRemovalBriefOutput = z.infer<typeof FlagRemovalBriefResponseSchema>;
export type FlagVariantsCreateInput = z.infer<typeof FlagParams> &
  z.infer<typeof CreateVariantRequestSchema>;
export type FlagVariantsCreateOutput = z.infer<typeof FlagResponseSchema>;
export type FlagVariantsUpdateInput = z.infer<typeof FlagVariantParams> &
  z.infer<typeof PatchVariantRequestSchema>;
export type FlagVariantsUpdateOutput = z.infer<typeof FlagMutationResponseSchema>;
export type FlagVariantsDeleteInput = z.infer<typeof FlagVariantParams>;
export type FlagVariantsDeleteOutput = z.infer<typeof FlagResponseSchema>;
