import { useMemo, useRef } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "@rulebox/ui";
import { useCreateWebApp, useSetAppPermissions } from "../../../data";
import { NEW_WEB_APP_PERMISSIONS, type WebAppInput, type WebPermissions } from "../../../data/types";
import { FormError } from "../../../components/FormError";
import { InlineNotice } from "../../../components/Notice";
import { PageHeader } from "../../../components/PageHeader";
import { errorCodeOf, messageFor, registerDetailSentences } from "../../../lib/errors";
import { useCan } from "../../../lib/member";
import { appAddStrings } from "../../../lib/screenStrings/appAdd";
import { appEditStrings } from "../../../lib/screenStrings/appEdit";
import { browserRefusalStrings } from "../../../lib/screenStrings/appBrowser";
import { strings } from "../../../lib/strings";
import { useForm } from "../../../lib/useForm";
import { useToast } from "../../../lib/toast";
import { initialValues, validateValues, type FormValues } from "../appForm";
import { galleryApp, type GalleryApp } from "../gallery/catalog";
import { blankWebDetail, withHttps } from "./webAddress";
import { useWebIcon, WEB_SERVER_FIELDS } from "./useWebIcon";
import { WebAppForm } from "./WebAppForm";
import { webPayload } from "./webPayload";
import "../apps.css";
import "./web.css";

registerDetailSentences(browserRefusalStrings);

const t = appAddStrings;
const w = appAddStrings.web;

/**
 * `/apps/new?kind=web` (+ `&url=<address>` or `&gallery=<key>`): add a website. One card with the address, the name, which pages open and
 * "More options"; the preview and the "Add website" button beside it (below it on a phone, where the button sticks to the bottom).
 */
export default function WebAdd() {
  const [params] = useSearchParams();
  const key = params.get("gallery");
  const entry = galleryApp(key);
  if (key !== null && (entry === undefined || entry.kind !== "web")) return <Navigate to="/apps/new?missing=1" replace />;
  return <Add key={`${key ?? ""}|${params.get("url") ?? ""}`} entry={entry} url={params.get("url")} />;
}

/** The form's start: a popular website's address, name, colour and sign-in sites, or just the address that was pasted. */
function startValues(entry: GalleryApp | undefined, url: string | null): FormValues {
  const base = initialValues(blankWebDetail(), "web");
  const address = withHttps(entry?.url ?? url ?? "");
  let host = "";
  try {
    host = new URL(address).hostname;
  } catch {
    /* not an address yet */
  }
  return {
    ...base,
    url: address,
    name: entry?.name ?? "",
    hue: entry?.hue,
    domains: (entry?.allowedDomains ?? []).filter((e) => e !== host).join("\n"),
  };
}

/** Revisions: a new website starts at 0 on the server (the demo's twin at 1), so the permissions that follow ask for 0 and, when that is stale, for 1. */
async function setNewPermissions(set: ReturnType<typeof useSetAppPermissions>, appId: string, permissions: WebPermissions) {
  try {
    await set({ appId, expectedRevision: 0, permissions });
  } catch (e) {
    if (errorCodeOf(e) !== "stale_edit") throw e;
    await set({ appId, expectedRevision: 1, permissions });
  }
}

function Add({ entry, url }: { entry: GalleryApp | undefined; url: string | null }) {
  const canAct = useCan("admin");
  const navigate = useNavigate();
  const toast = useToast();
  const createWeb = useCreateWebApp();
  const setPermissions = useSetAppPermissions();
  const icon = useWebIcon();
  const form = useRef<HTMLFormElement>(null);
  const start = useMemo(() => startValues(entry, url), [entry, url]);
  const f = useForm<FormValues>(start, (x) => validateValues("web", x));
  const detail = useMemo(() => blankWebDetail(), []);
  const errorCount = Object.values(f.errors).filter(Boolean).length;

  async function save(values: FormValues) {
    const web: WebAppInput = webPayload(values);
    const id = await createWeb(web);
    // The app exists now: whatever follows only warns (it can be redone on the app's page).
    try {
      await icon.save(id, web.url);
    } catch (e) {
      toast(`${appEditStrings.iconNotSaved} ${messageFor(e)}`, "danger");
    }
    if (entry?.permissions) {
      try {
        await setNewPermissions(setPermissions, id, { ...NEW_WEB_APP_PERMISSIONS, ...entry.permissions });
      } catch (e) {
        toast(messageFor(e), "danger");
      }
    }
    toast(appEditStrings.created(web.name));
    navigate(`/apps/${id}?tab=access&added=1`, { replace: true });
  }

  return (
    <div className="dash-page web-page">
      <PageHeader title={w.title} back={{ to: "/apps/new", label: t.back }} />
      <form
        ref={form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (canAct) void f.submit(save, form.current);
        }}
      >
        <WebAppForm
          d={detail}
          f={f}
          isNew
          readOnly={!canAct}
          icon={icon}
          autoFetch={start.url !== ""}
          footer={
            <div className="web-bar">
              {!canAct ? <InlineNotice tone="neutral" title={t.review.viewer} /> : null}
              <FormError error={f.serverError} fields={WEB_SERVER_FIELDS} />
              {errorCount > 0 ? <InlineNotice tone="danger" title={strings.validate.fixErrors(errorCount)} /> : null}
              <Button type="submit" disabled={!canAct || f.pending} aria-busy={f.pending}>
                {f.pending ? t.review.adding : w.add}
              </Button>
              <Link to="/apps/new" className="rb-btn rb-btn--ghost">
                {t.review.cancel}
              </Link>
            </div>
          }
        />
      </form>
    </div>
  );
}
