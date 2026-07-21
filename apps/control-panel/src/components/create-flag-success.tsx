import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@splitch/ui/components/dialog";

export function CreateFlagSuccess({ flagKey }: { flagKey: string }) {
  return (
    <div className="grid gap-5" data-testid="create-flag-success">
      <DialogHeader>
        <DialogTitle>Connect your code</DialogTitle>
        <DialogDescription>
          <code>{flagKey}</code> was created with the boolean Variant catalog.
        </DialogDescription>
      </DialogHeader>
      <p className="text-muted-foreground text-sm leading-6">
        Your Flag definition is ready. The guided SDK handoff will continue here.
      </p>
      <DialogFooter showCloseButton />
    </div>
  );
}
