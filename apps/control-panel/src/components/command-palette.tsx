import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@splitch/ui/components/command";
import type { ControlPlaneOperationResult } from "@splitch/control-plane-sdk";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { CreateFlagDialog } from "#components/create-flag-dialog";
import {
  type PaletteItem,
  paletteActionItems,
  paletteJumpItems,
  paletteScope,
} from "#lib/command-palette-items";
import { loadControlPanelPaletteIndex } from "#lib/control-plane-palette-functions";
import { scopedHref } from "#lib/app-shell-navigation";
import type { ScopeNavigation } from "#lib/loader-context";
import type { PaletteIndex } from "#lib/palette-index";

type IndexState =
  | { kind: "loading" }
  | { kind: "result"; result: ControlPlaneOperationResult<PaletteIndex> }
  | { kind: "transport-error"; message: string }
  | null;

export function CommandPalette({
  app,
  navigation,
  onOpenChange,
  open,
  org,
}: {
  navigation: ScopeNavigation;
  org: { orgId: string; orgSlug: string };
  app?: { appId: string; appSlug: string; env?: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [indexState, setIndexState] = useState<IndexState>(null);
  const scope = paletteScope(navigation, org, app);
  const targetAppId = scope.target?.appId;
  const targetEnvironmentId = scope.target?.environmentId;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || !targetAppId || !targetEnvironmentId) {
      setIndexState(null);
      return;
    }
    let active = true;
    setIndexState({ kind: "loading" });
    void loadControlPanelPaletteIndex({
      data: { appId: targetAppId, environmentId: targetEnvironmentId },
    })
      .then((result) => {
        if (active) setIndexState({ kind: "result", result });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setIndexState({
          kind: "transport-error",
          message:
            cause instanceof Error ? cause.message : "The Control Plane could not be reached",
        });
      });
    return () => {
      active = false;
    };
  }, [open, targetAppId, targetEnvironmentId]);

  const index =
    indexState?.kind === "result" && indexState.result.ok ? indexState.result.data : null;
  const jumpItems = paletteJumpItems(scope, index);
  const staticItems = jumpItems.filter(
    (item) => !item.id.startsWith("flag:") && !item.id.startsWith("experiment:"),
  );
  const flagItems = jumpItems.filter((item) => item.id.startsWith("flag:"));
  const experimentItems = jumpItems.filter((item) => item.id.startsWith("experiment:"));
  const actionItems = paletteActionItems(scope);

  function selectItem(item: PaletteItem) {
    if (item.id === "action:new-flag") {
      onOpenChange(false);
      queueMicrotask(() => setCreateOpen(true));
      return;
    }
    if (!item.href) throw new Error(`Command palette item ${item.id} has no destination`);
    onOpenChange(false);
    void router.navigate({ href: item.href });
  }

  return (
    <>
      <CommandDialog
        description="Jump to an App, Environment, Flag, or Experiment, or run an action"
        onOpenChange={onOpenChange}
        open={open}
        title="Command palette"
      >
        <Command data-command-palette>
          <CommandInput placeholder="Search or jump to" />
          <CommandList>
            <CommandEmpty>No matching destinations</CommandEmpty>
            <CommandGroup heading="Jump to">
              {staticItems.map((item) => (
                <PaletteCommandItem item={item} key={item.id} onSelect={selectItem} />
              ))}
              {indexState?.kind === "loading" ? (
                <StatusItem id="status:loading">Loading Flags and Experiments</StatusItem>
              ) : null}
              {indexState?.kind === "result" && !indexState.result.ok ? (
                <StatusItem id="status:unavailable">
                  Flags and Experiments unavailable: {indexState.result.error.message}
                </StatusItem>
              ) : null}
              {indexState?.kind === "transport-error" ? (
                <StatusItem id="status:unavailable">
                  Flags and Experiments unavailable: {indexState.message}
                </StatusItem>
              ) : null}
              {flagItems.map((item) => (
                <PaletteCommandItem item={item} key={item.id} onSelect={selectItem} />
              ))}
              {index?.flagsTruncated ? (
                <StatusItem id="status:flags-truncated">
                  Flag list truncated; open Flags to see every key
                </StatusItem>
              ) : null}
              {experimentItems.map((item) => (
                <PaletteCommandItem item={item} key={item.id} onSelect={selectItem} />
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              {actionItems.map((item) => (
                <PaletteCommandItem item={item} key={item.id} onSelect={selectItem} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      {scope.target ? (
        <CreateFlagDialog
          appId={scope.target.appId}
          environmentId={scope.target.environmentId}
          onOpenChange={setCreateOpen}
          open={createOpen}
          settingsHref={scopedHref(
            { orgSlug: scope.org.orgSlug, appSlug: scope.target.appSlug, env: scope.target.env },
            "settings",
          )}
          trigger={null}
        />
      ) : null}
    </>
  );
}

function PaletteCommandItem({
  item,
  onSelect,
}: {
  item: PaletteItem;
  onSelect: (item: PaletteItem) => void;
}) {
  return (
    <CommandItem
      data-palette-item={item.id}
      onSelect={() => onSelect(item)}
      value={`${item.label} ${item.keywords.join(" ")}`}
    >
      {item.label}
    </CommandItem>
  );
}

function StatusItem({ children, id }: { children: ReactNode; id: string }) {
  return (
    <CommandItem data-palette-item={id} disabled forceMount value={id}>
      {children}
    </CommandItem>
  );
}
