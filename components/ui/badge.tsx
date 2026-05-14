import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-normal",
  {
    variants: {
      variant: {
        default: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
        secondary: "border-[var(--border-2)] bg-[var(--bg-3)] text-[var(--text-1)]",
        destructive:
          "border-[color-mix(in_oklch,var(--red)_30%,transparent)] bg-[var(--red-glow)] text-[var(--red)]",
        outline: "border-[var(--border-2)] bg-transparent text-[var(--text-2)]",
        success: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
        warning:
          "border-[color-mix(in_oklch,var(--amber)_30%,transparent)] bg-[color-mix(in_oklch,var(--amber)_10%,transparent)] text-[var(--amber)]",
        muted:
          "border-[var(--border-2)] bg-[color-mix(in_oklch,var(--text-2)_10%,transparent)] text-[var(--text-2)]",
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
