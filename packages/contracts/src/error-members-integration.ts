import { z } from "zod";
import type { ErrorCode } from "./error-code";

/**
 * "Installation not found" members for the outbound integrations (Convex,
 * Cloudflare, Sentry). Split from `errors.ts` so that file stays under the
 * file-size ratchet (300 code lines); every integration added later belongs
 * here rather than growing `errors.ts` again.
 */
export const integrationErrorMembers = [
  member("CONVEX_INSTALLATION_NOT_FOUND", EmptyDetails()),
  member("CLOUDFLARE_INSTALLATION_NOT_FOUND", EmptyDetails()),
  member("SENTRY_INSTALLATION_NOT_FOUND", EmptyDetails()),
] as const;

function EmptyDetails() {
  return z.object({}).strict();
}

function member<C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) {
  return z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });
}
