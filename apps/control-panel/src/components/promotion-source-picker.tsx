import { cn } from "@splitch/ui/lib/utils";

/**
 * Which Environment this Promotion pulls FROM.
 *
 * Plain links carrying `?from=`, so the source is in the URL: a Promotion diff is
 * a thing you send someone, and a source held only in component state would make
 * the link mean something different for whoever opened it.
 */
export function PromotionSourcePicker({
  options,
  currentEnv,
  scopeHref,
  flagKey,
}: {
  options: readonly { env: string; environmentId: string }[];
  currentEnv: string;
  scopeHref: string;
  flagKey: string;
}) {
  if (options.length < 2) return null;

  return (
    <nav
      aria-label="Promotion source Environment"
      className="flex flex-wrap items-center gap-2 pt-1"
    >
      <span className="font-mono text-[0.6875rem] text-muted-foreground uppercase tracking-[0.14em]">
        Source
      </span>
      {options.map((option) => (
        <a
          aria-current={option.env === currentEnv ? "page" : undefined}
          className={cn(
            "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
            option.env === currentEnv
              ? "border-foreground/30 bg-accent text-foreground"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
          data-promotion-source-option={option.env}
          href={`${scopeHref}/flags/${encodeURIComponent(flagKey)}/promote?from=${encodeURIComponent(option.env)}`}
          key={option.environmentId}
        >
          {option.env}
        </a>
      ))}
    </nav>
  );
}
