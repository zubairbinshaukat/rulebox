import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  AppTile,
  Avatar,
  Backdrop,
  Button,
  Dialog,
  FileChip,
  IconButton,
  Input,
  LogoMark,
  LogoMotion,
  MenuItem,
  MenuList,
  Notice,
  Panel,
  Pill,
  ProgressBar,
  SegmentedControl,
  Slider,
  Spinner,
  StatCard,
  Surface,
  Switch,
  Tabs,
  TitleBar,
  InfoTip,
  NativeSelect,
  SearchSelect,
  Select,
  Textarea,
  Checkbox,
  setLite,
  type LogoAnimation,
  type SelectOption,
  type Theme,
} from "@rulebox/ui";
import "@rulebox/ui/staff.css";
import { useTheme } from "./app/theme";
import { DataTable, type Column, type SortState } from "./components/DataTable";
import { AttentionList, type AttentionItem } from "./components/AttentionList";
import { ChipPicker } from "./components/ChipPicker";
import { ChoiceCards } from "./components/ChoiceCards";
import { EmptyState } from "./components/EmptyState";
import { Field, FieldSet } from "./components/Field";
import { MoreMenu } from "./components/MoreMenu";
import { Pager } from "./components/Pager";
import { SearchInput } from "./components/SearchInput";
import { StatTile, StatTiles } from "./components/StatTile";

import Home2Linear from "~icons/solar/home-2-linear";
import Home2Duo from "~icons/solar/home-2-bold-duotone";
import Home2Bold from "~icons/solar/home-2-bold";
import MonitorLinear from "~icons/solar/monitor-linear";
import MonitorDuo from "~icons/solar/monitor-bold-duotone";
import MonitorBold from "~icons/solar/monitor-bold";
import LaptopLinear from "~icons/solar/laptop-linear";
import LaptopDuo from "~icons/solar/laptop-bold-duotone";
import LaptopBold from "~icons/solar/laptop-bold";
import UsersLinear from "~icons/solar/users-group-rounded-linear";
import UsersDuo from "~icons/solar/users-group-rounded-bold-duotone";
import UsersBold from "~icons/solar/users-group-rounded-bold";
import WidgetLinear from "~icons/solar/widget-2-linear";
import WidgetDuo from "~icons/solar/widget-2-bold-duotone";
import WidgetBold from "~icons/solar/widget-2-bold";
import FolderLinear from "~icons/solar/folder-linear";
import FolderDuo from "~icons/solar/folder-bold-duotone";
import FolderBold from "~icons/solar/folder-bold";
import DocLinear from "~icons/solar/document-text-linear";
import DocDuo from "~icons/solar/document-text-bold-duotone";
import DocBold from "~icons/solar/document-text-bold";
import MusicLinear from "~icons/solar/music-note-2-linear";
import MusicDuo from "~icons/solar/music-note-2-bold-duotone";
import MusicBold from "~icons/solar/music-note-2-bold";
import VideoLinear from "~icons/solar/videocamera-record-linear";
import VideoDuo from "~icons/solar/videocamera-record-bold-duotone";
import VideoBold from "~icons/solar/videocamera-record-bold";
import GalleryLinear from "~icons/solar/gallery-linear";
import GalleryDuo from "~icons/solar/gallery-bold-duotone";
import GalleryBold from "~icons/solar/gallery-bold";
import ShieldLinear from "~icons/solar/shield-check-linear";
import ShieldDuo from "~icons/solar/shield-check-bold-duotone";
import ShieldBold from "~icons/solar/shield-check-bold";
import LockLinear from "~icons/solar/lock-keyhole-linear";
import LockDuo from "~icons/solar/lock-keyhole-bold-duotone";
import LockBold from "~icons/solar/lock-keyhole-bold";
import WifiLinear from "~icons/solar/wi-fi-router-linear";
import WifiDuo from "~icons/solar/wi-fi-router-bold-duotone";
import WifiBold from "~icons/solar/wi-fi-router-bold";
import PrinterLinear from "~icons/solar/printer-linear";
import PrinterDuo from "~icons/solar/printer-bold-duotone";
import PrinterBold from "~icons/solar/printer-bold";
import SettingsLinear from "~icons/solar/settings-linear";
import SettingsDuo from "~icons/solar/settings-bold-duotone";
import SettingsBold from "~icons/solar/settings-bold";
import BellLinear from "~icons/solar/bell-linear";
import BellDuo from "~icons/solar/bell-bold-duotone";
import BellBold from "~icons/solar/bell-bold";
import PowerLinear from "~icons/solar/power-linear";
import PowerDuo from "~icons/solar/power-bold-duotone";
import PowerBold from "~icons/solar/power-bold";
import DownloadLinear from "~icons/solar/cloud-download-linear";
import DownloadDuo from "~icons/solar/cloud-download-bold-duotone";
import DownloadBold from "~icons/solar/cloud-download-bold";
import RocketLinear from "~icons/solar/rocket-2-linear";
import RocketDuo from "~icons/solar/rocket-2-bold-duotone";
import RocketBold from "~icons/solar/rocket-2-bold";
import HistoryLinear from "~icons/solar/history-linear";
import HistoryDuo from "~icons/solar/history-bold-duotone";
import HistoryBold from "~icons/solar/history-bold";
import CalendarLinear from "~icons/solar/calendar-linear";
import CalendarDuo from "~icons/solar/calendar-bold-duotone";
import CalendarBold from "~icons/solar/calendar-bold";
import ChatLinear from "~icons/solar/chat-round-dots-linear";
import ChatDuo from "~icons/solar/chat-round-dots-bold-duotone";
import ChatBold from "~icons/solar/chat-round-dots-bold";
import KeyLinear from "~icons/solar/key-linear";
import KeyDuo from "~icons/solar/key-bold-duotone";
import KeyBold from "~icons/solar/key-bold";
import ChartLinear from "~icons/solar/chart-2-linear";
import ChartDuo from "~icons/solar/chart-2-bold-duotone";
import ChartBold from "~icons/solar/chart-2-bold";
import AddLinear from "~icons/solar/add-circle-linear";
import RefreshLinear from "~icons/solar/refresh-linear";
import TrashLinear from "~icons/solar/trash-bin-2-linear";
import CheckDuo from "~icons/solar/check-circle-bold-duotone";
import DangerDuo from "~icons/solar/danger-triangle-bold-duotone";
import LogoutLinear from "~icons/solar/logout-2-linear";
import RenameLinear from "~icons/solar/pen-linear";
import MonitorTile from "~icons/solar/monitor-linear";
import UsersTile from "~icons/solar/users-group-rounded-linear";
import AppsTile from "~icons/solar/box-linear";
import ShieldTile from "~icons/solar/shield-check-linear";
import DownloadTile from "~icons/solar/cloud-download-linear";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type IconStyle = "linear" | "duotone" | "bold";

const ICONS: { name: string; linear: Icon; duotone: Icon; bold: Icon }[] = [
  { name: "Home", linear: Home2Linear, duotone: Home2Duo, bold: Home2Bold },
  { name: "Devices", linear: MonitorLinear, duotone: MonitorDuo, bold: MonitorBold },
  { name: "Laptop", linear: LaptopLinear, duotone: LaptopDuo, bold: LaptopBold },
  { name: "Employees", linear: UsersLinear, duotone: UsersDuo, bold: UsersBold },
  { name: "Apps", linear: WidgetLinear, duotone: WidgetDuo, bold: WidgetBold },
  { name: "Files", linear: FolderLinear, duotone: FolderDuo, bold: FolderBold },
  { name: "Document", linear: DocLinear, duotone: DocDuo, bold: DocBold },
  { name: "Music", linear: MusicLinear, duotone: MusicDuo, bold: MusicBold },
  { name: "Video", linear: VideoLinear, duotone: VideoDuo, bold: VideoBold },
  { name: "Images", linear: GalleryLinear, duotone: GalleryDuo, bold: GalleryBold },
  { name: "Policies", linear: ShieldLinear, duotone: ShieldDuo, bold: ShieldBold },
  { name: "Lock", linear: LockLinear, duotone: LockDuo, bold: LockBold },
  { name: "Wi-Fi", linear: WifiLinear, duotone: WifiDuo, bold: WifiBold },
  { name: "Printers", linear: PrinterLinear, duotone: PrinterDuo, bold: PrinterBold },
  { name: "Settings", linear: SettingsLinear, duotone: SettingsDuo, bold: SettingsBold },
  { name: "Alerts", linear: BellLinear, duotone: BellDuo, bold: BellBold },
  { name: "Power", linear: PowerLinear, duotone: PowerDuo, bold: PowerBold },
  { name: "Install", linear: DownloadLinear, duotone: DownloadDuo, bold: DownloadBold },
  { name: "Rollout", linear: RocketLinear, duotone: RocketDuo, bold: RocketBold },
  { name: "Audit log", linear: HistoryLinear, duotone: HistoryDuo, bold: HistoryBold },
  { name: "Schedule", linear: CalendarLinear, duotone: CalendarDuo, bold: CalendarBold },
  { name: "Messages", linear: ChatLinear, duotone: ChatDuo, bold: ChatBold },
  { name: "Admin PIN", linear: KeyLinear, duotone: KeyDuo, bold: KeyBold },
  { name: "Reports", linear: ChartLinear, duotone: ChartDuo, bold: ChartBold },
];

const themes = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
] as const;

const liteOptions = [
  { value: "standard", label: "Standard" },
  { value: "lite", label: "Lite" },
] as const;

const iconStyles = [
  { value: "linear", label: "Linear" },
  { value: "duotone", label: "Bold Duotone" },
  { value: "bold", label: "Bold" },
] as const;

interface GalleryProps {
  theme: Theme;
  onTheme: (t: Theme) => void;
  lite: boolean;
  onLite: (lite: boolean) => void;
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel size="md" style={{ padding: 28 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", marginBottom: 24 }}>
        <div style={{ marginRight: "auto" }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}>{title}</h2>
          {description && (
            <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--rb-muted)" }}>{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Panel>
  );
}

const row = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" } as const;

const logoAnimations = [
  { value: "splash", label: "Splash" },
  { value: "loading", label: "Loading" },
  { value: "open", label: "Open desktop" },
  { value: "lock", label: "Lock" },
] as const;

function LogoSection() {
  const [anim, setAnim] = useState<LogoAnimation>("splash");
  // Bumping the key remounts the logo, which replays the same animation.
  const [run, setRun] = useState(0);

  return (
    <Section
      title="Logo"
      description="LogoMark is the still logo. LogoMotion plays the brand animations in CSS only."
      action={
        <div style={row}>
          <SegmentedControl
            options={logoAnimations}
            value={anim === "none" ? "splash" : anim}
            onChange={(v) => {
              setAnim(v);
              setRun((n) => n + 1);
            }}
            aria-label="Logo animation"
          />
          <Button variant="ghost" onClick={() => setRun((n) => n + 1)}>
            Replay
          </Button>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <div
          style={{
            position: "relative",
            height: 380,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius: "var(--rb-r-xl)",
            background: "var(--rb-hover)",
          }}
        >
          <LogoMotion key={run} animation={anim} />
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 24,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            borderRadius: "var(--rb-r-xl)",
            background: "var(--rb-hover)",
          }}
        >
          {[96, 48, 32, 20].map((s) => (
            <LogoMark key={s} size={s} />
          ))}
        </div>
      </div>
    </Section>
  );
}

const TABLE_ROWS = Array.from({ length: 147 }, (_, i) => ({ id: String(i + 1), name: `PC-${String(i + 1).padStart(3, "0")}`, ring: i % 3 === 0 ? "Pilot" : "Stable", apps: (i * 7) % 23 }));

/** The generic DataTable, its search box, view switch and Pager, on sample rows (the sort and pages run on the client here). */
function TableSection() {
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
  const [search, setSearch] = useState("");
  const [size, setSize] = useState(10);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<"ready" | "loading" | "empty" | "error">("ready");
  const filtered = TABLE_ROWS.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
  const sorted = [...filtered].sort((a, b) => {
    const x = sort.key === "apps" ? a.apps : a[sort.key as "name" | "ring"];
    const y = sort.key === "apps" ? b.apps : b[sort.key as "name" | "ring"];
    return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === "asc" ? 1 : -1);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const shown = sorted.slice((Math.min(page, pages) - 1) * size, Math.min(page, pages) * size);
  const reachable = new Set([1, Math.max(1, Math.min(page, pages) - 1), Math.min(page, pages), Math.min(pages, page + 1), pages]);
  const cols: Column<(typeof TABLE_ROWS)[number]>[] = [
    { key: "name", header: "Name", primary: true, sortable: true, cell: (r) => <a className="dash-link dash-link--plain" href={`#${r.id}`} onClick={(e) => e.preventDefault()}>{r.name}</a> },
    { key: "ring", header: "Ring", sortable: true, cell: (r) => <Pill tone={r.ring === "Pilot" ? "accent" : "neutral"}>{r.ring}</Pill> },
    { key: "apps", header: "Apps", numeric: true, sortable: true, sortDefaultDir: "desc", cell: (r) => r.apps },
  ];
  return (
    <Section
      title="Data table and pager"
      description="Sortable headers, whole-row click, Enter-to-search, Table | Cards view, loading / empty / error states, Pager."
      action={
        <SegmentedControl
          options={[{ value: "ready", label: "Rows" }, { value: "loading", label: "Loading" }, { value: "empty", label: "Empty" }, { value: "error", label: "Error" }]}
          value={state}
          onChange={setState}
          aria-label="Table state"
        />
      }
    >
      <DataTable
        framed
        caption="Sample PCs"
        columns={cols}
        rows={shown}
        getKey={(r) => r.id}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        onRowClick={(r) => window.alert(`Open ${r.name}`)}
        state={state === "ready" && shown.length === 0 ? "empty" : state}
        empty={<EmptyState title="No PCs match" body="Try another search." />}
        error={new Error("sample")}
        onRetry={() => setState("ready")}
        toolbar={
          <SearchInput
            label="Search PCs"
            placeholder="Search by name"
            value={search}
            onSearch={(t) => {
              setSearch(t);
              setPage(1);
            }}
          />
        }
        footer={
          <Pager
            page={Math.min(page, pages)}
            pageSize={size}
            total={sorted.length}
            reachablePages={reachable}
            hasNext={page < pages}
            onPage={setPage}
            onPageSize={(n) => {
              setSize(n);
              setPage(1);
            }}
          />
        }
      />
    </Section>
  );
}

const SHORT_OPTIONS: SelectOption[] = [
  { value: "front", label: "Front desk", hint: "12 PCs" },
  { value: "office", label: "Back office", hint: "4 PCs" },
  { value: "kitchen", label: "Kitchen" },
  { value: "old", label: "Retired group", disabled: true },
];

const LONG_OPTIONS: SelectOption[] = [
  { value: "short", label: "All groups" },
  {
    value: "long",
    label:
      "North region, second floor, reception and waiting area, shared with the training team and the visiting contractors",
    hint: "A very long label wraps over up to three lines in the list and is cut with an ellipsis in the box",
  },
  { value: "unbroken", label: "Reception-desk-with-an-extremely-long-name-and-no-spaces-at-all-to-break-on-0123456789" },
];

const APP_NAMES = ["Zoom", "Chrome", "Café Till", "Notepad++", "Slack", "Teams", "VLC", "7-Zip", "Acrobat", "Skype"];
const MANY_OPTIONS: SelectOption[] = Array.from({ length: 40 }, (_, i) => ({
  value: `app-${i + 1}`,
  label: `${APP_NAMES[i % APP_NAMES.length]} ${["Pro", "Lite", "Web", "Beta"][Math.floor(i / APP_NAMES.length)]}`,
}));

/** The custom dropdowns and the (i) tip, in the dashboard's Field. */
function DropdownDemo() {
  const [group, setGroup] = useState("front");
  const [long, setLong] = useState("long");
  const [compact, setCompact] = useState("short");
  const [app, setApp] = useState("");
  return (
    <Section
      title="Dropdowns and tips"
      description="Select, SearchSelect and InfoTip: open them near the bottom of the window to see them flip up."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 360 }}>
        <Field label="Group" info="Every PC in a group gets the same apps and rules.">
          {(p) => <Select {...p} value={group} onChange={setGroup} options={SHORT_OPTIONS} />}
        </Field>
        <Field label="Long labels" hint="The box cuts the text, the list wraps it.">
          {(p) => <Select {...p} value={long} onChange={setLong} options={LONG_OPTIONS} />}
        </Field>
        <Field label="App" info="Type to find an app. Letters match with or without accents.">
          {(p) => (
            <SearchSelect
              {...p}
              value={app}
              onChange={setApp}
              options={MANY_OPTIONS}
              placeholder="Choose an app"
              searchPlaceholder="Search apps"
              emptyText="No app found"
            />
          )}
        </Field>
        <Field label="Compact, with an error" error="Choose a group first.">
          {(p) => <Select {...p} compact value={compact} onChange={setCompact} options={LONG_OPTIONS.slice(0, 1)} />}
        </Field>
        <Field label="Disabled">
          {(p) => <Select {...p} value="front" onChange={() => {}} options={SHORT_OPTIONS} disabled />}
        </Field>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)", display: "flex", alignItems: "center", gap: 8 }}>
          Alone in a sentence
          <InfoTip label="About this sentence" placement="bottom">
            A tooltip opens on hover or focus and flips when there is no room. On a phone, tap it.
          </InfoTip>
        </p>
      </div>
    </Section>
  );
}

const GROUP_OPTIONS: SelectOption[] = [
  { value: "front", label: "Front desk" },
  { value: "kitchen", label: "Kitchen" },
  { value: "office", label: "Back office" },
  { value: "store", label: "Store room" },
  { value: "counter", label: "Service counter" },
  ...Array.from({ length: 12 }, (_, i) => ({ value: `team-${i + 1}`, label: `Team ${i + 1}` })),
];

/** The shared pieces of the group, Overview, rollout, employee and message pages (other-pages plan, section 0). */
function OtherPagesDemo() {
  const [style, setStyle] = useState<string | null>("banner");
  const [audience, setAudience] = useState<string | null>("everyone");
  const [groups, setGroups] = useState<string[]>(["front", "kitchen"]);
  const [many, setMany] = useState<string[]>(GROUP_OPTIONS.slice(0, 15).map((o) => o.value));
  const [last, setLast] = useState("Nothing chosen yet.");
  const [showAttention, setShowAttention] = useState(true);
  const attention: AttentionItem[] = [
    { key: "info", tone: "info", title: "A change is reaching the first PCs", body: "It moves on by itself in 18 hours." },
    { key: "warn", tone: "warning", title: "2 PCs are not in a group", body: "Nobody can sign in on them until they are in one.", action: { label: "Show", onClick: () => setLast("Show") } },
    { key: "danger", tone: "danger", title: "Changes are not reaching your PCs", body: "Open Settings and press Publish again.", action: { label: "Open Settings", to: "/settings" } },
    { key: "w2", tone: "warning", title: "PDF Reader is archived. PCs no longer get it." },
    { key: "w3", tone: "warning", title: "Program blocking is still a trial run" },
    { key: "i2", tone: "info", title: "Kiosk mode is off on 1 PC" },
  ];
  return (
    <div id="gallery-other" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Section title="ChoiceCards" description="A few large cards, one chosen. Arrow keys move and choose; stacks under 420 px.">
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
          <ChoiceCards
            name="style"
            aria-label="Style"
            value={style}
            onChange={setStyle}
            options={[
              {
                value: "banner",
                label: "Banner",
                hint: "A strip at the top. People can close it.",
                art: <ChatDuo style={{ fontSize: 34 }} />,
              },
              {
                value: "full",
                label: "Full screen",
                hint: "Covers the screen until someone presses OK.",
                art: <MonitorDuo style={{ fontSize: 34 }} />,
              },
            ]}
          />
          <ChoiceCards
            aria-label="Who sees it"
            value={audience}
            onChange={setAudience}
            options={[
              { value: "everyone", label: "Everyone in the group" },
              { value: "chosen", label: "Only people I choose" },
              { value: "none", label: "Nobody yet", hint: "Not available for this app.", disabled: true },
            ]}
          />
        </div>
      </Section>

      <Section title="ChipPicker" description="Chips with a remove button and an Add box. Backspace takes the last chip off. After 12 chips, +N more.">
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
          <FieldSet legend="Groups" hint="Can sign in on the PCs of these groups.">
            <ChipPicker
              label="Groups"
              value={groups}
              onChange={setGroups}
              options={GROUP_OPTIONS}
              emptyText="No groups chosen yet"
              searchPlaceholder="Search groups"
            />
          </FieldSet>
          <ChipPicker label="Many groups" value={many} onChange={setMany} options={GROUP_OPTIONS} emptyText="No groups chosen yet" max={16} />
          <ChipPicker label="Read only" value={["front", "kitchen"]} onChange={() => {}} options={GROUP_OPTIONS} emptyText="None" disabled />
        </div>
      </Section>

      <Section
        title="MoreMenu"
        description="The ... button of a page header: arrows, Esc returns focus. Danger items sit last after a divider."
        action={
          <MoreMenu
            items={[
              { label: "Delete group", icon: <TrashLinear />, danger: true, onSelect: () => setLast("Delete group") },
              { label: "Rename", icon: <RenameLinear />, onSelect: () => setLast("Rename") },
              { label: "Send a message", icon: <ChatLinear />, onSelect: () => setLast("Send a message") },
              { label: "Staged rollout", icon: <RocketLinear />, to: "/gallery" },
              { label: "Hidden for viewers", hidden: true, onSelect: () => {} },
            ]}
            label="More for Front desk"
          />
        }
      >
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)" }}>Last choice: {last}</p>
      </Section>

      <Section
        title="AttentionList"
        description="Most urgent first, one action each, 5 shown then Show all. 1 column under 560 px, 2 from there."
        action={
          <Button variant="ghost" onClick={() => setShowAttention((v) => !v)}>
            {showAttention ? "Clear them" : "Bring them back"}
          </Button>
        }
      >
        <AttentionList items={showAttention ? attention : []} label="Needs attention" emptyText="Everything is fine on your 523 PCs." />
      </Section>

      <Section title="StatTile" description="A compact number tile, 2 across on a phone. A link, a button or plain with an (i) tip.">
        <StatTiles label="Numbers">
          <StatTile label="PCs" value="523" sub="498 online" icon={<MonitorTile />} to="/devices" />
          <StatTile label="People" value="1,204" icon={<UsersTile />} to="/employees" index={1} />
          <StatTile label="Apps" value="37" sub="in 12 groups" icon={<AppsTile />} index={2} />
          <StatTile label="Failed installs" value="4" sub="See the list" icon={<DownloadTile />} tone="warning" onClick={() => setLast("Failed installs")} index={3} />
          <StatTile label="Protection" value="Trial run" icon={<ShieldTile />} info="Programs are noted but not blocked yet." index={4} />
          <StatTile label="Everything" value="Fine" tone="ok" icon={<ShieldTile />} index={5} />
          <StatTile label="Suspended" value="Yes" sub="Ask the owner" tone="danger" icon={<ShieldTile />} index={6} />
        </StatTiles>
      </Section>
    </div>
  );
}

/** `/gallery` (members only): the design system with its own theme and Lite switches. */
export default function GalleryScreen() {
  const [theme, setTheme] = useTheme();
  const [lite, setLiteState] = useState(false);
  useEffect(() => {
    setLite(lite);
    return () => setLite(false);
  }, [lite]);
  return <Gallery theme={theme} onTheme={setTheme} lite={lite} onLite={setLiteState} />;
}

export function Gallery({ theme, onTheme, lite, onLite }: GalleryProps) {
  const [iconStyle, setIconStyle] = useState<IconStyle>("duotone");
  const [sw, setSw] = useState({ kiosk: true, usb: false, wifi: true });
  const [volume, setVolume] = useState(62);
  const [tab, setTab] = useState("files");
  const [tabs, setTabs] = useState([
    { id: "files", label: "Files", closable: true },
    { id: "viewer", label: "Q3 report.pdf", closable: true },
    { id: "settings", label: "Settings", closable: false },
  ]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [iconActive, setIconActive] = useState(false);

  return (
    <div style={{ position: "relative", overflowX: "clip" }}>
      {/* Fixed so the soft blobs fill the whole viewport instead of a hard-edged box. */}
      <div style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none" }}>
        <Backdrop />
      </div>
      <div style={{ position: "relative", zIndex: 1, maxWidth: 1120, margin: "0 auto" }}>
        {/* Hero */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-end", margin: "12px 0 36px" }}>
          <div style={{ marginRight: "auto" }}>
            <div
              style={{
                fontFamily: "var(--rb-font-mono)",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--rb-accent-text)",
                marginBottom: 8,
              }}
            >
              Design system
            </div>
            <h1 data-page-title tabIndex={-1} style={{ margin: 0, fontSize: 34, fontWeight: 500, letterSpacing: "-0.025em" }}>Rulebox UI</h1>
            <p style={{ margin: "8px 0 0", color: "var(--rb-muted)", maxWidth: 520, lineHeight: 1.55 }}>
              Shared components for the dashboard and the Staff App. Switch theme and display mode to check every
              state.
            </p>
          </div>
          <div style={row}>
            <SegmentedControl options={themes} value={theme} onChange={onTheme} aria-label="Theme" />
            <SegmentedControl
              options={liteOptions}
              value={lite ? "lite" : "standard"}
              onChange={(v) => onLite(v === "lite")}
              aria-label="Display mode"
            />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 16 }}>
            <StatCard label="Devices online" value="24" icon={<MonitorDuo />} hint="+3 since yesterday" />
            <StatCard label="Employees" value="58" icon={<UsersDuo />} />
            <StatCard label="Apps assigned" value="12" icon={<WidgetDuo />} />
            <StatCard label="Pending changes" value="3" icon={<RocketDuo />} />
          </div>

          <LogoSection />

          {/* Icons */}
          <Section
            title="Icons"
            description="Solar by 480 Design · bundled offline. Dashboard uses Linear, Staff App uses Bold Duotone."
            action={
              <SegmentedControl options={iconStyles} value={iconStyle} onChange={setIconStyle} aria-label="Icon style" />
            }
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 10 }}>
              {ICONS.map((ic) => {
                const C = ic[iconStyle];
                return (
                  <div
                    key={ic.name}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 10,
                      padding: "18px 8px 14px",
                      borderRadius: "var(--rb-r-lg)",
                      background: "var(--rb-hover)",
                    }}
                  >
                    <C style={{ fontSize: 28, color: "var(--rb-accent-text)" }} />
                    <span style={{ fontSize: 12, color: "var(--rb-muted)" }}>{ic.name}</span>
                  </div>
                );
              })}
            </div>
          </Section>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 24 }}>
            {/* Buttons */}
            <Section title="Buttons" description="Primary, ghost, danger and icon-only.">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={row}>
                  <Button>
                    <AddLinear /> Add app
                  </Button>
                  <Button variant="ghost">
                    <RefreshLinear /> Sync now
                  </Button>
                  <Button variant="danger-ghost">
                    <TrashLinear /> Remove
                  </Button>
                </div>
                <div style={row}>
                  <Button disabled>Disabled</Button>
                  <Button icon aria-label="Sign in">
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M3 8h10M9 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Button>
                  <Button variant="ghost" icon aria-label="Log out">
                    <LogoutLinear style={{ fontSize: 18 }} />
                  </Button>
                </div>
              </div>
            </Section>

            {/* Status */}
            <Section title="Status" description="Device and change states.">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={row}>
                  <Pill tone="success" dot>Online</Pill>
                  <Pill tone="neutral" dot>Offline</Pill>
                  <Pill tone="warning" dot>Pending</Pill>
                  <Pill tone="danger" dot>Failed</Pill>
                  <Pill tone="accent">Pilot ring</Pill>
                </div>
                <div style={{ ...row, gap: 18, color: "var(--rb-muted)", fontSize: 13.5 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <CheckDuo style={{ fontSize: 18, color: "var(--rb-success)" }} /> Zoom installed
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <DangerDuo style={{ fontSize: 18, color: "var(--rb-warning)" }} /> Low disk space
                  </span>
                </div>
              </div>
            </Section>

            {/* Inputs */}
            <Section title="Inputs" description="Sign-in and forms.">
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 }}>
                <Input placeholder="Username" aria-label="Username" />
                <Input type="password" placeholder="Password" aria-label="Password" />
              </div>
            </Section>

            {/* Form controls (Phase 4) */}
            <DropdownDemo />

            <Section title="Form controls" description="NativeSelect (until it is removed), Textarea, Checkbox.">
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 }}>
                <NativeSelect aria-label="Group" defaultValue="front">
                  <option value="front">Front desk</option>
                  <option value="office">Back office</option>
                </NativeSelect>
                <Textarea aria-label="Notes" placeholder="Allowed domains, one per line" rows={3} />
                <Checkbox label="Pin to taskbar" defaultChecked />
                <Checkbox label="Show on desktop" hint="The tile appears on the Staff App desktop." />
                <Checkbox label="Disabled option" disabled />
              </div>
            </Section>

            {/* Switches */}
            <Section title="Switches" description="Policy toggles.">
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Switch label="Kiosk mode" checked={sw.kiosk} onChange={(v) => setSw({ ...sw, kiosk: v })} />
                <Switch label="Block USB storage" checked={sw.usb} onChange={(v) => setSw({ ...sw, usb: v })} />
                <Switch label="Managed Wi-Fi only" checked={sw.wifi} onChange={(v) => setSw({ ...sw, wifi: v })} />
                <Switch label="Disabled option" checked={false} onChange={() => {}} disabled />
              </div>
            </Section>

            {/* Progress */}
            <Section title="Storage" description="Quota bars turn amber above 80% and red above 95%.">
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <ProgressBar label="Maya Okafor" detail="3.1 of 10 GB" value={31} />
                <ProgressBar label="Sam Lee" detail="8.6 of 10 GB" value={86} />
                <ProgressBar label="Disk C:" detail="97% used" value={97} />
              </div>
            </Section>

            {/* Avatars */}
            <Section title="Avatars" description="Initials on the accent tint.">
              <div style={{ ...row, gap: 16 }}>
                <Avatar name="Maya Okafor" size={72} />
                <Avatar name="Sam Lee" size={48} />
                <Avatar name="Priya Shah" size={40} />
                <Avatar name="Tom Becker" size={32} />
              </div>
            </Section>
          </div>

          <TableSection />

          <OtherPagesDemo />

          {/* App tiles */}
          <Section title="App tiles" description="Staff App desktop. Dot = open, badge = notifications. size + hue props.">
            <div style={{ ...row, gap: 18, alignItems: "flex-end" }}>
              <AppTile size="lg" name="Zoom" description="Large tile" icon={<VideoDuo style={{ fontSize: 28 }} />} running hue={255} />
              <AppTile name="Tally" description="Default md" icon={<ChartDuo style={{ fontSize: 26 }} />} badge={3} hue={145} />
              <AppTile size="sm" name="Files" description="Small" icon={<FolderDuo style={{ fontSize: 22 }} />} hue={70} />
              <AppTile name="Orders" description="Web portal" mono="Or" />
            </div>
          </Section>

          {/* Window */}
          <Section title="Window" description="TitleBar: icon, focused, children, dragRegion. Surface kind=window.">
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
              <Surface kind="window">
                <TitleBar
                  title="Files on this laptop"
                  icon={<FolderDuo style={{ fontSize: 14 }} />}
                  focused
                >
                  <IconButton label="Pin" size={32}>
                    <LockDuo style={{ fontSize: 16 }} />
                  </IconButton>
                </TitleBar>
                <div style={{ padding: 8 }}>
                  {[
                    { n: "Q3 report.pdf", m: "PDF · 2.4 MB", I: DocDuo, ext: "pdf" },
                    { n: "Team photo.jpg", m: "Image · 840 KB", I: GalleryDuo, ext: "jpg" },
                    { n: "Training intro.mp4", m: "Video · 48 MB", I: VideoDuo, ext: "mp4" },
                  ].map(({ n, m, I, ext }) => (
                    <div
                      key={n}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 12px",
                        borderRadius: "var(--rb-r-md)",
                      }}
                    >
                      <I style={{ fontSize: 24, color: "var(--rb-accent-text)" }} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{n}</span>
                        <span style={{ fontSize: 12, color: "var(--rb-muted)" }}>{m}</span>
                      </div>
                      <FileChip ext={ext} />
                    </div>
                  ))}
                </div>
              </Surface>
              <Surface kind="window" style={{ boxShadow: "var(--rb-shadow-window-inactive)" }}>
                <TitleBar title="Unfocused window" mono="U" focused={false} />
                <div style={{ padding: 16, fontSize: 13.5, color: "var(--rb-muted)" }}>Muted title when focused=false.</div>
              </Surface>
            </div>
          </Section>

          {/* Phase 3 Step 2 — new components */}
          <div id="gallery-new" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <Section title="IconButton" description="label → aria-label + title. Sizes 32 / 38 / 44, active state.">
              <div style={row}>
                <IconButton label="Settings" size={32}>
                  <SettingsDuo style={{ fontSize: 16 }} />
                </IconButton>
                <IconButton label="Alerts" size={38} active={iconActive} onClick={() => setIconActive((v) => !v)}>
                  <BellDuo style={{ fontSize: 18 }} />
                </IconButton>
                <IconButton label="Power" size={44}>
                  <PowerDuo style={{ fontSize: 20 }} />
                </IconButton>
              </div>
            </Section>

            <Section title="Surface" description="Frosted containers: popover, bar, window.">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
                <Surface kind="popover" style={{ padding: 16 }}>
                  <div style={{ fontWeight: 500, marginBottom: 6 }}>Popover</div>
                  <div style={{ fontSize: 13, color: "var(--rb-muted)" }}>glass-strong + shadow-popover</div>
                </Surface>
                <Surface kind="bar" style={{ padding: 16, height: 60, display: "flex", alignItems: "center" }}>
                  <div style={{ fontWeight: 500 }}>Bar · taskbar glass</div>
                </Surface>
                <Surface kind="window" style={{ padding: 16 }}>
                  <div style={{ fontWeight: 500, marginBottom: 6 }}>Window</div>
                  <div style={{ fontSize: 13, color: "var(--rb-muted)" }}>shadow-window</div>
                </Surface>
              </div>
            </Section>

            <Section title="Slider" description="Native range, styled. Label + value.">
              <div style={{ maxWidth: 420 }}>
                <Slider label="Volume" value={volume} onChange={setVolume} min={0} max={100} step={1} />
              </div>
            </Section>

            <Section title="Menu" description="role=menu / menuitem with arrow-key navigation.">
              <Surface kind="popover" style={{ width: 280, padding: 0 }}>
                <MenuList aria-label="Quick actions">
                  <MenuItem icon={<SettingsDuo />} hint="⌘,">
                    Settings
                  </MenuItem>
                  <MenuItem icon={<BellDuo />}>Notifications</MenuItem>
                  <MenuItem icon={<LogoutLinear />} danger>
                    Log out
                  </MenuItem>
                </MenuList>
              </Surface>
            </Section>

            <Section
              title="Dialog"
              description="Focus trap, Escape closes, role=dialog aria-modal."
              action={
                <Button variant="ghost" onClick={() => setDialogOpen(true)}>
                  Open dialog
                </Button>
              }
            >
              <p style={{ margin: 0, fontSize: 13.5, color: "var(--rb-muted)" }}>
                Click the button to open a modal dialog over the gallery.
              </p>
              <Dialog
                open={dialogOpen}
                title="Restart Rulebox?"
                onClose={() => setDialogOpen(false)}
                actions={
                  <>
                    <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={() => setDialogOpen(false)}>Restart</Button>
                  </>
                }
              >
                Open windows will close. Unsaved work in built-in viewers may be lost.
              </Dialog>
            </Section>

            <Section title="Tabs" description="Closable tabs with role=tablist and arrow keys.">
              <Tabs
                tabs={tabs}
                value={tab}
                onChange={setTab}
                onClose={(id) => {
                  setTabs((prev) => {
                    const next = prev.filter((t) => t.id !== id);
                    if (id === tab && next.length) setTab(next[0]!.id);
                    return next;
                  });
                }}
              >
                Active tab: <strong style={{ color: "var(--rb-ink)" }}>{tab}</strong>
              </Tabs>
            </Section>

            <Section title="FileChip" description="Extension → fixed hue table.">
              <div style={row}>
                {["pdf", "docx", "xlsx", "png", "mp3", "mp4", "zip", "txt"].map((ext) => (
                  <FileChip key={ext} ext={ext} />
                ))}
              </div>
            </Section>

            <Section title="Notice" description="Tone, title, detail, optional dismiss.">
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 }}>
                {noticeVisible ? (
                  <Notice
                    tone="warning"
                    title="Low disk space"
                    detail="Only 1.2 GB free on this laptop."
                    icon={<DangerDuo style={{ fontSize: 20, color: "var(--rb-warning)" }} />}
                    onDismiss={() => setNoticeVisible(false)}
                  />
                ) : (
                  <Button variant="ghost" onClick={() => setNoticeVisible(true)}>
                    Show notice again
                  </Button>
                )}
                <Notice tone="success" title="Policy applied" detail="Kiosk mode is on." />
                <Notice tone="danger" title="Sign-in locked" detail="Try again in 5 minutes." />
              </div>
            </Section>

            <Section title="Spinner" description="LogoMotion loading animation, no wordmark.">
              <div style={{ ...row, gap: 24 }}>
                <Spinner size={32} />
                <Spinner size={48} />
                <Spinner size={72} />
              </div>
            </Section>

            <Section title="Backdrop offsetY" description="Shifts the blob layer so stacked windows share one backdrop.">
              <div
                style={{
                  position: "relative",
                  height: 120,
                  borderRadius: "var(--rb-r-xl)",
                  overflow: "hidden",
                  background: "var(--rb-bg)",
                  border: "1px solid var(--rb-line)",
                }}
              >
                <Backdrop offsetY={-40} />
                <div
                  style={{
                    position: "relative",
                    zIndex: 1,
                    padding: 16,
                    fontSize: 13.5,
                    color: "var(--rb-muted)",
                  }}
                >
                  offsetY=-40 on this preview strip.
                </div>
              </div>
            </Section>
          </div>

          <p style={{ margin: "8px 0 32px", textAlign: "center", fontSize: 12, color: "var(--rb-faint)" }}>
            Icons: Solar by 480 Design (CC BY 4.0)
          </p>
        </div>
      </div>
    </div>
  );
}
