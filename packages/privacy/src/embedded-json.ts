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
 * that don't parse are left verbatim until a bounded fail-safe cap is reached.
 */

import { REDACTED } from "./redaction-rules";

type ScrubJson = (parsed: unknown) => unknown;

const MAX_FAILED_PARSE_ATTEMPTS = 32;

interface Span {
  start: number;
  end: number;
}

interface StackEntry {
  start: number;
  close: string;
}

interface ScanState {
  spans: Span[];
  stack: StackEntry[];
  inString: boolean;
  escaped: boolean;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function nextNonWhitespace(input: string, start: number): string | undefined {
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (!isWhitespace(ch)) return ch;
  }
  return undefined;
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

function canStartJson(input: string, start: number, open: string): boolean {
  const next = nextNonWhitespace(input, start + 1);
  if (open === "{") {
    return next === "}" || next === '"';
  }
  return (
    next === "]" ||
    next === "{" ||
    next === "[" ||
    next === '"' ||
    next === "-" ||
    next === "t" ||
    next === "f" ||
    next === "n" ||
    (next !== undefined && next >= "0" && next <= "9")
  );
}

function advanceString(state: ScanState, ch: string): boolean {
  if (state.stack.length === 0 || !state.inString) return false;
  if (state.escaped) {
    state.escaped = false;
  } else if (ch === "\\") {
    state.escaped = true;
  } else if (ch === '"') {
    state.inString = false;
  }
  return true;
}

function startString(state: ScanState, ch: string): boolean {
  if (state.stack.length === 0 || ch !== '"') return false;
  state.inString = true;
  return true;
}

function pushJsonOpener(state: ScanState, input: string, index: number, ch: string): boolean {
  const close = openerFor(ch);
  if (close === undefined || !canStartJson(input, index, ch)) return false;
  state.stack.push({ start: index, close });
  return true;
}

function closeTopSpan(state: ScanState, ch: string, index: number): void {
  const top = state.stack.at(-1);
  if (top?.close !== ch) return;

  const span = state.stack.pop();
  if (span !== undefined) {
    state.spans.push({ start: span.start, end: index });
  }
  if (state.stack.length === 0) {
    state.inString = false;
    state.escaped = false;
  }
}

function collectJsonSpans(input: string): Span[] {
  const state: ScanState = { spans: [], stack: [], inString: false, escaped: false };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (advanceString(state, ch)) continue;
    if (startString(state, ch)) continue;
    if (pushJsonOpener(state, input, i, ch)) continue;
    closeTopSpan(state, ch, i);
  }

  return state.spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Replace every balanced JSON object/array span inside `value` with its scrubbed
 * form. `scrub` redacts the parsed structure (the package's shared scrubber).
 *
 * The scan is one pass over plausible JSON spans. A stray prose brace before the
 * real object (`{not json {"email":"x"}}`) is not treated as JSON, so the inner
 * object is still found without retrying from every brace.
 */
export function scrubEmbeddedJson(value: string, scrub: ScrubJson): string {
  const spans = collectJsonSpans(value);
  if (spans.length === 0) return value;

  let result = "";
  let cursor = 0;
  let failedParses = 0;

  for (const span of spans) {
    if (span.start < cursor) continue;

    const scrubbed = tryScrubSpan(value.slice(span.start, span.end + 1), scrub);
    if (scrubbed === undefined) {
      failedParses += 1;
      if (failedParses >= MAX_FAILED_PARSE_ATTEMPTS) {
        return REDACTED;
      }
      continue;
    }

    result += value.slice(cursor, span.start);
    result += scrubbed;
    cursor = span.end + 1;
  }

  if (cursor === 0) return value;
  return result + value.slice(cursor);
}
