import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";

const recoveries = [
  [
    "CONFIRMATION_REQUIRED",
    "the Environment Policy gates this change",
    "resend with confirm: true",
  ],
  [
    "VARIANT_NOT_AVAILABLE",
    "the Variant is not promoted to this Environment",
    "flags_promote, then retry",
  ],
  ["RUN_FROZEN", "the edit touches a running Run", "clone into a new draft Run"],
  ["APP_MISMATCH", "wrong key for this App or Environment", "fetch the credential for this Env"],
  [
    "401 / 403",
    "bad or revoked key, or origin not allowed",
    "check the key and its origin allow-list",
  ],
] as const;

export function QuickstartRecovery() {
  return (
    <section className="grid gap-4">
      <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
        When a step fails
      </h2>
      <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
        splitch fails loud, then guides. Every operational 409 carries a machine-stable
        <span className="font-mono text-foreground"> recommendedAction</span> token. Branch on the
        token, not on prose.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>You hit</TableHead>
              <TableHead>It means</TableHead>
              <TableHead>Do</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recoveries.map(([token, meaning, action]) => (
              <TableRow key={token}>
                <TableCell className="font-mono text-xs">{token}</TableCell>
                <TableCell className="text-muted-foreground">{meaning}</TableCell>
                <TableCell>{action}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
