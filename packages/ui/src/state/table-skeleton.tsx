import { Skeleton } from "#components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#components/table";

const rowKeys = ["row-1", "row-2", "row-3"] as const;

function TableSkeleton() {
  return (
    <Table data-slot="table-skeleton">
      <TableHeader>
        <TableRow>
          <TableHead>
            <Skeleton className="h-3 w-20" />
          </TableHead>
          <TableHead>
            <Skeleton className="h-3 w-24" />
          </TableHead>
          <TableHead>
            <Skeleton className="h-3 w-16" />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rowKeys.map((key) => (
          <TableRow key={key}>
            <TableCell>
              <Skeleton className="h-3 w-28" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3 w-16" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export { TableSkeleton };
