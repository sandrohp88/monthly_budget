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
    <div className={cn("mb-7", className)}>
      {module ? (
        <div className="mb-2 text-[12px] font-medium text-[var(--text-3)]">
          {module}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="mb-2 text-[34px] font-extrabold leading-tight tracking-normal text-[var(--text-0)] md:text-[40px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="max-w-3xl text-[14px] leading-relaxed text-[var(--text-2)]">{subtitle}</p>
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
