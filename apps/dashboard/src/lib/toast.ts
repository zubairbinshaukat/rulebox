import { createContext, useContext } from "react";

export type ToastTone = "success" | "danger" | "info";

export const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);

/** `const toast = useToast(); toast("Saved.")` */
export function useToast() {
  return useContext(ToastContext);
}