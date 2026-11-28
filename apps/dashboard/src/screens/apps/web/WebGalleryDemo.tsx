import { useState } from "react";
import { Button, Panel, SegmentedControl } from "@rulebox/ui";
import { useForm } from "../../../lib/useForm";
import { BrowserRulesCard } from "../../AppBrowser";
import { initialValues, validateValues, type FormValues } from "../appForm";
import { blankDesktopDetail } from "../desktop/model";
import { SiteAccessPicker } from "./SiteAccessPicker";
import { useWebIcon } from "./useWebIcon";
import { blankWebDetail } from "./webAddress";
import { WebAppForm } from "./WebAppForm";

/** The design gallery's block for the website form: the site-access picker on a few addresses, the whole form, and the browser rules chips. */
const ADDRESSES = [
  { value: "https://shop.example.com/start", label: "shop.example.com" },
  { value: "https://www.example.com/", label: "www.example.com" },
  { value: "https://a.b.example.co.uk/", label: "a.b.example.co.uk" },
  { value: "https://example.com/", label: "example.com" },
  { value: "https://www.xn--bcher-kva.de/", label: "bücher.de" },
  { value: "https://203.0.113.5/", label: "An IP" },
  { value: "", label: "Empty" },
];

const heading = { margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" } as const;
const lead = { margin: "4px 0 20px", fontSize: 13.5, color: "var(--rb-muted)" } as const;

function PickerDemo() {
  const [url, setUrl] = useState(ADDRESSES[0]!.value);
  const [value, setValue] = useState<string[]>(["accounts.google.com"]);
  const [readOnly, setReadOnly] = useState(false);
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20, overflowX: "auto" }}>
        <SegmentedControl options={ADDRESSES} value={url} onChange={setUrl} aria-label="Example address" />
        <Button variant="ghost" onClick={() => setReadOnly((r) => !r)}>
          {readOnly ? "Make it editable" : "Make it read-only"}
        </Button>
      </div>
      <SiteAccessPicker url={url} value={value} onChange={setValue} disabled={readOnly} />
    </>
  );
}

function FormDemo() {
  const f = useForm<FormValues>(
    { ...initialValues(blankWebDetail(), "web"), url: "https://www.example.com/start", name: "Example Shop", hue: 150, domains: "example.com\naccounts.google.com" },
    (x) => validateValues("web", x),
  );
  const icon = useWebIcon();
  return (
    <>
      <WebAppForm
        d={blankWebDetail()}
        f={f}
        isNew
        readOnly={false}
        icon={icon}
        footer={
          <div className="web-bar">
            <Button type="button">Add website</Button>
          </div>
        }
      />
    </>
  );
}

function RulesDemo() {
  const f = useForm<FormValues>(
    { ...initialValues(blankDesktopDetail(), "desktop"), exe: "{ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe", sites: "portal.example.com\n*.cdn.example.com\nmail.example.org" },
    () => ({}),
  );
  return (
    <BrowserRulesCard f={f} />
  );
}

export function WebGalleryDemo() {
  return (
    <div id="gallery-web" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Panel size="md" style={{ padding: 28 }}>
        <h2 style={heading}>Site access picker</h2>
        <p style={lead}>Which pages of a website open: the address with its parts, the levels, other sites, and a live preview. Pick an address.</p>
        <PickerDemo />
      </Panel>
      <Panel size="md" style={{ padding: 28 }}>
        <h2 style={heading}>Website form</h2>
        <p style={lead}>Address, name, picker, preview, More options and Advanced. The site is read by itself (demo: a made-up name and icon).</p>
        <FormDemo />
      </Panel>
      <Panel size="md" style={{ padding: 28 }}>
        <h2 style={heading}>Browser rules (Chrome or Edge program)</h2>
        <p style={lead}>The allowed sites of a browser program as chips, with the plain list under Advanced.</p>
        <RulesDemo />
      </Panel>
    </div>
  );
}
