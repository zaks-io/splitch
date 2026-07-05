import { Skeleton } from "#components/skeleton";
import { cn } from "#lib/utils";

const lineKeys = ["line-1", "line-2", "line-3", "line-4"] as const;

type TextSkeletonProps = {
  className?: string;
  lines?: 1 | 2 | 3 | 4;
};

function TextSkeleton({ className, lines = 3 }: TextSkeletonProps) {
  return (
    <div className={cn("grid gap-2", className)} data-slot="text-skeleton">
      {lineKeys.slice(0, lines).map((key, index) => (
        <Skeleton className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")} key={key} />
      ))}
    </div>
  );
}

export { TextSkeleton };
