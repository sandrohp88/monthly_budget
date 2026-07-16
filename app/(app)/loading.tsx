import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown in the content area while a route segment streams in (the shell —
 * sidebar, header, tab bar — persists). Reserves the shape of a typical page
 * so navigation doesn't flash blank or shift when data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="mb-7 space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
      <Skeleton className="h-40 rounded-lg" />
    </div>
  );
}
