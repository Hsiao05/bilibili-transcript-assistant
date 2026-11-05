import * as React from "react";

import { cn } from "@/lib/utils";

const Progress = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { value?: number | null }
>(({ className, value, ...props }, ref) => (
  <div
    ref={ref}
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={value ?? undefined}
    className={cn("h-1.5 w-full overflow-hidden rounded-full bg-border", className)}
    {...props}
  >
    <div
      className={cn("h-full rounded-full bg-primary transition-[width] duration-300", value == null && "animate-pulse")}
      style={{ width: value == null ? "35%" : `${Math.max(0, Math.min(100, value))}%` }}
    />
  </div>
));
Progress.displayName = "Progress";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-surface", className)} {...props} />;
}

export { Progress, Skeleton };
