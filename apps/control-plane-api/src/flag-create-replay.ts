import { FlagResponseSchema } from "@splitch/contracts";

/**
 * A stored create response, from before or after D9. Pre-D9 responses carry no
 * lifecycle fields, and replay returns the original response rather than a
 * re-rendering of the row as it is now.
 */
export const StoredFlagCreateResponseSchema = FlagResponseSchema.or(
  FlagResponseSchema.omit({ lifecycleClass: true, owner: true, expiresAt: true }),
);
