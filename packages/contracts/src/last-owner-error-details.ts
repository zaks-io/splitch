import { z } from "zod";

/**
 * Ownership is a per-tier grant, so the refusal names the tier it came from:
 * `orgId` for the last owner of an Organization, `appId` for the last owner of an
 * App (`app_memberships`). A single object with both keys optional would let a
 * caller receive the refusal without learning WHICH resource would be orphaned.
 */
export const LastOwnerRequiredDetailsSchema = z.union([
  z.object({ orgId: z.string() }).strict(),
  z.object({ appId: z.string() }).strict(),
]);
