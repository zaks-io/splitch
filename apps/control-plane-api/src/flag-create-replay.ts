import {
  CreateFlagRequestSchema,
  FlagLifecycleClassSchema,
  FlagResponseSchema,
  type RouteContract,
} from "@splitch/contracts";

type ExtendableInput = {
  extend?: (shape: Record<string, unknown>) => RouteContract["input"];
};

/**
 * `flags_create` as this Worker parses it. The published contract requires
 * `lifecycleClass` (D9), but a create that completed before D9 shipped was
 * hashed and stored without one. A retry of that unchanged request must replay
 * the stored response, so the class is optional at the parse boundary and the
 * handler requires it only once the Idempotency Key has proven to be new.
 */
export function replayTolerantCreateRoute(route: RouteContract): RouteContract {
  const input = route.input as unknown as ExtendableInput;
  if (typeof input.extend !== "function") {
    throw new Error("flags_create: expected an object input schema to relax for replay");
  }
  return {
    ...route,
    input: input.extend({
      body: CreateFlagRequestSchema.extend({ lifecycleClass: FlagLifecycleClassSchema.optional() }),
    }),
  };
}

/**
 * A stored create response, from before or after D9. Pre-D9 responses carry no
 * lifecycle fields, and replay returns the original response rather than a
 * re-rendering of the row as it is now.
 */
export const StoredFlagCreateResponseSchema = FlagResponseSchema.or(
  FlagResponseSchema.omit({ lifecycleClass: true, owner: true, expiresAt: true }),
);
