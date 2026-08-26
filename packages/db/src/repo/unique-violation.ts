/**
 * Classify a D1 unique-constraint failure WITHOUT reading a message that embeds
 * bound parameters. D1 exposes no structured code on the thrown Error — the
 * extended result code only ever appears in prose — so this has to match text.
 *
 * Drizzle's top-level query error carries the SQL *and its parameters*. A
 * caller-authored value that happens to spell the constraint string would
 * classify ANY insert failure as a collision if this walked those layers.
 * Skipping every layer that carries bound parameters is necessary but not
 * sufficient: D1 also emits a parameter-free bind-time echo
 * (`D1_TYPE_ERROR: Type 'object' not supported for value '<the caller's value>'`).
 * Anchoring the match end to end closes that class.
 */

const SQLITE_UNIQUE_CODE = "SQLITE_CONSTRAINT_UNIQUE";

export function uniqueViolationMessage(violation: string): RegExp {
  return new RegExp(
    `^(D1_ERROR: )?${violation.replaceAll(".", "\\.")}: SQLITE_CONSTRAINT \\(extended: ${SQLITE_UNIQUE_CODE}\\)$`,
  );
}

export function hasUniqueViolationMessage(error: unknown, pattern: RegExp): boolean {
  for (const message of messagesNotCarryingParameters(error)) {
    if (pattern.test(message)) return true;
  }
  return false;
}

function* messagesNotCarryingParameters(error: unknown): Generator<string> {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (!embedsBoundParameters(current)) {
      yield current instanceof Error ? current.message : String(current);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
}

function embedsBoundParameters(error: unknown): boolean {
  return typeof error === "object" && error !== null && "params" in error;
}
