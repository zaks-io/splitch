import { cn } from "#lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-display font-bold text-2xl tracking-tight",
        className,
      )}
    >
      split
      <span
        aria-hidden="true"
        className="mx-0.5 inline-block h-[0.72em] w-1.5 rounded-sm bg-[linear-gradient(180deg,var(--color-brand-control-500)_0_50%,var(--color-brand-treatment-500)_50%_100%)]"
      />
      ch
    </span>
  );
}
