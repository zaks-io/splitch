import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dangerZone = source("../../components/apps/app-danger-zone.tsx");
const ceremony = source("../../components/apps/app-delete-ceremony.tsx");
const serverFunctions = source("./control-plane-app-settings-functions.ts");

describe("partial App deletion read-back", () => {
  it("refreshes App settings and then replaces the dry-run preview", () => {
    const refresh = section(
      dangerZone,
      "  async function refreshAfterPartialDelete() {",
      "\n\n  const blockers",
    );
    const settingsRead = refresh.indexOf("await refreshAppSettings(queryClient");
    const previewRead = refresh.indexOf("await deleteControlPanelApp");

    expect(settingsRead).toBeGreaterThan(-1);
    expect(previewRead).toBeGreaterThan(settingsRead);
    expect(refresh).toContain("dryRun: true");
    expect(refresh).toContain("if (!result.ok) throw");
    expect(refresh).toContain("setPreview(result)");
    expect(dangerZone).toContain("onPartialDelete={refreshAfterPartialDelete}");
  });

  it("reports success only after read-back and requires reload when it fails", () => {
    const partialOutcome = section(
      ceremony,
      '    if (outcome.kind === "partially-deleted") {',
      '\n    if (outcome.kind === "stale")',
    );
    const recovery = section(ceremony, "async function partialDeleteError(", "\n}");

    expect(partialOutcome).toContain(
      "setError(await partialDeleteError(outcome, onPartialDelete))",
    );
    const refreshCall = recovery.indexOf("await refresh()");
    expect(refreshCall).toBeGreaterThan(-1);
    expect(refreshCall).toBeLessThan(recovery.indexOf("This page was refreshed."));
    expect(recovery).toContain("reload: false");
    expect(recovery).toContain("The App may or may not have been deleted");
    expect(recovery).toContain("Reload this page before retrying.");
    expect(recovery).toContain("reload: true");
    expect(ceremony).toContain("error?.reload === true");
    expect(ceremony).toContain("globalThis.location.reload()");
  });

  it("keeps post-boundary cleanup retryable without claiming the App remains", () => {
    expect(ceremony).toContain('if (outcome.kind === "cleanup-pending")');
    expect(ceremony).toContain("The App was deleted, but cleanup did not finish.");
    expect(ceremony).toContain("Retry deletion to finish cleanup.");
  });

  it("resumes post-boundary cleanup with a second forced DELETE before resync", () => {
    const handler = section(
      serverFunctions,
      "export const deleteControlPanelApp",
      "\n\nexport const addControlPanelAppMember",
    );
    const readBack = handler.indexOf("authorized.client.read({ appId: data.appId })");
    const resume = handler.indexOf(
      "authorized.client.deleteApp({ appId: data.appId, force: true })",
    );

    expect(readBack).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(readBack);
    expect(handler).toContain("authorized.resyncSession");
  });
});

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

function section(sourceText: string, start: string, end: string): string {
  const from = sourceText.indexOf(start);
  const to = sourceText.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Could not find invariant section: ${start}`);
  return sourceText.slice(from, to);
}
