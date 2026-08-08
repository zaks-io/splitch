/**
 * Percent-decoding for path segments lifted out of a matched route. A segment
 * that is not valid percent-encoding decodes to null so the caller refuses the
 * claim rather than binding a delegation to a mangled resource id.
 */

export function decodedSegments(values: string[]): Array<string | null> {
  return values.map(decodeSegment);
}

export function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
