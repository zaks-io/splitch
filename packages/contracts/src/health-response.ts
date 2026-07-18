import { z } from "zod";

export const platformTargets = ["local", "pr-ci", "shared-preview", "production"] as const;

export const PlatformTargetSchema = z.enum(platformTargets);
export type PlatformTarget = z.infer<typeof PlatformTargetSchema>;

export const FullCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    platformTarget: PlatformTargetSchema,
    service: z.string().min(1),
    deployedCommitSha: FullCommitShaSchema.optional(),
  })
  .superRefine((response, context) => {
    if (
      (response.platformTarget === "shared-preview" || response.platformTarget === "production") &&
      response.deployedCommitSha === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: `deployedCommitSha is required for ${response.platformTarget}`,
        path: ["deployedCommitSha"],
      });
    }
  });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function parsePlatformTarget(value: string | undefined): PlatformTarget {
  const parsed = PlatformTargetSchema.safeParse(value);
  return parsed.success ? parsed.data : "local";
}

export function createHealthResponse(
  service: string,
  platformTarget: PlatformTarget = "local",
  deployedCommitSha?: string,
): HealthResponse {
  return HealthResponseSchema.parse({
    ok: true,
    platformTarget,
    service,
    deployedCommitSha,
  });
}
