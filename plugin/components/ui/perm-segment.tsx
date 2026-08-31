/* shadcn/ui-derived */
import * as React from "react";

import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

/**
 * The three states a guest can hold on a thread: no access, read, or write.
 * "off" is the absence of a share; "read" and "write" are the two permission
 * words the owner chose.
 */
export type PermValue = "off" | "read" | "write";

const CELLS: readonly { value: PermValue; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

export interface PermSegmentProps {
  /** The currently selected cell. This is a controlled component. */
  value: PermValue;
  /** Called with the next value when the owner picks a different cell. */
  onChange: (value: PermValue) => void;
  disabled?: boolean;
  /** Labels the radiogroup for assistive tech. Defaults to "Permission". */
  "aria-label"?: string;
  className?: string;
}

/**
 * A three-cell segmented control for a guest's permission on one thread:
 * off / read / write. Controlled — it makes no calls of its own and reports
 * every change through `onChange`. Mirrors the inline radiogroup idiom in
 * share-popover.tsx, extended into a reusable primitive with keyboard support.
 */
const PermSegment = React.forwardRef<HTMLDivElement, PermSegmentProps>(
  (
    { value, onChange, disabled = false, "aria-label": ariaLabel, className },
    ref,
  ) => {
    /** Report a change, but never re-fire for the already-selected cell —
     * consumers wire onChange straight to network mutations, so a redundant
     * fire is a redundant RPC. */
    const select = (next: PermValue) => {
      if (next !== value) onChange(next);
    };

    // Arrow-key navigation with roving focus (WAI-ARIA APG radiogroup): move
    // DOM focus onto the target cell straight away, then report the change.
    // `current` is the focused cell that received the event.
    const move = (dir: 1 | -1, current: HTMLButtonElement) => {
      const index = CELLS.findIndex((cell) => cell.value === value);
      const nextIndex = (index + dir + CELLS.length) % CELLS.length;
      const cells =
        current.parentElement?.querySelectorAll<HTMLButtonElement>(
          '[role="radio"]',
        );
      cells?.[nextIndex]?.focus();
      select(CELLS[nextIndex].value);
    };

    return (
      <div
        ref={ref}
        role="radiogroup"
        aria-label={ariaLabel ?? "Permission"}
        className={cn(
          "inline-flex items-center rounded-md border border-input p-0.5",
          disabled && "pointer-events-none opacity-50",
          className,
        )}
      >
        {CELLS.map((cell) => {
          const selected = cell.value === value;
          return (
            <button
              key={cell.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(cell.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1, event.currentTarget);
                } else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  move(-1, event.currentTarget);
                }
              }}
              className={cn(
                `h-6 rounded-sm px-2 text-xs ${CONTROL_HOVER_TRANSITION}`,
                selected
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
            >
              {cell.label}
            </button>
          );
        })}
      </div>
    );
  },
);
PermSegment.displayName = "PermSegment";

export { PermSegment };
