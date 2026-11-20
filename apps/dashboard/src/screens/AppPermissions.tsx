import { useRef, useState } from "react";
import { Button, Switch } from "@rulebox/ui";
import { useSetAppPermissions } from "../data";
import { NEW_WEB_APP_PERMISSIONS, WEB_PERMISSION_KEYS, type AppDetail, type WebPermissions } from "../data/types";
import { Card } from "../components/Card";
import { FormError } from "../components/FormError";
import { InlineNotice } from "../components/Notice";
import { formatCount } from "../lib/format";
import { appEditStrings } from "../lib/screenStrings/appEdit";
import { appBrowserStrings } from "../lib/screenStrings/appBrowser";
import { isBrowserBlocked } from "../lib/apps/browserRules";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";

const s = appEditStrings;

const isKind = (kind: string): kind is keyof WebPermissions => (WEB_PERMISSION_KEYS as readonly string[]).includes(kind);

/**
 * The permissions of a website (plan 4.13, PRD 24.1): eight switches with the default beside each, saved on
 * their own with `apps:setPermissions` (`expectedRevision`), and "Blocked in the last 30 days" with an Allow
 * shortcut per kind. The counts come with `apps:get` (`denials30d`): a count per kind, never a page, a time or an
 * employee. "Allow" only flips the switch below and highlights it; nothing is saved until Save is pressed.
 */
export function AppPermissions({
  d,
  revision,
  readOnly,
  onSaved,
  onReload,
}: {
  d: AppDetail;
  revision: number;
  readOnly: boolean;
  onSaved: (revision: number) => void;
  onReload: () => void;
}) {
  const saved = d.web!.permissions;
  // Phase 6 Step 16: in a Chrome or Edge window some permissions do nothing (plan 4.9.3): they are shown off, with the reason, and cannot be changed.
  const browser = d.web!.browser?.kind === "edge" || d.web!.browser?.kind === "chrome" ? d.web!.browser.kind : null;
  const fixedOff = (key: keyof WebPermissions): boolean => browser !== null && isBrowserBlocked(key);
  const setPermissions = useSetAppPermissions();
  const toast = useToast();
  const list = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState<WebPermissions>(saved);
  const [highlight, setHighlight] = useState<keyof WebPermissions | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = WEB_PERMISSION_KEYS.some((k) => draft[k] !== saved[k]);

  function toggle(key: keyof WebPermissions, on: boolean) {
    setDraft((p) => ({ ...p, [key]: on }));
    setHighlight(null);
  }

  function allow(key: keyof WebPermissions) {
    setDraft((p) => ({ ...p, [key]: true }));
    setHighlight(key);
    // Bring the switch into view and put the keyboard on it (no animation: the browser's own instant scroll).
    const row = list.current?.querySelector<HTMLElement>(`[data-perm="${key}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
    row?.querySelector<HTMLElement>("button")?.focus();
  }

  async function save() {
    setPending(true);
    setError(null);
    try {
      const r = await setPermissions({ appId: d._id, expectedRevision: revision, permissions: draft });
      onSaved(r.revision);
      setHighlight(null);
      toast(s.permissionsSaved);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card title={s.permissions} sub={s.permissionsSub}>
        <div className="dash-form">
          {readOnly ? <InlineNotice tone="neutral" title={s.permissionsReadOnly} /> : null}
          {browser !== null ? <InlineNotice tone="neutral" title={appBrowserStrings.permissionsBrowserNote(appBrowserStrings.kinds[browser])} /> : null}
          <ul className="dash-perm" ref={list} aria-label={s.permissions}>
            {WEB_PERMISSION_KEYS.map((key) => (
              <li key={key} className="dash-perm__row" data-perm={key} data-highlight={highlight === key || undefined}>
                <span className="dash-cell-stack">
                  <Switch checked={fixedOff(key) ? false : draft[key]} onChange={(on) => toggle(key, on)} label={s.permissionNames[key]} disabled={readOnly || pending || fixedOff(key)} />
                  <span className="dash-cell-sub">{fixedOff(key) && isBrowserBlocked(key) ? appBrowserStrings.forcedOff[key] : s.permissionHints[key]}</span>
                </span>
                <span className="dash-perm__default">{s.permissionDefault(NEW_WEB_APP_PERMISSIONS[key])}</span>
              </li>
            ))}
          </ul>
          <p className="dash-muted">{s.printingNote}</p>
          {!readOnly ? (
            <>
              <FormError error={error} onReload={onReload} />
              <div className="dash-form__actions">
                <Button onClick={() => void save()} disabled={!dirty || pending} aria-busy={pending}>
                  {pending ? strings.common.saving : s.permissionsSave}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!dirty || pending}
                  onClick={() => {
                    setDraft(saved);
                    setHighlight(null);
                  }}
                >
                  {s.permissionsReset}
                </Button>
                {dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
              </div>
            </>
          ) : null}
        </div>
      </Card>

      <Card title={s.blocked30} sub={s.blocked30Sub}>
        {d.denials30d.length === 0 ? (
          <p className="dash-muted">{s.blocked30None}</p>
        ) : (
          <ul className="dash-perm__counts">
            {d.denials30d.map(({ kind, count }) => {
              const known = isKind(kind);
              const name = known ? s.permissionNames[kind] : kind;
              return (
                <li key={kind} className="dash-perm__count">
                  <span>
                    <strong>{name}</strong> <span className="dash-perm__num dash-muted">{s.blockedCount(formatCount(count))}</span>
                  </span>
                  {known && !readOnly && !fixedOff(kind) ? (
                    saved[kind] ? null : draft[kind] ? (
                      <span className="dash-muted">{s.allowKindDone}</span>
                    ) : (
                      <Button variant="ghost" className="dash-btn--sm" onClick={() => allow(kind)}>
                        {s.allowKind(name)}
                      </Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
