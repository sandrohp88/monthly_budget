"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/* FINANCE_OS button: rectangular, uppercase, letter-spaced, monospace.
   Variants:
     - default  : ghost-ish dark chrome with mint hover border
     - primary  : mint background, deep-bg foreground (the "go" CTA)
     - outline  : same as default (kept for API parity)
     - ghost    : transparent until hover
     - destructive : red foreground, red border
     - secondary : darker chrome, used inside drawers/footers
     - link     : underlined mint
*/
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-mono text-[10px] font-medium uppercase tracking-[0.12em] " +
    "ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
    "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-2)] text-[var(--text-1)] border border-[var(--border-2)] hover:border-[var(--mint-dim)] hover:text-[var(--text-0)]",
        primary:
          "bg-[var(--mint)] text-[var(--bg-0)] border border-[var(--mint)] font-bold tracking-[0.15em] " +
            "hover:bg-[var(--mint-bright)] hover:shadow-[0_0_16px_var(--mint-glow)]",
        outline:
          "bg-[var(--bg-2)] text-[var(--text-1)] border border-[var(--border-2)] hover:border-[var(--mint-dim)] hover:text-[var(--text-0)]",
        ghost:
          "bg-transparent text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)] border border-transparent",
        destructive:
          "bg-transparent text-[var(--red)] border border-[rgba(239,68,68,0.3)] hover:bg-[var(--red-glow)]",
        secondary:
          "bg-[var(--bg-3)] text-[var(--text-1)] border border-[var(--border-2)] hover:border-[var(--mint-dim)]",
        link:
          "text-[var(--mint)] underline-offset-4 hover:underline border-none bg-transparent normal-case tracking-normal",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-7 px-3 text-[9px]",
        lg: "h-10 px-6",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
