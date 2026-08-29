import { z } from "zod";

/**
 * DeltaNudge — the schema-opaque "something changed, go look" signal the per-App
 * live-update Durable Object broadcasts over the hibernating WebSocket (ADR-0019).
 * Source of truth: docs/spec/platform/live-updates-do.md (broadcast payload).
 *
 * The DO never sends the config body — only the entity that changed and a
 * monotonic `version` for self-edit skip. Subscribers (the frontend Query store
 * and the edge Provider cache) invalidate the matching key on receipt and
 * re-fetch from the read API; they never apply the delta in place.
 *
 * `.strict()` so an unexpected extra field is rejected loudly rather than carried.
 */

export const deltaNudgeEntities = ["flag", "experiment", "run", "segment"] as const;

export const DeltaNudgeEntitySchema = z.enum(deltaNudgeEntities);
export type DeltaNudgeEntity = z.infer<typeof DeltaNudgeEntitySchema>;

export const DeltaNudgeSchema = z
  .object({
    // Discriminator — config/operational state only, never live statistics.
    type: z.literal("config.changed"),
    entity: DeltaNudgeEntitySchema,
    // The id of the entity that changed.
    id: z.string(),
    // Monotonic version on the entity; lets a subscriber skip a self-edit it
    // already has (`nudge.version <= cached_version`).
    version: z.number().int().min(0),
    // Explicit deletion marker. A deleted entity has no version a subscriber
    // can compare for freshness, so version zero must not carry this meaning.
    deleted: z.literal(true).optional(),
  })
  .strict();
export type DeltaNudge = z.infer<typeof DeltaNudgeSchema>;
