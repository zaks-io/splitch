import { z } from "zod";
import { persistedRecord } from "./persisted-field-limits";

/**
 * Draft Experiment allocation: keys are Variant names (CONTEXT.md), values are
 * shares. Shape-only here — Start validates sum / membership. Shared identity so
 * request-body help can label keys without a field-name string special case.
 */
export const DraftAllocationSchema = persistedRecord(z.number());
