/**
 * The one rule for printing a p-value, shared by the Worker's refusal text and
 * every rendering surface so the same number never reads two ways.
 *
 * `String` on a double gives the shortest decimal that round-trips to exactly
 * that double, which makes the rendering injective: two different p-values can
 * never print identically. Fixed precision cannot promise that. `toPrecision(3)`
 * prints 0.0499 and 0.0501 both as "0.0500", and a `<0.0001` floor collapses
 * every small p-value into one string, so in both cases the reader loses which
 * side of a decision threshold the result actually landed on.
 */
export function formatPValue(value: number): string {
  // A bare "1" or "0" reads as a count rather than a probability. One decimal
  // place restores the scale without merging any two distinct values.
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
