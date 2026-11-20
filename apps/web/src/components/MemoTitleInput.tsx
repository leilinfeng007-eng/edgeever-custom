import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type MemoTitleInputProps = {
  ariaLabel?: string;
  className?: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  readOnly?: boolean;
  value: string;
} & Omit<ComponentPropsWithoutRef<"input">, "onChange" | "value">;

export const MemoTitleInput = forwardRef<HTMLInputElement, MemoTitleInputProps>(({
  ariaLabel,
  className,
  onValueChange,
  placeholder,
  readOnly = false,
  value,
  ...props
}, ref) => {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let disposed = false;
    const measure = () => {
      if (!disposed) setTruncated(input.scrollWidth > input.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(input);
    document.fonts.ready.then(measure);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [value, className]);

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <input
            {...props}
            ref={inputRef}
            aria-label={ariaLabel ?? placeholder}
            className={cn(
              "block w-full min-w-0 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-[17px] font-semibold leading-tight tracking-[-0.015em] text-slate-900 outline-none transition placeholder:text-slate-300 hover:bg-emerald-50/50 focus-visible:border-emerald-500/30 focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-emerald-500/15 read-only:text-slate-600 read-only:hover:bg-transparent read-only:focus-visible:bg-transparent read-only:focus-visible:ring-0 sm:text-[18px]",
              className
            )}
            maxLength={160}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={placeholder}
            readOnly={readOnly}
            value={value}
          />
        </TooltipTrigger>
        {truncated && value && (
          <TooltipContent side="bottom" className="max-w-[min(32rem,calc(100vw-2rem))] break-words">
            {value}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
});

MemoTitleInput.displayName = "MemoTitleInput";
