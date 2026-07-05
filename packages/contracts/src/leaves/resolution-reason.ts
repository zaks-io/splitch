import { z } from "zod";

export const resolutionReasons = [
  "SPLIT",
  "TARGETING_MATCH",
  "DEFAULT",
  "DISABLED",
  "CACHED",
  "STALE",
  "ERROR",
] as const;

export const ResolutionReasonSchema = z.enum(resolutionReasons);
export type ResolutionReason = z.infer<typeof ResolutionReasonSchema>;
