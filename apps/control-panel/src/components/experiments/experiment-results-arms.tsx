import { Fragment } from "react";
import { armColor } from "#lib/experiments/arm-colors";

export const RESULTS_RAIL_GRID =
  "grid grid-cols-[1.125rem_minmax(0,1fr)] sm:grid-cols-[5.5rem_minmax(0,1fr)]";

/** Aligns a station's rail nodes with the first text line of its card. */
export const RAIL_NODE_TOP = "1.875rem";

/** The sm+ rail column is 5.5rem wide; the spine geometry hangs off its center. */
const RAIL_COLUMN_CENTER = 44;

/**
 * Distance between neighboring rails. 24px is the spine sketch's pitch; it
 * compresses only when the bundle would outgrow the 5.5rem rail column.
 */
function railPitch(count: number): number {
  return count > 1 ? Math.min(24, 72 / (count - 1)) : 0;
}

/** Rail x-offset from the rail-column center. */
export function railOffset(index: number, count: number): number {
  return (index - (count - 1) / 2) * railPitch(count);
}

export function ExperimentResultsArms({
  allocation,
  baseline,
  dedupedCounts,
  variantOrder,
}: {
  allocation: Record<string, number>;
  baseline: string;
  dedupedCounts: Record<string, number>;
  variantOrder: readonly string[];
}) {
  if (variantOrder.length === 0) throw new Error("Run has no frozen Variants");
  const total = variantOrder.reduce(
    (sum, variant) => sum + requiredCount(dedupedCounts, variant),
    0,
  );
  return (
    <section aria-labelledby="results-allocation-heading" className={RESULTS_RAIL_GRID}>
      <div className="relative hidden sm:block" aria-hidden="true">
        <Fork variantOrder={variantOrder} baseline={baseline} />
        <ExperimentResultsRails
          baseline={baseline}
          className="absolute inset-x-0 bottom-0"
          style={{ top: FORK_HEIGHT }}
          variantOrder={variantOrder}
        />
      </div>
      <div className="relative h-20 sm:hidden" aria-hidden="true">
        <span className="absolute top-0 bottom-0 left-1/2 border-border border-l-2" />
        <span className="absolute top-1.5 left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-border bg-background" />
      </div>

      <div className="pb-8 sm:pb-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-foreground text-sm" id="results-allocation-heading">
            Allocation
          </h3>
          <p className="font-mono text-muted-foreground text-xs">
            {variantOrder.length} Variants · {total.toLocaleString("en-US")} deduped exposures
          </p>
        </div>
        {/* The first row's center must clear FORK_STRAIGHT_Y so its rowmark
            sits on a straight rail, not mid-curve. */}
        <ul className="grid gap-2" style={{ marginTop: 20 }}>
          {variantOrder.map((variant, index) => {
            const color = armColor({ baseline, variant, variantOrder });
            const share = allocation[variant];
            if (share === undefined) {
              throw new Error(`Missing allocation for frozen Variant ${variant}`);
            }
            const count = requiredCount(dedupedCounts, variant);
            // Absolute children offset from the padding box, which the row's
            // 3px colored left border shifts right of the rail grid.
            const railX = railOffset(index, variantOrder.length) - RAIL_COLUMN_CENTER - 3;
            return (
              <li
                className="relative flex min-h-11 items-center gap-3 rounded-r-md border-l-[3px] bg-muted/50 py-2 pr-3 pl-4"
                key={variant}
                style={{ borderLeftColor: color }}
              >
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 hidden -translate-y-1/2 sm:block"
                  style={{
                    backgroundColor: "var(--border)",
                    height: 1,
                    left: railX,
                    opacity: 0.6,
                    width: -railX,
                  }}
                />
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background sm:block"
                  style={{ height: 12, left: railX, width: 12 }}
                >
                  <span
                    className="absolute rounded-full"
                    style={{ backgroundColor: color, inset: 1 }}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm sm:flex-none sm:basis-40">
                  {variant}
                </span>
                <span className="font-mono text-muted-foreground text-sm">{share}%</span>
                <span className="text-muted-foreground text-xs">
                  {variant === baseline ? "baseline" : "treatment"}
                </span>
                <span className="ml-auto font-mono text-foreground text-sm">
                  {count.toLocaleString("en-US")}
                </span>
                <span className="hidden font-mono text-muted-foreground text-xs sm:inline">
                  exposures
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function ExperimentResultsRails({
  baseline,
  variantOrder,
  flaggedVariant,
  className = "relative",
  connect = false,
  siding = false,
  style,
}: {
  baseline: string;
  variantOrder: readonly string[];
  flaggedVariant?: string;
  className?: string;
  connect?: boolean;
  siding?: boolean;
  style?: React.CSSProperties;
}) {
  const count = variantOrder.length;
  const nodeSize = count > 1 && railPitch(count) < 10 ? 6 : 10;
  return (
    <div className={className} style={style} aria-hidden="true">
      <div className="absolute inset-0 hidden sm:block">
        {connect ? (
          <span
            className="absolute right-0"
            style={{
              backgroundColor: "var(--border)",
              height: 1,
              left: `calc(50% + ${railOffset(0, count)}px)`,
              top: RAIL_NODE_TOP,
            }}
          />
        ) : null}
        {variantOrder.map((variant, index) => {
          const left = `calc(50% + ${railOffset(index, count)}px)`;
          const flagged = variant === flaggedVariant;
          const color = flagged ? "var(--warning)" : armColor({ baseline, variant, variantOrder });
          return (
            <Fragment key={variant}>
              <span
                className="absolute inset-y-0 -translate-x-1/2"
                style={{ backgroundColor: color, borderRadius: 1, left, width: 2 }}
              />
              {connect ? (
                <RailNode color={color} flagged={flagged} left={left} size={nodeSize} />
              ) : null}
            </Fragment>
          );
        })}
        {siding ? <SidingSpur count={count} /> : null}
      </div>
      <span className="absolute inset-y-0 left-1/2 border-border border-l-2 sm:hidden" />
      {connect || siding ? (
        <span
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-border bg-background sm:hidden"
          style={{ height: 8, top: RAIL_NODE_TOP, width: 8 }}
        />
      ) : null}
    </div>
  );
}

/** A station's tap on one arm rail; a flagged arm gets the loud diamond. */
function RailNode({
  color,
  flagged,
  left,
  size,
}: {
  color: string;
  flagged: boolean;
  left: string;
  size: number;
}) {
  if (flagged) {
    return (
      <span
        className="absolute"
        style={{
          backgroundColor: "var(--warning)",
          borderRadius: 2,
          height: 14,
          left,
          top: RAIL_NODE_TOP,
          transform: "translate(-50%, -50%) rotate(45deg)",
          width: 14,
        }}
      />
    );
  }
  return (
    <span
      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background"
      style={{ borderColor: color, height: size, left, top: RAIL_NODE_TOP, width: size }}
    />
  );
}

/**
 * The Exploratory card is a siding, off the decision line: a dashed spur leaves
 * the last rail and runs into the card instead of docking with nodes.
 */
function SidingSpur({ count }: { count: number }) {
  const width = RAIL_COLUMN_CENTER - railOffset(count - 1, count);
  return (
    <svg
      aria-hidden="true"
      className="absolute"
      fill="none"
      style={{ height: 30, left: `calc(50% + ${railOffset(count - 1, count)}px)`, top: 0, width }}
      viewBox={`0 0 ${width} 30`}
    >
      <path
        d={`M1 0 C1 17, 6 23, ${width - 1} 29`}
        stroke="var(--muted-foreground)"
        strokeDasharray="4 4"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * The fork must resolve into straight rails before the first allocation row
 * docks, so its rowmark sits on the rail instead of floating beside a curve.
 */
const FORK_HEIGHT = 64;
const FORK_STRAIGHT_Y = 56;

function Fork({ baseline, variantOrder }: { baseline: string; variantOrder: readonly string[] }) {
  const width = 88;
  const center = width / 2;
  return (
    <svg
      aria-hidden="true"
      className="block"
      fill="none"
      height={FORK_HEIGHT}
      viewBox={`0 0 ${width} ${FORK_HEIGHT}`}
      width={width}
    >
      <path d={`M${center} 0 L${center} 12`} stroke="var(--border)" strokeWidth="2" />
      <circle
        cx={center}
        cy="16"
        fill="var(--background)"
        r="4"
        stroke="var(--border)"
        strokeWidth="2"
      />
      {variantOrder.map((variant, index) => {
        const x = center + railOffset(index, variantOrder.length);
        return (
          <path
            d={`M${center} 20 C${center} 38, ${x} 38, ${x} ${FORK_STRAIGHT_Y} L${x} ${FORK_HEIGHT}`}
            key={variant}
            stroke={armColor({ baseline, variant, variantOrder })}
            strokeWidth="2"
          />
        );
      })}
    </svg>
  );
}

function requiredCount(counts: Record<string, number>, variant: string): number {
  const count = counts[variant];
  if (count === undefined) throw new Error(`Missing deduped exposure count for Variant ${variant}`);
  return count;
}
