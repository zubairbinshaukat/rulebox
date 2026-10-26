import { useRef } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Input } from "@rulebox/ui";
import { useAuthActions, useAuthState, useMe } from "../data";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { InlineNotice } from "../components/Notice";
import { PasswordInput } from "../components/PasswordInput";
import { signInMessage } from "../lib/signin";
import { safeNext } from "../lib/next";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.auth;


export default function SignIn() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const expired = params.get("expired") === "1";
  const navigate = useNavigate();
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useAuthState();
  const me = useMe();
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ email: "", password: "" }, (x) => ({
    email: v.email(x.email) ?? undefined,
    password: x.password ? undefined : strings.validate.required,
  }));

  // Already signed in (the server knows the session): go on. A token the
  // server no longer accepts (`me` is null) stays here so it cannot loop.
  if (isAuthenticated && me && !f.pending) return <Navigate to={next} replace />;

  return (
    <AuthShell title={s.signInTitle} lead={s.signInLead} demoHint={strings.demo.credentials}>
      {expired && !f.serverError ? <InlineNotice tone="warning" title={strings.errors.unauthenticated} /> : null}
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            await signIn({ email: x.email.trim(), password: x.password });
            navigate(next, { replace: true });
          }, form.current);
        }}
      >
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
        <Field label={s.password} error={f.errors.password} required>
          {(p) => (
            <PasswordInput {...p} autoComplete="current-password" value={f.values.password} onChange={(e) => f.set("password", e.target.value)} />
          )}
        </Field>
        {f.serverError ? <InlineNotice tone="danger" alert title={signInMessage(f.serverError)} /> : null}
        <Button type="submit" disabled={f.pending} aria-busy={f.pending} className="dash-btn--accent">
          {f.pending ? s.signingIn : s.signIn}
        </Button>
        <div className="dash-auth__links">
          <Link className="dash-link" to="/join">
            {s.haveInvite}
          </Link>
          <Link className="dash-link" to="/reset">
            {s.haveReset}
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
