export function matchingExposureRows(
  payload: unknown,
  eventIds: readonly string[],
): readonly Record<string, unknown>[] {
  const rows = exposureRows(payload);
  const selected = new Set(eventIds);
  return rows.filter((row) => typeof row.event_id === "string" && selected.has(row.event_id));
}

export function withoutExposureRows(payload: unknown, eventIds: readonly string[]): unknown {
  if (!isRecord(payload)) throw new Error("Evaluation commit payload is invalid");
  const selected = new Set(eventIds);
  return {
    ...payload,
    exposureRows: exposureRows(payload).filter(
      (row) => typeof row.event_id !== "string" || !selected.has(row.event_id),
    ),
  };
}

function exposureRows(payload: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.exposureRows)) {
    throw new Error("Evaluation commit Exposure rows are invalid");
  }
  if (payload.exposureRows.some((row) => !isRecord(row))) {
    throw new Error("Evaluation commit Exposure row is invalid");
  }
  return payload.exposureRows as Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
