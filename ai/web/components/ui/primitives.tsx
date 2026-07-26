import * as React from "react";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    tone?: "panel" | "soft" | "bg";
    padding?: "none" | "sm" | "md" | "lg";
  }
>(function Card({ className, tone = "panel", padding = "md", ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-card border border-line shadow-[var(--shadow-xs)] transition-[border-color,box-shadow]",
        tone === "panel" && "bg-panel",
        tone === "soft" && "bg-panel-soft",
        tone === "bg" && "bg-bg",
        padding === "sm" && "p-3",
        padding === "md" && "p-card",
        padding === "lg" && "p-card-lg",
        className,
      )}
      {...props}
    />
  );
});

type SurfaceProps = {
  as?: "div" | "form";
  elevated?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  className?: string;
} & (React.HTMLAttributes<HTMLDivElement> | React.FormHTMLAttributes<HTMLFormElement>);

export const Surface = React.forwardRef<HTMLElement, SurfaceProps>(function Surface(
  { as: Component = "div", className, elevated = false, padding = "md", ...props },
  ref,
) {
  return (
    <Component
      ref={ref as never}
      className={cn(
        "rounded-panel border border-line bg-panel",
        elevated ? "shadow-[var(--shadow-float)]" : "shadow-[var(--shadow-sm)]",
        padding === "sm" && "p-3",
        padding === "md" && "p-card",
        padding === "lg" && "p-card-lg",
        className,
      )}
      {...(props as object)}
    />
  );
});

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger" | "dangerGhost" | "icon";
    size?: "sm" | "md" | "lg" | "icon";
  }
>(function Button({ className, variant = "ghost", size = "md", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg font-medium shadow-[var(--shadow-xs)] transition-[transform,background-color,border-color,color,box-shadow,opacity] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 md:min-h-0 md:active:scale-100 cursor-pointer",
        variant === "primary" && "bg-accent text-bg hover:bg-accent-strong hover:shadow-[var(--shadow-sm)]",
        variant === "ghost" && "border border-line bg-panel text-text-muted hover:border-line-strong hover:bg-panel-soft hover:text-text",
        variant === "danger" && "bg-crit text-on-crit hover:opacity-90",
        variant === "dangerGhost" && "border border-crit/30 bg-crit/[0.04] text-crit hover:bg-crit/[0.08]",
        variant === "icon" && "text-text-muted hover:bg-panel-soft hover:text-text",
        size === "sm" && "px-3 py-2 text-caption md:py-1",
        size === "md" && "px-control-x py-control-y text-body",
        size === "lg" && "px-card py-control-y text-body",
        size === "icon" && "h-11 w-11 p-0 text-heading leading-none md:h-8 md:w-8",
        className,
      )}
      {...props}
    />
  );
});

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "min-h-11 w-full rounded-lg border border-line bg-panel px-3 py-2 text-body text-text shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] focus:border-accent focus:shadow-[var(--focus-ring)] disabled:opacity-50 md:min-h-0",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-11 w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-body text-text shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] focus:border-accent focus:shadow-[var(--focus-ring)] disabled:opacity-50 md:min-h-0",
        className,
      )}
      {...props}
    />
  );
});

export const Avatar = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & {
    // "lg" is the fixed 42px board-card identity size — it does not shrink on
    // small screens, because the board card rail is 42px on every breakpoint.
    size?: "xs" | "sm" | "md" | "lg";
    shape?: "round" | "square";
  }
>(function Avatar({ className, size = "md", shape = "round", ...props }, ref) {
  return (
    <span
      ref={ref}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden border border-line bg-panel font-semibold text-text-muted shadow-sm",
        size === "xs"
          ? "h-[1.625rem] w-[1.625rem] text-nano"
          : size === "sm"
            ? "h-11 w-11 text-micro md:h-7 md:w-7"
            : size === "lg"
              ? "h-[2.625rem] w-[2.625rem] text-caption"
              : "h-11 w-11 text-caption md:h-9 md:w-9",
        shape === "round" ? "rounded-full" : "rounded-lg",
        className,
      )}
      {...props}
    />
  );
});
