import type { ComponentPropsWithRef } from "react";

/** A native input; `ref` works as for any element (React 19), so a screen can move the focus back to it. */
export type InputProps = ComponentPropsWithRef<"input">;

export function Input({ className, ...rest }: InputProps) {
  return <input className={["rb-input", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}
