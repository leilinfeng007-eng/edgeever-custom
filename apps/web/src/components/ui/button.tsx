import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const ButtonTooltip = React.lazy(() =>
  import("./button-tooltip").then((module) => ({ default: module.ButtonTooltip }))
);

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        solid: "bg-emerald-600 text-white border border-emerald-600 shadow-[0_1px_2px_rgba(6,78,59,0.18)] hover:bg-emerald-700 hover:border-emerald-700",
        soft: "bg-card text-slate-700 hover:bg-workspace-hover border border-[var(--workspace-divider)]",
        ghost: "bg-transparent text-slate-600 hover:bg-workspace-hover hover:text-slate-900 border-transparent",
        outline: "bg-card text-slate-700 hover:bg-workspace-hover border border-[var(--workspace-divider)]",
        danger: "bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-100",
      },
      size: {
        default: "h-9 px-4 py-2 text-sm",
        sm: "h-8 gap-1.5 px-2.5 text-xs",
        md: "h-9 gap-2 px-3 text-sm",
        icon: "h-8 w-8 p-0",
        "icon-sm": "size-7 p-0",
        "icon-xs": "size-6 p-0",
      },
    },
    defaultVariants: {
      variant: "soft",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, title, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const button = (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );

    if (!title) {
      return button;
    }

    return (
      <React.Suspense fallback={button}>
        <ButtonTooltip title={title}>{button}</ButtonTooltip>
      </React.Suspense>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
