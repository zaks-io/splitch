import { cn } from "#lib/utils";

/**
 * Served from each app's own asset bundle, written by
 * `pnpm brand:assets` from the master in `assets/brand/`.
 */
const MARK_SRC = "/brand/splitch-mark.png";

/** Intrinsic size of that file, so the glyph reserves its box before it loads. */
const MARK_WIDTH = 193;
const MARK_HEIGHT = 156;

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-display font-bold text-2xl tracking-tight",
        className,
      )}
    >
      <img
        alt=""
        aria-hidden="true"
        className="mr-2 h-[1.1em] w-auto"
        height={MARK_HEIGHT}
        src={MARK_SRC}
        width={MARK_WIDTH}
      />
      split
      <span
        aria-hidden="true"
        className="mx-0.5 inline-block h-[0.72em] w-1.5 rounded-sm bg-[linear-gradient(180deg,var(--color-brand-control-500)_0_50%,var(--color-brand-treatment-500)_50%_100%)]"
      />
      ch
    </span>
  );
}
