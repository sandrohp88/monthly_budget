import * as React from "react";
import { cn } from "@/lib/cn";

/* Renders the standard page intro:
     // MODULE_xx
     TITLE
     subtitle
   with optional right-aligned actions. */
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
    <div className={cn("mb-6", className)}>
      {module ? (
        <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          {module}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="mb-2 text-[32px] font-extrabold leading-none uppercase tracking-[0.06em] text-[var(--text-0)] sm:text-[36px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="max-w-3xl text-[14px] text-[var(--text-2)]">{subtitle}</p>
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
        "text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]",
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
        "text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
