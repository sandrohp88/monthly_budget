import * as React from "react";
import { cn } from "@/lib/cn";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-[10px] border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2 " +
          "text-[13px] text-[var(--text-0)] placeholder:text-[var(--text-3)] " +
          "focus:outline-none focus:border-[var(--mint-dim)] focus:shadow-[0_0_0_3px_var(--mint-glow)] " +
          "disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
