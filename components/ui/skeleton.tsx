import { cn } from "@/lib/cn";

/** Loading placeholder — a pulsing block. Use to reserve layout while data
 *  streams in so content doesn't pop and shift. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-[var(--bg-3)]", className)}
      aria-hidden="true"
    />
  );
}
