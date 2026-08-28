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

/**
 * Coerce an env value to a platform target, defaulting unrecognized or missing
 * values to `local`. That fallback is for health display and non-hosted callers.
 * Hosted Auth, MCP, and Event Ingest entrypoints must use `requirePlatformTarget`
 * / `isLocalPlatformTarget` instead — an unset target must not route traffic to
 * localhost or unlock committed local secrets.
 */
export function parsePlatformTarget(value: string | undefined): PlatformTarget {
  const parsed = PlatformTargetSchema.safeParse(value);
  return parsed.success ? parsed.data : "local";
}

/** Explicit local or PR CI fixtures. Missing and invalid values are not local. */
export function isLocalPlatformTarget(value: string | undefined): boolean {
  return value === "local" || value === "pr-ci";
}

export function isHostedPlatformTarget(value: string | undefined): boolean {
  return value === "shared-preview" || value === "production";
}

/** Fail closed: never silently substitute `local` for a missing or invalid target. */
export function requirePlatformTarget(value: string | undefined): PlatformTarget {
  const parsed = PlatformTargetSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      value === undefined
        ? "SPLITCH_PLATFORM_TARGET is required"
        : `SPLITCH_PLATFORM_TARGET "${value}" is not a platform target`,
    );
  }
  return parsed.data;
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
