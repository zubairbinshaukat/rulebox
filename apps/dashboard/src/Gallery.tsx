import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";
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
  type LogoAnimation,
  type Theme,
} from "@rulebox/ui";

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
    <div style={{ position: "relative" }}>
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
            <h1 style={{ margin: 0, fontSize: 34, fontWeight: 500, letterSpacing: "-0.025em" }}>Rulebox UI</h1>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 24 }}>
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
                <Input placeholder="Username" />
                <Input type="password" placeholder="Password" />
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
