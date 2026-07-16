import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";
import { toneChip } from "@/lib/tones";

// Public variant names are preserved; each maps to a canonical tone (see
// lib/tones.ts) so Badge and StatusPill render identical tones. `outline` is a
// borders-only style that isn't a filled chip, so it stays inline.
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-2xs font-medium tracking-normal",
  {
    variants: {
      variant: {
        default: toneChip.primary,
        secondary: toneChip.neutral,
        destructive: toneChip.danger,
        success: toneChip.success,
        warning: toneChip.warning,
        muted: toneChip.muted,
        outline: "border-[var(--border-2)] bg-transparent text-[var(--text-2)]",
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
