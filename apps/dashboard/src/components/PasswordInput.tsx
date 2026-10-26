import { useState, type InputHTMLAttributes } from "react";
import { Input } from "@rulebox/ui";
import IconEye from "~icons/solar/eye-linear";
import IconEyeClosed from "~icons/solar/eye-closed-linear";
import { strings } from "../lib/strings";

/** A password input with a show/hide toggle (the toggle is a real button with a label). */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [show, setShow] = useState(false);
  const label = show ? strings.auth.hidePassword : strings.auth.showPassword;
  return (
    <div className="dash-input-affix">
      <Input {...props} type={show ? "text" : "password"} spellCheck={false} autoCapitalize="off" />
      <button
        type="button"
        className="dash-icon-btn dash-input-affix__btn"
        aria-label={label}
        title={label}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <IconEyeClosed aria-hidden="true" /> : <IconEye aria-hidden="true" />}
      </button>
    </div>
  );
}
