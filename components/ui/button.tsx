"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-[13px] font-semibold tracking-normal " +
    "ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mint-dim)] " +
    "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-1)] text-[var(--text-1)] border border-[var(--border-raw)] shadow-[var(--shadow-sm)] hover:border-[var(--border-2)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        primary:
          "bg-[var(--mint)] text-[var(--button-primary-fg)] border border-[var(--mint)] shadow-[var(--shadow-sm)] hover:bg-[var(--mint-bright)]",
        outline:
          "bg-transparent text-[var(--text-1)] border border-[var(--border-2)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        ghost:
          "bg-transparent text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)] border border-transparent shadow-none",
        destructive:
          "bg-[var(--red-glow)] text-[var(--red)] border border-[color-mix(in_oklch,var(--red)_25%,transparent)] hover:bg-[color-mix(in_oklch,var(--red)_14%,transparent)]",
        secondary:
          "bg-[var(--bg-2)] text-[var(--text-1)] border border-[var(--border-raw)] hover:bg-[var(--bg-3)]",
        link:
          "text-[var(--mint)] underline-offset-4 hover:underline border-none bg-transparent shadow-none",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-[12px]",
        lg: "h-11 px-6 text-[14px]",
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
