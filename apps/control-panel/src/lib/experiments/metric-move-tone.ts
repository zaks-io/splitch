import type { Metric } from "@splitch/contracts";

export type MoveTone = "good" | "bad" | "breached" | "neutral";

/**
 * Whether a relative move reads as a win or a loss. Only the Metric's own
 * stated direction can say so; without one the move is neutral, because a
 * negative lift on a lower-is-better Metric is a win and guessing would
 * colour it wrong. A breached Guardrail outranks direction: it is the one
 * verdict the Run actually froze.
 */
export function moveTone({
  direction,
  lift,
  breached,
}: {
  direction: Metric["direction"] | undefined;
  lift: number | null;
  breached: boolean;
}): MoveTone {
  if (breached) return "breached";
  if (!direction || lift === null || lift === 0) return "neutral";
  const improved = direction === "higher_is_better" ? lift > 0 : lift < 0;
  return improved ? "good" : "bad";
}
