import type { DeleteConsequence } from "#lib/app-delete-consequences";

/**
 * Exactly what deleting this App destroys, by name.
 *
 * Every id the dry run returned is listed in full. Truncating this would hide
 * the one row an operator needed to see before typing the confirmation, which is
 * the whole reason the dry run runs first.
 */
export function AppDeleteConsequenceList({
  consequences,
  environmentNames,
}: {
  consequences: readonly DeleteConsequence[];
  environmentNames: readonly string[];
}) {
  return (
    <div className="grid gap-3" data-testid="app-delete-consequences">
      <p className="font-medium text-sm">Deleting this App permanently destroys:</p>
      <ul className="grid gap-2 text-sm">
        <li>
          <span className="font-medium">
            {environmentNames.length}{" "}
            {environmentNames.length === 1 ? "Environment" : "Environments"}
          </span>{" "}
          ({environmentNames.join(", ")}) and every SDK credential issued for them. Running SDKs
          stop resolving Flags immediately.
        </li>
        {consequences.map((consequence) => (
          <li key={consequence.childType}>
            <span className="font-medium">
              {consequence.count} {consequence.label}
            </span>
            <span className="mt-1 block break-words font-mono text-muted-foreground text-xs">
              {consequence.ids.join(", ")}
            </span>
          </li>
        ))}
        <li>Everyone's access to this App, including your own.</li>
      </ul>
      <p className="text-sm">This cannot be undone and splitch keeps no copy.</p>
    </div>
  );
}
