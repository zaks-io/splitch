import { z } from "zod";

const AppMembershipSchema = z
  .object({ appId: z.string().min(1), appSlug: z.string().min(1), role: z.string().min(1) })
  .strict();
const CurrentOrgMembershipSchema = z
  .object({
    orgId: z.string().min(1),
    orgSlug: z.string().min(1),
    orgRole: z.string().min(1),
    isProvisional: z.boolean(),
    demoExpiresAt: z.string().min(1).nullable(),
    apps: z.array(AppMembershipSchema),
  })
  .strict();
const LegacyOrgMembershipSchema = z
  .object({
    orgId: z.string().min(1),
    orgSlug: z.string().min(1),
    orgRole: z.string().min(1),
    apps: z.array(AppMembershipSchema),
  })
  .strict();

/** Immutable, server-derived data stored with a hibernating panel socket. */
export const LiveUpdateConnectionContextSchema = z
  .object({
    version: z.literal(1),
    sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    userId: z.string().min(1),
    orgId: z.string().min(1),
    appId: z.string().min(1),
    environmentId: z.string().min(1),
    expiresAt: z.int().positive(),
  })
  .strict();
export type LiveUpdateConnectionContext = z.infer<typeof LiveUpdateConnectionContextSchema>;

const LiveUpdateSessionSchema = z
  .object({
    userId: z.string().min(1),
    orgs: z.array(z.union([CurrentOrgMembershipSchema, LegacyOrgMembershipSchema])),
    expiresAt: z.int().positive(),
    workosSessionId: z.string().min(1).optional(),
    workosAccessToken: z.string().min(1).optional(),
    version: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict();

export function parseLiveUpdateConnectionContext(raw: unknown): LiveUpdateConnectionContext | null {
  const result = LiveUpdateConnectionContextSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Revalidates only the authorization facts needed by the live-update channel.
 * The full session remains owned by the Control Panel and is never forwarded to
 * the browser or stored in a socket attachment.
 */
export function authorizesLiveUpdateConnection(
  rawSession: string | null,
  context: LiveUpdateConnectionContext,
  now = Date.now(),
): boolean {
  if (!rawSession) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSession);
  } catch {
    return false;
  }
  const session = LiveUpdateSessionSchema.safeParse(parsed);
  if (!session.success || session.data.expiresAt <= Math.floor(now / 1_000)) {
    return false;
  }
  if (session.data.userId !== context.userId || session.data.expiresAt !== context.expiresAt) {
    return false;
  }

  return session.data.orgs.some(
    (org) => org.orgId === context.orgId && org.apps.some((app) => app.appId === context.appId),
  );
}
