import { useRef } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Input } from "@rulebox/ui";
import { useAuthActions } from "../data";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { PasswordInput } from "../components/PasswordInput";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.auth;

/** Invite code + email + new password → Convex Auth sign-up flow with `inviteCode`. */
export default function Join() {
  const navigate = useNavigate();
  const { signUp } = useAuthActions();
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ code: "", email: "", password: "", repeat: "" }, (x) => ({
    code: x.code.trim() ? undefined : strings.validate.required,
    email: v.email(x.email) ?? undefined,
    password: v.memberPassword(x.password) ?? undefined,
    repeat: v.same(x.password, x.repeat, strings.validate.passwordsDiffer) ?? undefined,
  }));

  return (
    <AuthShell title={s.joinTitle} lead={s.joinLead} demoHint={strings.demo.inviteHint}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            await signUp({ inviteCode: x.code.trim(), email: x.email.trim(), password: x.password });
            // The new member sets up two-step sign-in next (Owner/Admin) or lands on the overview.
            navigate("/mfa", { replace: true });
          }, form.current);
        }}
      >
        <Field label={s.inviteCode} error={f.errors.code} required>
          {(p) => (
            <Input
              {...p}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className="dash-mono"
              value={f.values.code}
              onChange={(e) => f.set("code", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.email} error={f.errors.email} required>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="off"
              spellCheck={false}
              value={f.values.email}
              onChange={(e) => f.set("email", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.newPassword} hint={s.passwordRules} error={f.errors.password} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />}
        </Field>
        <Field label={s.repeatPassword} error={f.errors.repeat} required>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={f.values.repeat} onChange={(e) => f.set("repeat", e.target.value)} />}
        </Field>
        <FormError error={f.serverError} />
        <Button type="submit" disabled={f.pending} aria-busy={f.pending} className="dash-btn--accent">
          {f.pending ? s.joining : s.join}
        </Button>
        <div className="dash-auth__links">
          <Link className="dash-link" to="/sign-in">
            {s.backToSignIn}
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
