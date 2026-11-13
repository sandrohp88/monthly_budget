import * as React from "react";
import { cn } from "@/lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-[var(--control-border)] bg-[var(--bg-1)] px-3 py-2 " +
          "text-[13px] text-[var(--text-0)] placeholder:text-[var(--text-3)] " +
          "hover:border-[var(--text-2)] " +
          "focus:outline-none focus:border-[var(--focus-ring)] focus:shadow-[0_0_0_1px_var(--focus-ring),0_0_0_4px_var(--mint-glow)] " +
          "disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
