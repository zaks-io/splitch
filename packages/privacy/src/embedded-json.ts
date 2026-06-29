/**
 * Scrub JSON that is EMBEDDED inside a larger string — the canonical leak where a
 * stringified Evaluation Context is glued into an exception message, e.g.
 * `"evaluate failed for {\"context\":{\"email\":\"x\"}}"`. Whole-string JSON is a
 * special case of this.
 *
 * WHY a hand scanner: a regex can't match balanced braces, and JSON.parse rejects
 * a string with a non-JSON prefix. We find each balanced `{...}` / `[...]` span
 * (respecting quoting/escapes so braces inside strings don't fool us), parse it,
 * hand it to the injected scrubber, and splice the redacted JSON back in. Spans
 * that don't parse are left verbatim.
 */

type ScrubJson = (parsed: unknown) => unknown;

/**
 * Above this length we SKIP the embedded-JSON scan. The balanced-brace retry is
 * O(n²) on an adversarial run of unparseable braces (`{{{{…`), which an attacker
 * who can get untrusted input into an exception message could use to pin Worker
 * CPU. The cap bounds that worst case to a few ms. A real stringified context is
 * well under 4 KB; legitimate payloads stay under the cap. Over-cap strings still
 * pass through the linear value-pattern scrubber, so PII shapes (email/phone/
 * Targeting Key) are caught regardless.
 */
const MAX_EMBEDDED_SCAN_LEN = 4_096;

interface Scan {
  end: number;
  matched: boolean;
}

interface ScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

/** Advance the string-aware scanner one char; returns the nesting delta (-1/0/1). */
function step(state: ScanState, ch: string, open: string, close: string): number {
  if (state.escaped) {
    state.escaped = false;
    return 0;
  }
  if (ch === "\\") {
    state.escaped = true;
    return 0;
  }
  if (ch === '"') {
    state.inString = !state.inString;
    return 0;
  }
  if (state.inString) return 0;
  if (ch === open) return 1;
  if (ch === close) return -1;
  return 0;
}

/** Walk from an opening brace/bracket to its balanced close, honoring strings. */
function findBalancedEnd(input: string, start: number, open: string, close: string): Scan {
  const state: ScanState = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < input.length; i++) {
    state.depth += step(state, input[i] as string, open, close);
    if (state.depth === 0 && !state.inString && !state.escaped) {
      return { end: i, matched: true };
    }
  }
  return { end: input.length, matched: false };
}

function tryScrubSpan(span: string, scrub: ScrubJson): string | undefined {
  try {
    return JSON.stringify(scrub(JSON.parse(span)));
  } catch {
    return undefined;
  }
}

function openerFor(ch: string | undefined): string | undefined {
  if (ch === "{") return "}";
  if (ch === "[") return "]";
  return undefined;
}

/**
 * Replace every balanced JSON object/array span inside `value` with its scrubbed
 * form. `scrub` redacts the parsed structure (the package's shared scrubber).
 *
 * On a span that does NOT parse as JSON (e.g. a stray prose brace before the real
 * object: `{not json {"email":"x"}}`), we emit just the opening char and advance
 * by ONE — so the scanner re-tries from the NEXT inner opening brace and still
 * finds the real JSON. Skipping the whole balanced region would leak it.
 */
export function scrubEmbeddedJson(value: string, scrub: ScrubJson): string {
  if (value.length > MAX_EMBEDDED_SCAN_LEN) {
    return value;
  }
  let result = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    const close = openerFor(ch);
    if (close === undefined) {
      result += ch;
      i++;
      continue;
    }
    const { end, matched } = findBalancedEnd(value, i, ch as string, close);
    const scrubbed = matched ? tryScrubSpan(value.slice(i, end + 1), scrub) : undefined;
    if (scrubbed === undefined) {
      result += ch;
      i++;
      continue;
    }
    result += scrubbed;
    i = end + 1;
  }
  return result;
}
