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
        "rounded-card border border-line",
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
        elevated ? "shadow-2xl" : "shadow-sm",
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
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer",
        variant === "primary" && "bg-accent text-bg hover:opacity-90",
        variant === "ghost" && "border border-line bg-panel-soft text-text-muted hover:border-accent hover:text-accent",
        variant === "danger" && "bg-crit text-white hover:opacity-90",
        variant === "dangerGhost" && "border border-crit/30 bg-crit/[0.04] text-crit hover:bg-crit/[0.08]",
        variant === "icon" && "text-text-muted hover:bg-panel-soft hover:text-text",
        size === "sm" && "px-3 py-1 text-caption",
        size === "md" && "px-control-x py-control-y text-body",
        size === "lg" && "px-card py-control-y text-body",
        size === "icon" && "h-8 w-8 p-0 text-heading leading-none",
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
        "w-full rounded-lg border border-line bg-bg px-3 py-2 text-body text-text outline-none transition focus:border-accent disabled:opacity-50",
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
        "w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-body text-text outline-none transition focus:border-accent disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export const Avatar = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & {
    size?: "sm" | "md";
    shape?: "round" | "square";
  }
>(function Avatar({ className, size = "md", shape = "round", ...props }, ref) {
  return (
    <span
      ref={ref}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden border border-line bg-panel font-semibold text-text-muted shadow-sm",
        size === "sm" ? "h-7 w-7 text-micro" : "h-9 w-9 text-caption",
        shape === "round" ? "rounded-full" : "rounded-lg",
        className,
      )}
      {...props}
    />
  );
});
