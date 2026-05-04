import * as React from "react";
import { cn } from "@/lib/cn";

/* FINANCE_OS card: tokenized panel surface, 1px border.
   Header is a single horizontal row with optional tag/title/meta on the
   left and arbitrary actions on the right. */

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-sm border border-[var(--border-raw)] bg-[var(--bg-card)] text-[var(--text-0)]",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-raw)] px-5 py-4",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--text-0)]",
        className,
      )}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("text-[12px] text-[var(--text-2)]", className)}
      {...props}
    />
  ),
);
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-5", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-2 border-t border-[var(--border-raw)] px-5 py-4",
        className,
      )}
      {...props}
    />
  ),
);
CardFooter.displayName = "CardFooter";

/* Optional tag that pairs with CardTitle to show a "// SUBSYS_XX" label. */
export function CardTag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
