import { lazy, Suspense, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@rulebox/ui";
import IconLock from "~icons/solar/lock-keyhole-linear";
import { useCreateEmployee, useEmployeeDetail, useUnlockEmployee, useUpdateEmployee } from "../data";
import type { EmployeeDetail as Detail } from "../data/types";
import { InlineNotice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { QueryRegion } from "../components/Region";
import { RoleGate } from "../components/RoleGate";
import { Skeleton, SkeletonBlock } from "../components/Skeleton";
import { messageFor } from "../lib/errors";
import { formatTime } from "../lib/format";
import { useCan } from "../lib/member";
import { employeeStrings as s } from "../lib/screenStrings/employee";
import { employeesStrings } from "../lib/screenStrings/employees";
import { strings } from "../lib/strings";
import { useToast } from "../lib/toast";
import * as v from "../lib/validate";
import { AccountCard } from "./employee/AccountCard";
import { EmployeeHeader } from "./employee/Header";
import { PasswordCard } from "./employee/PasswordCard";
import { quotaOf, useProfileForm, valuesOf } from "./employee/profile";
import { ProfileForm, ReadOnlyProfile } from "./employee/ProfileForm";
import { Summary } from "./employee/Summary";
import "./employee/employee.css";

// Loaded when they are needed: the hand-over after "Create employee", and the history list (a table) a moment after the page.
const HandoverDialog = lazy(() => import("./employee/HandoverDialog").then((m) => ({ default: m.HandoverDialog })));
const HistoryPanel = lazy(() => import("../components/HistoryPanel").then((m) => ({ default: m.HistoryPanel })));

/** `employees:get`; `/employees/new` uses the same form with blank values (`employees:options`). */
export default function EmployeeDetail() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const detail = useEmployeeDetail(isNew ? "new" : id);
  return (
    <div className="dash-page emp">
      {detail.status === "error" ? <PageHeader title={employeesStrings.title} back={{ to: "/employees", label: s.back }} /> : null}
      <QueryRegion state={detail} skeleton={<PageSkeleton />}>
        {/* Keyed by the route id: another employee starts with a fresh form. */}
        {(d) => (isNew ? <NewEmployee d={d} /> : <ExistingEmployee key={d._id} d={d} />)}
      </QueryRegion>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div role="status" aria-label={strings.app.loading}>
      <div className="emp-skel__head">
        <Skeleton width={96} height={14} />
        <Skeleton width="min(320px, 70%)" height={30} radius={10} />
      </div>
      <div className="dash-split emp-split">
        <div className="dash-split__main">
          <div className="dash-card dash-card--pad">
            <SkeletonBlock lines={6} />
          </div>
        </div>
        <div className="dash-split__aside">
          <div className="dash-card dash-card--pad">
            <SkeletonBlock lines={3} />
          </div>
        </div>
      </div>
    </div>
  );
}

function NewEmployee({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  if (!canAct) {
    return (
      <>
        <EmployeeHeader />
        <InlineNotice tone="neutral" title={strings.app.readOnly} />
      </>
    );
  }
  return <NewForm d={d} />;
}

/** What the hand-over dialog needs. It lives in this component's state only. */
interface Handover {
  id: string;
  name: string;
  username: string;
  password: string;
}

function NewForm({ d }: { d: Detail }) {
  const f = useProfileForm(d, true);
  const create = useCreateEmployee();
  const navigate = useNavigate();
  const toast = useToast();
  const [handover, setHandover] = useState<Handover | null>(null);

  function finish(id: string, name: string) {
    toast(s.created(name));
    navigate(`/employees/${id}`, { replace: true });
  }

  return (
    <>
      <EmployeeHeader />
      <div className="dash-split dash-split--sticky emp-split">
        <div className="dash-split__main">
          <ProfileForm
            d={d}
            isNew
            f={f}
            onSave={async (x) => {
              const name = x.name.trim();
              const id = await create({
                name,
                username: x.username.trim(),
                quotaGb: quotaOf(x),
                groupIds: x.groupIds,
                appIds: x.appIds,
                password: x.password || undefined,
              });
              // A generated password is shown once; one the person typed needs no hand-over.
              if (x.typed) finish(id, name);
              else setHandover({ id, name, username: v.normalizeUsername(x.username), password: x.password });
            }}
          />
        </div>
        <div className="dash-split__aside">
          <Summary d={d} values={f.values} />
        </div>
      </div>
      <Suspense fallback={null}>
        {handover ? (
          <HandoverDialog
            name={handover.name}
            username={handover.username}
            password={handover.password}
            onDone={() => {
              const { id, name } = handover;
              setHandover(null);
              finish(id, name);
            }}
          />
        ) : null}
      </Suspense>
    </>
  );
}

function ExistingEmployee({ d }: { d: Detail }) {
  const canAct = useCan("admin");
  return (
    <>
      <EmployeeHeader d={d} />
      {d.disabled ? <InlineNotice tone="neutral" title={employeesStrings.disabled} detail={s.disabledHelp} /> : null}
      {d.lockout ? <LockoutNotice d={d} /> : null}
      <div className="dash-split emp-split">
        <div className="dash-split__main">{canAct ? <EditProfile d={d} /> : <ReadOnlyProfile d={d} />}</div>
        <div className="dash-split__aside">
          <PasswordCard d={d} />
          <RoleGate minRole="admin">
            <AccountCard d={d} />
          </RoleGate>
          <Suspense fallback={<div className="dash-card dash-card--pad"><SkeletonBlock lines={3} /></div>}>
            <HistoryPanel targetId={d._id} title={s.history} />
          </Suspense>
        </div>
      </div>
    </>
  );
}

function EditProfile({ d }: { d: Detail }) {
  const update = useUpdateEmployee();
  const toast = useToast();
  const [revision, setRevision] = useState(d.revision);
  const f = useProfileForm(d, false);
  return (
    <ProfileForm
      d={d}
      f={f}
      onSave={async (x) => {
        const saved = await update({
          employeeId: d._id,
          expectedRevision: revision,
          name: x.name.trim(),
          username: x.username.trim(),
          quotaGb: quotaOf(x),
          groupIds: x.groupIds,
          appIds: x.appIds,
        });
        // The revision to send next: the server bumps it once per part that changed.
        setRevision(saved.revision);
        toast(s.saved);
      }}
      onReload={() => {
        setRevision(d.revision);
        f.reset(valuesOf(d, false));
      }}
    />
  );
}

function LockoutNotice({ d }: { d: Detail }) {
  const unlock = useUnlockEmployee();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  if (!d.lockout) return null;
  return (
    <InlineNotice
      tone="warning"
      title={s.lockedTitle}
      detail={s.lockedDetail(d.lockout.failures, formatTime(d.lockout.lockedUntil))}
      action={
        <RoleGate minRole="admin">
          <Button
            variant="ghost"
            className="dash-btn--sm"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              setPending(true);
              unlock({ employeeId: d._id }).then(
                () => toast(s.unlocked),
                (e) => {
                  setPending(false);
                  toast(messageFor(e), "danger");
                },
              );
            }}
          >
            <IconLock aria-hidden="true" />
            {s.unlock}
          </Button>
        </RoleGate>
      }
    />
  );
}
