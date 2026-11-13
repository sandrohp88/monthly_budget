import * as React from "react";
import { cn } from "@/lib/cn";

export function PageHead({
  module,
  title,
  subtitle,
  actions,
  className,
}: {
  module?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 md:mb-7", className)}>
      {module ? (
        <div className="mb-2 text-[12px] font-medium text-[var(--text-3)]">
          {module}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h1 className="mb-1.5 text-[28px] font-extrabold leading-[1.15] tracking-[-0.01em] text-[var(--text-0)] md:mb-2 md:text-[36px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="max-w-3xl text-[13px] leading-relaxed text-[var(--text-2)] md:text-[14px]">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function ModuleTag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[12px] font-medium text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardSubTag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-[11px] font-medium text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
