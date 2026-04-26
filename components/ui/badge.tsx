import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/* FINANCE_OS badge: rectangular pill, monospace, uppercase, letter-spaced. */
const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2 py-[2px] text-[9px] font-medium uppercase tracking-[0.12em] font-mono",
  {
    variants: {
      variant: {
        default: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
        secondary: "border-[var(--border-2)] bg-[var(--bg-3)] text-[var(--text-1)]",
        destructive: "border-[rgba(239,68,68,0.3)] bg-[var(--red-glow)] text-[var(--red)]",
        outline: "border-[var(--border-2)] bg-transparent text-[var(--text-2)]",
        success: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
        warning: "border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.1)] text-[var(--amber)]",
        muted: "border-[var(--border-2)] bg-[rgba(107,122,112,0.1)] text-[var(--text-2)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
