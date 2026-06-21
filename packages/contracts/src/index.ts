import { z } from "zod";

export const platformTargets = ["local", "pr-ci", "shared-preview", "production"] as const;

export const PlatformTargetSchema = z.enum(platformTargets);
export type PlatformTarget = z.infer<typeof PlatformTargetSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  platformTarget: PlatformTargetSchema,
  service: z.string().min(1),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function parsePlatformTarget(value: string | undefined): PlatformTarget {
  const parsed = PlatformTargetSchema.safeParse(value);
  return parsed.success ? parsed.data : "local";
}

export function createHealthResponse(
  service: string,
  platformTarget: PlatformTarget = "local",
): HealthResponse {
  return HealthResponseSchema.parse({
    ok: true,
    platformTarget,
    service,
  });
}
