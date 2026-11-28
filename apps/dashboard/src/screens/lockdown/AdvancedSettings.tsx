import { lazy, Suspense } from "react";
import { Pill } from "@rulebox/ui";
import { SkeletonBlock } from "../../components/Skeleton";
import type { AdvancedBodyProps } from "./AdvancedBody";
import { lockdownStrings as s } from "./strings";

// The rows are most of this page's code and most visits never open them: they load when Advanced opens.
const Body = lazy(() => import("./AdvancedBody"));

export interface AdvancedProps extends AdvancedBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many settings differ from the nearest protection level (a pill in the summary). */
  changedCount: number;
  className?: string;
}

/**
 * "Advanced settings": every individual setting, closed by default (it opens by itself on an error, on "Show changes" and on "Set per
 * check"). Nothing is rendered or downloaded while it is closed.
 */
export function AdvancedSettings({ open, onOpenChange, changedCount, className, ...body }: AdvancedProps) {
  return (
    <div className={["dash-card", "lk-advcard", className ?? ""].filter(Boolean).join(" ")}>
      <details className="dash-advanced lk-adv" open={open}>
        {/* The summary is a button: the open state lives in the page (it opens itself), so a click toggles that, not the browser's own state. */}
        <summary
          onClick={(e) => {
            e.preventDefault();
            onOpenChange(!open);
          }}
        >
          <span className="lk-adv__title">{s.advanced}</span>
          {changedCount > 0 ? (
            <Pill tone="accent" className="lk-adv__count">
              {s.changedCount(changedCount)}
            </Pill>
          ) : null}
        </summary>
        {open ? (
          <Suspense fallback={<SkeletonBlock lines={5} />}>
            <Body {...body} />
          </Suspense>
        ) : null}
      </details>
    </div>
  );
}
