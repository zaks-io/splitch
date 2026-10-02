import { type FlagLifecycleClass, flagLifecycleClasses } from "@splitch/contracts";
import { Input } from "@splitch/ui/components/input";
import type { LifecycleDraft } from "#lib/flags/create-flag-lifecycle";

/**
 * The lifecycle fields of the Create Flag form (D9). Presentational only; the
 * rule that release and experiment Flags need an owner and an expiry lives in
 * the shared contract and is applied by `draftIssues`.
 */
export function FlagLifecycleFields({
  errors,
  onChange,
  value,
}: {
  errors: { lifecycleClass?: string; owner?: string; expiresAt?: string };
  onChange: (patch: Partial<LifecycleDraft>) => void;
  value: LifecycleDraft;
}) {
  return (
    <>
      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="flag-lifecycle-class">
          Lifecycle class
        </label>
        <select
          aria-invalid={Boolean(errors.lifecycleClass)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          id="flag-lifecycle-class"
          onChange={(event) =>
            onChange({ lifecycleClass: event.target.value as FlagLifecycleClass | "" })
          }
          value={value.lifecycleClass}
        >
          <option value="">Choose a class</option>
          {flagLifecycleClasses.map((lifecycleClass) => (
            <option key={lifecycleClass} value={lifecycleClass}>
              {lifecycleClass}
            </option>
          ))}
        </select>
        <FieldHint
          error={errors.lifecycleClass}
          help="Release and experiment Flags are temporary. Ops and permission Flags may be permanent."
          id="flag-lifecycle-class"
        />
      </div>
      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="flag-owner">
          Owner
        </label>
        <Input
          aria-invalid={Boolean(errors.owner)}
          autoComplete="off"
          id="flag-owner"
          name="owner"
          onChange={(event) => onChange({ owner: event.target.value })}
          placeholder="checkout-team"
          value={value.owner}
        />
        <FieldHint
          error={errors.owner}
          help="Who removes this Flag when it is done."
          id="flag-owner"
        />
      </div>
      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor="flag-expires-on">
          Expires on
        </label>
        <Input
          aria-invalid={Boolean(errors.expiresAt)}
          id="flag-expires-on"
          name="expiresOn"
          onChange={(event) => onChange({ expiresOn: event.target.value })}
          type="date"
          value={value.expiresOn}
        />
        <FieldHint
          error={errors.expiresAt}
          help="The Flag is listed as expired from 00:00 UTC on this date."
          id="flag-expires-on"
        />
      </div>
    </>
  );
}

function FieldHint({ error, help, id }: { error?: string; help: string; id: string }) {
  return (
    <p
      className={error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
      id={`${id}-${error ? "error" : "help"}`}
    >
      {error ?? help}
    </p>
  );
}
