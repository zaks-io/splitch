import { z } from "zod";
import { UserRoleSchema } from "./leaf-schemas-runtime";

const OrganizationMembershipSchema = z
  .object({
    id: z.string().min(1),
    role: UserRoleSchema,
  })
  .strict();

const AppMembershipSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    role: UserRoleSchema,
  })
  .strict();

export const MembershipSetSchema = z
  .object({
    organizations: z.array(OrganizationMembershipSchema),
    apps: z.array(AppMembershipSchema),
  })
  .strict()
  .superRefine((memberships, context) => {
    const organizationIds = new Set(memberships.organizations.map(({ id }) => id));
    for (const [index, app] of memberships.apps.entries()) {
      if (!organizationIds.has(app.organizationId)) {
        context.addIssue({
          code: "custom",
          path: ["apps", index, "organizationId"],
          message: "App membership requires membership in its Organization",
        });
      }
    }
  });

export type MembershipSet = z.infer<typeof MembershipSetSchema>;

// Workers KV's shortest supported expiration TTL keeps a missed invalidation
// bounded to the same roughly one-minute posture as its default read cache.
export const MEMBERSHIP_CACHE_TTL_SECONDS = 60;

const MEMBERSHIP_CACHE_PREFIX = "memberships:";

export function membershipCacheKey(userId: string): string {
  return `${MEMBERSHIP_CACHE_PREFIX}${userId}`;
}
