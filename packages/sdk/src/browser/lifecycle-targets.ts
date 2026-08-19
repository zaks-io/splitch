/**
 * Resolve page lifecycle targets. Explicit `null` means "absent" — do not fall
 * through to the ambient global (unlike `??`, which treats null as unset).
 */
export function resolveDocument(deps: { readonly document?: Document | null }): Document | null {
  if ("document" in deps) {
    return deps.document ?? null;
  }
  return typeof document !== "undefined" ? document : null;
}

export function resolveWindow(deps: { readonly window?: Window | null }): Window | null {
  if ("window" in deps) {
    return deps.window ?? null;
  }
  return typeof window !== "undefined" ? window : null;
}
