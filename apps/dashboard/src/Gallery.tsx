import {
  AppTile,
  Avatar,
  Backdrop,
  Button,
  Input,
  Panel,
  SegmentedControl,
  TitleBar,
  type Theme,
} from "@rulebox/ui";

const themes = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" },
] as const;

const liteOptions = [
  { value: "standard", label: "Standard" },
  { value: "lite", label: "Lite" },
] as const;

interface GalleryProps {
  theme: Theme;
  onTheme: (t: Theme) => void;
  lite: boolean;
  onLite: (lite: boolean) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ margin: "0 0 14px", fontSize: 13, fontWeight: 500, color: "var(--rb-muted)" }}>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>{children}</div>
    </section>
  );
}

export function Gallery({ theme, onTheme, lite, onLite }: GalleryProps) {
  return (
    <div style={{ position: "relative" }}>
      <Backdrop />
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 28 }}>
          <SegmentedControl options={themes} value={theme} onChange={onTheme} aria-label="Theme" />
          <SegmentedControl
            options={liteOptions}
            value={lite ? "lite" : "standard"}
            onChange={(v) => onLite(v === "lite")}
            aria-label="Display mode"
          />
        </div>

        <Section title="Button">
          <Button>Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger-ghost">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button icon aria-label="Go">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Section>

        <Section title="Input">
          <div style={{ width: 280 }}>
            <Input placeholder="Username" />
          </div>
          <div style={{ width: 280 }}>
            <Input type="password" placeholder="Password" />
          </div>
        </Section>

        <Section title="Avatar">
          <Avatar name="Maya Okafor" size={72} />
          <Avatar name="Sam Lee" size={40} />
        </Section>

        <Section title="Panel">
          <Panel style={{ width: 300, padding: 24 }}>Frosted panel (large)</Panel>
          <Panel size="md" style={{ width: 300, padding: 24 }}>
            Frosted panel (medium)
          </Panel>
        </Section>

        <Section title="AppTile">
          <AppTile name="Zoom" description="Video meetings" mono="Z" running />
          <AppTile name="Tally" description="Accounts" mono="T" badge={3} />
          <AppTile name="Orders" description="Web portal" mono="O" />
        </Section>

        <Section title="TitleBar">
          <Panel
            size="md"
            style={{ width: 420, overflow: "hidden", background: "var(--rb-surface)", display: "flex", flexDirection: "column" }}
          >
            <TitleBar title="Files on this laptop" mono="F" />
            <div style={{ padding: 20, color: "var(--rb-muted)" }}>Window content</div>
          </Panel>
        </Section>
      </div>
    </div>
  );
}