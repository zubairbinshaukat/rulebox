import { useRef, useState } from "react";
import { Link } from "react-router";
import { Button, Input } from "@rulebox/ui";
import { useRedeemReset } from "../data";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { PasswordInput } from "../components/PasswordInput";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.auth;

/** Reset code + email + new password → `account:redeemReset`, then back to sign-in. */
export default function Reset() {
  const redeem = useRedeemReset();
  const [done, setDone] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ code: "", email: "", password: "", repeat: "" }, (x) => ({
    code: x.code.trim() ? undefined : strings.validate.required,
    email: v.email(x.email) ?? undefined,
    password: v.memberPassword(x.password) ?? undefined,
    repeat: v.same(x.password, x.repeat, strings.validate.passwordsDiffer) ?? undefined,
  }));

  if (done) {
    return (
      <AuthShell title={s.resetTitle}>
        <InlineNotice tone="success" title={s.resetDone} />
        <Link className="rb-btn rb-btn--primary dash-btn--accent" to="/sign-in">
          {s.signIn}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={s.resetTitle} lead={s.resetLead} demoHint={strings.demo.inviteHint}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            await redeem({ email: x.email.trim(), code: x.code.trim(), newPassword: x.password });
            setDone(true);
          }, form.current);
        }}
      >
        <Field label={s.resetCode} error={f.errors.code} required>
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
          {f.pending ? s.resetting : s.reset}
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
