import { useRef, useState } from "react";
import { Button, Input, Pill } from "@rulebox/ui";
import IconDownload from "~icons/solar/download-minimalistic-linear";
import { useRelease, useSetRelease } from "../../data/release";
import type { ReleaseInfo, ReleaseScreen } from "../../data/release/api";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { FormError } from "../../components/FormError";
import { InlineNotice } from "../../components/Notice";
import { QueryRegion } from "../../components/Region";
import { SkeletonBlock } from "../../components/Skeleton";
import { serverFieldError } from "../../components/serverField";
import { formatBytes } from "../../lib/format";
import { useCan } from "../../lib/member";
import { useToast } from "../../lib/toast";
import { strings } from "../../lib/strings";
import { useForm } from "../../lib/useForm";
import {
  fieldsOf,
  releaseOf,
  releaseSizeProblem,
  releaseUrlProblem,
  sameRelease,
  sha256Problem,
  versionProblem,
  type ReleaseFields,
} from "./releaseRules";
import { updates as s } from "./strings";

const FIELDS = ["release.version", "release.url", "release.sha256", "release.sizeBytes"] as const;

const VERSION_TEXT = { empty: s.problems.versionEmpty, length: s.problems.versionLength, not_ordered: s.problems.versionNotOrdered };
const URL_TEXT = { empty: s.problems.urlEmpty, length: s.problems.urlLength, https: s.problems.urlHttps };
const SHA_TEXT = { empty: s.problems.shaEmpty, format: s.problems.shaFormat };
const SIZE_TEXT = { empty: s.problems.sizeEmpty, number: s.problems.sizeNumber, range: s.problems.sizeRange };

/** The sentence under each field, or nothing when the field is fine. */
function problemsOf(f: ReleaseFields): Partial<Record<keyof ReleaseFields, string>> {
  const version = versionProblem(f.version);
  const url = releaseUrlProblem(f.url);
  const sha = sha256Problem(f.sha256);
  const size = releaseSizeProblem(f.size);
  return {
    version: version ? VERSION_TEXT[version] : undefined,
    url: url ? URL_TEXT[url] : undefined,
    sha256: sha ? SHA_TEXT[sha] : undefined,
    size: size ? SIZE_TEXT[size] : undefined,
  };
}

/** Settings → Updates: `ruleboxRelease:get`; setting or clearing the release is an Owner action with a fresh step-up. */
export default function UpdatesTab() {
  const release = useRelease();
  const [formKey, setFormKey] = useState(0);
  return (
    <QueryRegion state={release} skeleton={<div className="dash-card dash-card--pad"><SkeletonBlock lines={6} /></div>}>
      {(data) => <Updates data={data} formKey={formKey} onReload={() => setFormKey((k) => k + 1)} />}
    </QueryRegion>
  );
}

function Updates({ data, formKey, onReload }: { data: ReleaseScreen; formKey: number; onReload: () => void }) {
  const isOwner = useCan("owner");
  return (
    <>
      <CurrentCard data={data} isOwner={isOwner} />
      {isOwner ? <ReleaseForm key={formKey} data={data} onReload={onReload} /> : <InlineNotice tone="neutral" title={s.ownerOnly} />}
    </>
  );
}

function CurrentCard({ data, isOwner }: { data: ReleaseScreen; isOwner: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const set = useSetRelease();
  const toast = useToast();
  const r = data.release;
  return (
    <Card
      title={s.currentTitle}
      sub={s.lead}
      actions={
        isOwner && r !== null ? (
          <Button variant="danger-ghost" className="dash-btn--sm" onClick={() => setConfirm(true)}>
            {s.stop}
          </Button>
        ) : undefined
      }
    >
      {r === null ? (
        <EmptyState compact icon={<IconDownload />} title={s.noneTitle} body={s.noneBody} />
      ) : (
        <dl className="dash-kv">
          <div className="dash-kv__item">
            <dt>{s.version}</dt>
            <dd>
              <Pill tone="accent" dot>
                {r.version}
              </Pill>
            </dd>
          </div>
          <div className="dash-kv__item">
            <dt>{s.size}</dt>
            <dd>{s.sizeBytes(r.sizeBytes, formatBytes(r.sizeBytes))}</dd>
          </div>
          <div className="dash-kv__item" style={{ gridColumn: "1 / -1" }}>
            <dt>{s.url}</dt>
            <dd className="dash-mono">{r.url}</dd>
          </div>
          <div className="dash-kv__item" style={{ gridColumn: "1 / -1" }}>
            <dt>{s.sha256}</dt>
            <dd className="dash-mono">{r.sha256}</dd>
          </div>
        </dl>
      )}
      <ConfirmDialog
        open={confirm}
        title={s.stopTitle}
        body={s.stopBody}
        confirmLabel={s.stop}
        danger
        onConfirm={() => set({ expectedRevision: data.revision, release: null })}
        onDone={() => toast(s.cleared)}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}

function ReleaseForm({ data, onReload }: { data: ReleaseScreen; onReload: () => void }) {
  const set = useSetRelease();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const [revision, setRevision] = useState(data.revision);
  const f = useForm<ReleaseFields>(fieldsOf(data.release), problemsOf);
  const serverField = (field: (typeof FIELDS)[number]) => serverFieldError(f.serverError, field, () => s.problems.serverRefused);

  return (
    <Card title={s.formTitle} sub={s.formLead}>
      <form
        ref={form}
        className="dash-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit(async (x) => {
            const next: ReleaseInfo = releaseOf(x);
            if (sameRelease(next, data.release)) {
              toast(s.noChange);
              return;
            }
            const r = await set({ expectedRevision: revision, release: next });
            setRevision(r.revision);
            f.reset(fieldsOf(next));
            toast(s.saved);
          }, form.current);
        }}
      >
        <Field label={s.versionLabel} hint={s.versionHint} error={f.errors.version ?? serverField("release.version")} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              value={f.values.version}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => f.set("version", e.target.value)}
              style={{ maxWidth: 280 }}
            />
          )}
        </Field>
        <Field label={s.urlLabel} hint={s.urlHint} error={f.errors.url ?? serverField("release.url")} required>
          {(p) => (
            <Input
              {...p}
              type="url"
              className="dash-mono"
              value={f.values.url}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="https://"
              onChange={(e) => f.set("url", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.shaLabel} hint={s.shaHint} error={f.errors.sha256 ?? serverField("release.sha256")} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              value={f.values.sha256}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={80}
              onChange={(e) => f.set("sha256", e.target.value)}
            />
          )}
        </Field>
        <Field label={s.sizeLabel} hint={s.sizeHint} error={f.errors.size ?? serverField("release.sizeBytes")} required>
          {(p) => (
            <Input
              {...p}
              className="dash-mono"
              inputMode="numeric"
              value={f.values.size}
              autoComplete="off"
              onChange={(e) => f.set("size", e.target.value)}
              style={{ maxWidth: 240 }}
            />
          )}
        </Field>
        <FormError error={f.serverError} onReload={onReload} fields={FIELDS} />
        <InlineNotice tone="neutral" title={s.fresh} />
        <div className="dash-form__actions">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? s.saving : s.setRelease}
          </Button>
          {f.dirty ? <span className="dash-form__status">{strings.common.unsavedHint}</span> : null}
        </div>
      </form>
    </Card>
  );
}
