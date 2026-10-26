import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button, Checkbox, Input } from "@rulebox/ui";
import {
  useAuthActions,
  useAuthState,
  useBeginMfaSetup,
  useConfirmMfaSetup,
  useMe,
  useMfaStatus,
  useRedeemRecoveryCode,
  useVerifyMfa,
} from "../data";
import type { MfaSetup } from "../data/types";
import { AuthShell } from "../components/AuthShell";
import { CopyField } from "../components/CopyField";
import { Field } from "../components/Field";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { QrCode } from "../components/QrCode";
import { RegionError } from "../components/Region";
import { SkeletonBlock } from "../components/Skeleton";
import { FullPageSpinner } from "../app/RequireMember";
import { useSessionGuard } from "../app/useSessionGuard";
import { groupChars } from "../lib/format";
import { safeNext, withNext } from "../lib/next";
import { strings } from "../lib/strings";
import { useForm } from "../lib/useForm";
import * as v from "../lib/validate";

const s = strings.mfa;

/** Set up TOTP, or enter a code / recovery code (Step 3 #4, Step 4 #5). */
export default function Mfa() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const auth = useAuthState();
  const me = useMe();
  const status = useMfaStatus();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // While setup is being confirmed the server already marks the session verified;
  // keep the setup screen until the one-time recovery codes arrive.
  const [confirming, setConfirming] = useState(false);
  // `mfa:verify` is an action: its promise can settle before the queries show
  // the verified session, so leave only once `mfa:status` says so.
  const [verifiedHere, setVerifiedHere] = useState(false);
  useSessionGuard(!auth.isLoading && auth.isAuthenticated && me === null, next);

  if (auth.isLoading || me === undefined) return <FullPageSpinner />;
  if (!auth.isAuthenticated) return <Navigate to={withNext("/sign-in", "/mfa")} replace />;
  if (me === null) return <FullPageSpinner />;
  if ("noAccess" in me) return <Navigate to="/" replace />;

  // The recovery codes stay on screen (shown once) until the member confirms.
  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} next={next} />;

  if (status.status === "loading") {
    return (
      <AuthShell title={s.setupTitle}>
        <SkeletonBlock lines={4} />
      </AuthShell>
    );
  }
  if (status.status === "error") {
    return (
      <AuthShell title={s.verifyTitle}>
        <RegionError error={status.error} onRetry={status.retry} />
      </AuthShell>
    );
  }
  const st = status.data;
  if (verifiedHere && st.verified) return <Navigate to={next} replace />;
  if (!confirming && st.enrolled && st.verified) return <Enabled next={next} />;
  if (!confirming && st.enrolled) return <Verify onVerified={() => setVerifiedHere(true)} />;
  return <Setup next={next} optional={!st.required} onConfirming={setConfirming} onCodes={setRecoveryCodes} />;
}

function SignOutLink() {
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  return (
    <button type="button" className="dash-link" onClick={() => void signOut().then(() => navigate("/sign-in", { replace: true }))}>
      {s.signOutInstead}
    </button>
  );
}

function Enabled({ next }: { next: string }) {
  return (
    <AuthShell title={strings.app.security}>
      <InlineNotice tone="success" title={s.enabled} />
      <Link to={next} className="rb-btn rb-btn--primary dash-btn--accent">
        {strings.common.continue}
      </Link>
    </AuthShell>
  );
}

function Verify({ onVerified }: { onVerified: () => void }) {
  const verify = useVerifyMfa();
  const redeem = useRedeemRecoveryCode();
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  // After a success the button stays disabled until the page moves on.
  const [accepted, setAccepted] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ code: "" }, (x) => ({
    code: (mode === "totp" ? v.totpCode(x.code) : v.recoveryCode(x.code)) ?? undefined,
  }));

  return (
    <AuthShell title={s.verifyTitle} lead={mode === "totp" ? s.verifyLead : undefined} demoHint={strings.demo.totpHint}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            if (mode === "totp") await verify({ code: x.code.replace(/\s/g, "") });
            else await redeem({ code: v.normalizeRecoveryCode(x.code) });
            setAccepted(true);
            onVerified();
          }, form.current);
        }}
      >
        <Field label={mode === "totp" ? s.code : s.recoveryCode} error={f.errors.code} required>
          {(p) => (
            <Input
              {...p}
              key={mode}
              autoFocus
              className="dash-mono"
              autoComplete="one-time-code"
              inputMode={mode === "totp" ? "numeric" : "text"}
              autoCapitalize={mode === "totp" ? "off" : "characters"}
              maxLength={mode === "totp" ? 7 : 12}
              spellCheck={false}
              value={f.values.code}
              onChange={(e) => f.set("code", e.target.value)}
              style={{ letterSpacing: "0.2em", fontSize: 18 }}
            />
          )}
        </Field>
        <FormError error={f.serverError} />
        <Button type="submit" disabled={f.pending || accepted} aria-busy={f.pending || accepted} className="dash-btn--accent">
          {f.pending || accepted ? s.confirming : s.verify}
        </Button>
        <div className="dash-auth__links">
          <button
            type="button"
            className="dash-link"
            onClick={() => {
              setAccepted(false);
              setMode((m) => (m === "totp" ? "recovery" : "totp"));
              f.reset({ code: "" });
            }}
          >
            {mode === "totp" ? s.useRecovery : s.useTotp}
          </button>
          <SignOutLink />
        </div>
      </form>
    </AuthShell>
  );
}

function Setup({
  next,
  optional,
  onConfirming,
  onCodes,
}: {
  next: string;
  optional: boolean;
  onConfirming: (v: boolean) => void;
  onCodes: (codes: string[]) => void;
}) {
  const begin = useBeginMfaSetup();
  const confirm = useConfirmMfaSetup();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [setupError, setSetupError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const f = useForm({ code: "" }, (x) => ({ code: v.totpCode(x.code) ?? undefined }));

  // `beginSetup` stores a new pending secret on every call, so it must run
  // exactly once per attempt: a second call (React StrictMode runs effects
  // twice in development) would replace the secret this screen shows.
  const mounted = useRef(true);
  const startedFor = useRef(-1);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (startedFor.current === attempt) return;
    startedFor.current = attempt;
    begin().then(
      (r) => {
        if (mounted.current) setSetup(r);
      },
      (e: unknown) => {
        if (mounted.current) setSetupError(e);
      },
    );
  }, [begin, attempt]);

  return (
    <AuthShell title={s.setupTitle} lead={optional ? s.notRequired : s.setupLead} wide demoHint={strings.demo.totpHint}>
      {setupError ? (
        <RegionError
          error={setupError}
          onRetry={() => {
            setSetupError(null);
            setAttempt((a) => a + 1);
          }}
        />
      ) : !setup ? (
        <div aria-busy="true">
          <p className="dash-muted">{s.loadingSetup}</p>
          <SkeletonBlock lines={4} />
        </div>
      ) : (
        <ol className="dash-steps">
          <li>
            <div className="dash-steps__body">
              <p>{s.step1}</p>
              <QrCode value={setup.uri} label={s.qrAlt} />
              <p className="dash-muted">{s.manual}</p>
              <span className="dash-secret" aria-label={setup.secret.split("").join(" ")}>
                {groupChars(setup.secret)}
              </span>
            </div>
          </li>
          <li>
            <form
              ref={form}
              className="dash-steps__body"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void f.submit(async (x) => {
                  onConfirming(true);
                  try {
                    onCodes(await confirm({ code: x.code.replace(/\s/g, "") }));
                  } finally {
                    onConfirming(false);
                  }
                }, form.current);
              }}
            >
              <p>{s.step2}</p>
              <Field label={s.code} error={f.errors.code} required>
                {(p) => (
                  <Input
                    {...p}
                    className="dash-mono"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={7}
                    spellCheck={false}
                    value={f.values.code}
                    onChange={(e) => f.set("code", e.target.value)}
                    style={{ letterSpacing: "0.2em", fontSize: 18, maxWidth: 220 }}
                  />
                )}
              </Field>
              <FormError error={f.serverError} />
              <div className="dash-form__actions">
                <Button type="submit" disabled={f.pending} aria-busy={f.pending} className="dash-btn--accent">
                  {f.pending ? s.confirming : s.confirm}
                </Button>
                {optional ? (
                  <Link to={next} className="rb-btn rb-btn--ghost">
                    {s.skip}
                  </Link>
                ) : null}
              </div>
            </form>
          </li>
        </ol>
      )}
      <div className="dash-auth__links">
        <SignOutLink />
      </div>
    </AuthShell>
  );
}

function RecoveryCodes({ codes, next }: { codes: string[]; next: string }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  return (
    <AuthShell title={s.recoveryTitle} lead={s.recoveryLead} wide>
      <ul className="dash-codes" aria-label={s.recoveryTitle}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <CopyField value={codes.join("\n")} label={s.copyAll} multiline />
      <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} label={s.savedConfirm} />
      <Button className="dash-btn--accent" disabled={!saved} onClick={() => navigate(next, { replace: true })}>
        {s.saved}
      </Button>
    </AuthShell>
  );
}
