import { Badge } from "@splitch/ui/components/badge";
import { BrandMark } from "@splitch/ui/components/brand-mark";
import { Button } from "@splitch/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@splitch/ui/components/sheet";
import { ThemeToggle } from "@splitch/ui/components/theme-toggle";
import { MenuIcon } from "lucide-react";

const links = [
  ["/#product", "Product"],
  ["/#agents", "For agents"],
  ["/#rigor", "Rigor"],
  ["/quickstart", "Quickstart"],
  ["/docs", "Docs"],
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-border border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex shrink-0 items-center gap-2">
          <a aria-label="splitch home" href="/">
            <BrandMark />
          </a>
          <Badge variant="outline">Alpha</Badge>
        </div>

        <nav aria-label="Primary" className="hidden items-center gap-6 text-sm md:flex">
          {links.map(([href, label]) => (
            <a
              className="font-medium text-muted-foreground hover:text-foreground"
              href={href}
              key={href}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            className="hidden font-medium text-muted-foreground text-sm hover:text-foreground sm:inline-flex"
            href="https://app.splitch.dev"
          >
            Sign in
          </a>
          <ThemeToggle />
          <Button className="hidden sm:inline-flex" render={<a href="/quickstart" />}>
            Set up a feature flag
          </Button>

          <Sheet>
            <SheetTrigger
              render={
                <Button aria-label="Open menu" className="md:hidden" size="icon" variant="ghost" />
              }
            >
              <MenuIcon />
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <BrandMark />
                  <Badge variant="outline">Alpha</Badge>
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="Mobile" className="grid gap-1 px-4">
                {links.map(([href, label]) => (
                  <a
                    className="rounded-md px-2 py-2 font-medium text-base text-foreground hover:bg-muted"
                    href={href}
                    key={href}
                  >
                    {label}
                  </a>
                ))}
                <a
                  className="rounded-md px-2 py-2 font-medium text-base text-foreground hover:bg-muted"
                  href="https://app.splitch.dev"
                >
                  Sign in
                </a>
                <Button className="mt-3" render={<a href="/quickstart" />}>
                  Set up a feature flag
                </Button>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
