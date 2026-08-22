import { useRouter } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { SignOutForm } from "#components/sign-out-form";

type ShellMenuHeading =
  | { summary: ReactNode; label?: never; value?: never }
  | { label: string; value: string; summary?: never };

type ShellMenuProps = ShellMenuHeading & {
  children: ReactNode;
  /** Menus pinned to the bottom of the sidebar open upward so they stay on screen. */
  direction?: "down" | "up";
};

/**
 * The one dropdown used across the panel sidebar. The App switcher and the
 * Organization switcher are the same control; a second implementation would
 * let the two drift apart.
 */
export function ShellMenu({ children, direction = "down", label, summary, value }: ShellMenuProps) {
  const placement = direction === "up" ? "bottom-full mb-1" : "top-full mt-1";
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
      <div
        className={`absolute right-0 left-0 z-20 grid max-h-72 min-w-52 gap-0.5 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg ${placement}`}
      >
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

/**
 * A plain anchor that navigates through the router on an unmodified left
 * click. Takes a finished href (search and hash included) so callers never
 * have to disassemble one into TanStack's `to`/`search`/`hash` options.
 */
export function RouterAnchor({
  href,
  onClick,
  target,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const router = useRouter();
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (target && target !== "_self") return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    router.history.push(href);
  };

  return <a {...props} href={href} target={target} onClick={navigate} />;
}

export function ShellMenuLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <RouterAnchor
      className="rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      href={href}
      onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
    >
      {children}
    </RouterAnchor>
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
