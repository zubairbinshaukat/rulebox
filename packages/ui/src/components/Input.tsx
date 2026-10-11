import type { InputHTMLAttributes } from "react";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: InputProps) {
  return <input className={["rb-input", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}