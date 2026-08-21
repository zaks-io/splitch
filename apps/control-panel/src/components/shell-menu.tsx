import { useRouter } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { SignOutForm } from "#components/sign-out-form";

/**
 * The one dropdown used by both shells. The Org shell's switcher and user menu
 * and the App shell's three switchers are the same control; a second
 * implementation would let the two shells drift apart.
 */
export function ShellMenu({
  children,
  label,
  summary,
  value,
}: {
  children: ReactNode;
  label: string;
  summary?: ReactNode;
  value: string;
}) {
  return (
    <details className="group relative min-w-0">
      <summary className="grid cursor-pointer list-none gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 shadow-xs outline-none marker:hidden focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30">
        {summary ?? (
          <>
            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
              {label}
            </span>
            <span className="flex min-w-0 items-center justify-between gap-2 text-sm text-foreground">
              <span className="truncate">{value}</span>
              <span aria-hidden="true" className="text-muted-foreground group-open:rotate-180">
                ▾
              </span>
            </span>
          </>
        )}
      </summary>
      <div className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        {children}
      </div>
    </details>
  );
}

export function ShellMenuGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid gap-0.5 py-1 first:pt-0 last:pb-0">
      <p className="px-2 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        {label}
      </p>
      {children}
    </section>
  );
}

export function ShellMenuLink({ children, href }: { children: ReactNode; href: string }) {
  const router = useRouter();
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    event.currentTarget.closest("details")?.removeAttribute("open");
    router.history.push(href);
  };

  return (
    <a
      className="rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      href={href}
      onClick={navigate}
    >
      {children}
    </a>
  );
}

/** The sign-out entry: a POST submit, never a link, so nothing can prefetch it. */
export function ShellMenuSignOut({
  children,
  className = "rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SignOutForm className="grid">
      <button className={className} type="submit">
        {children}
      </button>
    </SignOutForm>
  );
}
