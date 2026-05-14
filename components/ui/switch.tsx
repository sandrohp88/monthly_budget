"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/cn";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border " +
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mint-dim)] " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        "data-[state=checked]:bg-[var(--mint-dim)] data-[state=checked]:border-[var(--mint)] " +
        "data-[state=unchecked]:bg-[var(--bg-3)] data-[state=unchecked]:border-[var(--border-2)]",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full transition-transform " +
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-[var(--button-primary-fg)] " +
          "data-[state=unchecked]:translate-x-0.5 data-[state=unchecked]:bg-[var(--text-2)]",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;
