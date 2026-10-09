import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@splitch/ui/components/table";
import { quickstartRecoveries } from "../docs/quickstart";

export function QuickstartRecovery() {
  return (
    <section className="grid gap-4">
      <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
        When a step fails
      </h2>
      <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
        If a command fails, read its error code and follow the recovery steps below. Agents can use
        the <span className="font-mono text-foreground">recommendedAction</span> field in a 409
        response to choose the next action.
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
            {quickstartRecoveries.map(([token, meaning, action]) => (
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
