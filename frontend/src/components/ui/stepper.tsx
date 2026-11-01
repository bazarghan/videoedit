import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

const chipClassName = cn(
  "flex h-[30px] items-center gap-1.5 rounded-[4px] border px-1.5 text-[14px] leading-none",
);

const badgeClassName = cn(
  "flex size-[18px] shrink-0 items-center justify-center rounded-[3px] text-[12px] font-medium",
);

const chipStatusClassName = {
  complete: "border-success/40 bg-success/10 text-success",
  current: "border-primary/40 bg-primary/10 text-primary",
  upcoming: "border-border text-text-tertiary",
} as const;

const badgeStatusClassName = {
  complete: "bg-success text-white",
  current: "bg-primary text-primary-foreground",
  upcoming: "bg-elevation-4 text-text-tertiary",
} as const;

export type StepperStatus = keyof typeof chipStatusClassName;

export type StepperProps = ComponentProps<"ol"> & {
  steps: string[];
  current: number;
};

export function Stepper({ steps, current, className, ...props }: StepperProps) {
  return (
    <ol
      className={cn("flex flex-wrap items-center gap-3 sm:gap-6", className)}
      {...props}
    >
      {steps.map((label, index) => {
        const status: StepperStatus =
          index < current
            ? "complete"
            : index === current
              ? "current"
              : "upcoming";

        return (
          <li
            key={`${index}-${label}`}
            data-status={status}
            aria-current={status === "current" ? "step" : undefined}
            className={cn(chipClassName, chipStatusClassName[status])}
          >
            <span className={cn(badgeClassName, badgeStatusClassName[status])}>
              <span className="translate-y-px">{index + 1}</span>
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
