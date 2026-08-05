import { z } from "zod";

/**
 * Draft Experiment allocation: keys are Variant names (CONTEXT.md), values are
 * shares. Shape-only here — Start validates sum / membership. Shared identity so
 * request-body help can label keys without a field-name string special case.
 */
export const DraftAllocationSchema = z.record(z.string(), z.number());
