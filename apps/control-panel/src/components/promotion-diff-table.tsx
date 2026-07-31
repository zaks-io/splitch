import { Checkbox } from "@splitch/ui/components/checkbox";
import { cn } from "@splitch/ui/lib/utils";
import type { PromotionRow } from "#lib/promotion-diff";

/**
 * The side-by-side diff, and the only place a Promotion is selected.
 *
 * Target on the left, source on the right, because the operator is standing in
 * the target: the left column is what they have now and the right is what they
 * would pull in. Every row is a whole field group at the promote endpoint's
 * granularity, so what can be ticked and what can be sent are the same set by
 * construction (ADR-0028).
 */
export function PromotionDiffTable({
  rows,
  selected,
  disabled,
  sourceEnv,
  targetEnv,
  onToggle,
  onPromoteVariant,
}: {
  rows: readonly PromotionRow[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  sourceEnv: string;
  targetEnv: string;
  onToggle: (rowId: string) => void;
  onPromoteVariant: (variantName: string) => void;
}) {
  return (
    <div className="overflow-x-auto" data-promotion-diff="true">
      <div className="min-w-[46rem]">
        <ColumnHeader sourceEnv={sourceEnv} targetEnv={targetEnv} />
        <ul className="grid">
          {rows.map((row) => (
            <PromotionDiffRow
              disabled={disabled}
              key={row.id}
              onPromoteVariant={onPromoteVariant}
              onToggle={onToggle}
              row={row}
              selected={selected.has(row.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ColumnHeader({ sourceEnv, targetEnv }: { sourceEnv: string; targetEnv: string }) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(9rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] items-baseline gap-x-4 border-border border-b px-1 pb-2">
      {/* The label is visually hidden, but the cell is not: `sr-only` is absolutely
          positioned, so hiding this span directly drops it out of the grid flow and
          slides every column header one place left of the values it names. */}
      <span>
        <span className="sr-only">Promote</span>
      </span>
      <ColumnLabel>Field group</ColumnLabel>
      <ColumnLabel>
        Now in <span className="text-foreground">{targetEnv}</span>
      </ColumnLabel>
      <ColumnLabel>
        From <span className="text-foreground">{sourceEnv}</span>
      </ColumnLabel>
    </div>
  );
}

function PromotionDiffRow({
  row,
  selected,
  disabled,
  onToggle,
  onPromoteVariant,
}: {
  row: PromotionRow;
  selected: boolean;
  disabled: boolean;
  onToggle: (rowId: string) => void;
  onPromoteVariant: (variantName: string) => void;
}) {
  const inputId = `promotion-row-${row.id.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <li
      className={cn(
        "grid grid-cols-[2.25rem_minmax(9rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] items-start gap-x-4 border-border/60 border-b px-1 py-4 transition-colors",
        selected && "bg-accent/40",
      )}
      data-promotion-row={row.id}
      data-promotion-row-kind={row.kind}
      data-promotion-row-selected={selected ? "true" : "false"}
    >
      <Checkbox
        aria-label={`Promote ${row.label}`}
        checked={selected}
        className="mt-0.5"
        data-promotion-tick={row.id}
        disabled={disabled}
        id={inputId}
        onCheckedChange={() => onToggle(row.id)}
      />

      <div className="grid gap-1">
        <label
          className="flex items-center gap-2 font-medium text-foreground text-sm"
          htmlFor={inputId}
        >
          <EffectMarker effect={row.effect} />
          <span className={row.kind === "availability" ? "font-mono" : undefined}>{row.label}</span>
        </label>
        {row.kind === "targeting" ? (
          <p className="text-[0.6875rem] text-muted-foreground leading-4">
            Promotes as one list. Rules are ordered and first-match-wins, so a subset would behave
            like neither Environment.
          </p>
        ) : null}
        {row.variantName ? (
          <button
            className="justify-self-start text-[0.6875rem] text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:no-underline disabled:opacity-50"
            data-promotion-preset={`variant:${row.variantName}`}
            disabled={disabled}
            onClick={() => onPromoteVariant(row.variantName as string)}
            type="button"
          >
            Promote this Variant only
          </button>
        ) : null}
      </div>

      <ValueColumn lines={row.target} tone="target" />
      <ValueColumn lines={row.source} tone="source" />
    </li>
  );
}

/**
 * The marker is the row's mechanical effect on the target, not a guess at intent:
 * ticking a Variant the source does not serve REMOVES it here, and the row says
 * `−` so that reads before the click rather than after it.
 */
function EffectMarker({ effect }: { effect: PromotionRow["effect"] }) {
  if (effect === "replace") {
    return (
      <span aria-hidden className="font-mono text-muted-foreground text-xs">
        ~
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "font-mono text-xs",
        effect === "add"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400",
      )}
    >
      {effect === "add" ? "+" : "−"}
    </span>
  );
}

function ValueColumn({ lines, tone }: { lines: readonly string[]; tone: "target" | "source" }) {
  if (lines.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic leading-6" data-promotion-value={tone}>
        No rules
      </p>
    );
  }
  return (
    <ul className="grid gap-1" data-promotion-value={tone}>
      {lines.map((line) => (
        <li
          className={cn(
            "text-sm leading-6",
            tone === "source" ? "text-foreground" : "text-muted-foreground",
          )}
          key={line}
        >
          {line}
        </li>
      ))}
    </ul>
  );
}

function ColumnLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.6875rem] text-muted-foreground uppercase tracking-[0.14em]">
      {children}
    </span>
  );
}
