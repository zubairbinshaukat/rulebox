import type { FormEvent } from "react";
import type { AppDetail } from "../../../data/types";
import AppPage, { type DetailsContext } from "../page/AppPage";
import { useWebIcon, type WebIconState } from "./useWebIcon";
import { WebAppForm } from "./WebAppForm";
import { webPayload } from "./webPayload";

/** The Details tab of a website: the website form inside the page's one lifted form (the page's save bar saves). */
function WebDetails({ ctx, icon }: { ctx: DetailsContext; icon: WebIconState }) {
  return (
    <form noValidate onSubmit={(e: FormEvent<HTMLFormElement>) => ctx.onSubmit(e)}>
      <WebAppForm d={ctx.d} f={ctx.f} isNew={false} readOnly={ctx.readOnly} icon={icon} />
    </form>
  );
}

/**
 * `AppPage` for a website, with the website form as its Details tab (UI pass, add-app plan 13): the site-access picker, "Opens in" under
 * More options, the allowed sites under Advanced. The fetched icon is stored after the save, like on the add page. Other tabs are the page's.
 */
export default function WebAppPage({ d }: { d: AppDetail }) {
  const icon = useWebIcon();
  return (
    <AppPage
      d={d}
      renderDetails={(ctx) => <WebDetails ctx={ctx} icon={icon} />}
      buildUpdate={(values) => ({ web: webPayload(values) })}
      afterSave={(values, app) => icon.save(app._id, values.url)}
    />
  );
}
