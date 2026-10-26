import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import IconCheck from "~icons/solar/check-circle-linear";
import IconDanger from "~icons/solar/danger-circle-linear";
import IconInfo from "~icons/solar/info-circle-linear";
import IconClose from "~icons/solar/close-circle-linear";
import { enter, useMotionLevel } from "../lib/motion";
import { strings } from "../lib/strings";
import { ToastContext, type ToastTone } from "../lib/toast";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}


const ICON = { success: IconCheck, danger: IconDanger, info: IconInfo } as const;

/** One polite live region for every toast (Section 16); at most 3 visible. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (message: string, tone: ToastTone = "success") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="dash-toasts" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const level = useMotionLevel();
  useGSAP(() => {
    if (ref.current) enter(ref.current, level);
  }, { scope: ref });
  const Icon = ICON[toast.tone];
  return (
    <div ref={ref} className={`dash-toast dash-toast--${toast.tone}`}>
      <span className="dash-toast__icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="dash-toast__text">{toast.message}</span>
      <button type="button" className="dash-toast__close" onClick={onDismiss} aria-label={strings.common.close} title={strings.common.close}>
        <IconClose aria-hidden="true" />
      </button>
    </div>
  );
}
