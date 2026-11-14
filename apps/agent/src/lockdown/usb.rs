//! USB control per device class (plan 4.7a): the tables, as data, and the generator
//! that turns `lockdown.usb` into the deny lists the layers write.
//!
//! Two fixed constants, deliberately separate:
//!
//! * [`USB_CLASSES`]: group to setup classes. Only these classes can ever be denied,
//!   and only these can be removed by `usb.retroactive`.
//! * [`NEVER_BLOCK`]: keyboards, mice, touchpads, touch screens, pens, HID barcode
//!   scanners, USB hubs and root hubs, composite-device parents, Bluetooth and the
//!   device's built-in devices (owner rule 2026-11-08, invariant I10). Not a switch,
//!   not an exception kind: `UsbPolicy` has no key that can name them.
//!
//! [`generate`] builds the deny lists from the first; invariant I10
//! (`invariants.rs`) compares the generated lists, by class GUID **and** by compatible
//! ID, with the second on every apply, so a mistake in either table, or a list built
//! by hand, is refused before anything is written. Where a group applies (Staff hive
//! or the whole PC) is asked of `UsbGroup::scope()`, the one place that says so.
//!
//! The class GUIDs are Microsoft's setup-class GUIDs, copied at build time; the
//! compatible IDs are the USB class-code forms (`USB\Class_08`). Both are unverified
//! until the VM run and the real-laptop pilot (Step 21, plan Section 21).

use std::borrow::Cow;

use rulebox_policy::lockdown::{UsbGroup, UsbPolicy, UsbScope, UsbStorageMode, UsbSwitch};
use rulebox_policy::AgentDoc;

/// One device setup class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetupClass {
    pub name: &'static str,
    /// Lower-case, without braces.
    pub guid: &'static str,
    /// Compatible-ID patterns of USB devices that bind to this class (upper-case match).
    pub compatible_ids: &'static [&'static str],
    /// Whether `usb.retroactive` may remove already installed devices of this class.
    /// False for the disk classes: the machine's own disk is in them.
    pub retroactive_ok: bool,
}

const fn class(name: &'static str, guid: &'static str, compatible_ids: &'static [&'static str], retroactive_ok: bool) -> SetupClass {
    SetupClass { name, guid, compatible_ids, retroactive_ok }
}

const DISK_DRIVE: SetupClass = class("DiskDrive", "4d36e967-e325-11ce-bfc1-08002be10318", &[r"USB\CLASS_08"], false);
const CDROM: SetupClass = class("CDROM", "4d36e965-e325-11ce-bfc1-08002be10318", &[], false);
const WPD: SetupClass = class("WPD", "eec5ad98-8080-425f-922a-dabf3de3f69a", &[], true);
const PRINTER: SetupClass = class("Printer", "4d36e979-e325-11ce-bfc1-08002be10318", &[r"USB\CLASS_07"], true);
const IMAGE: SetupClass = class("Image", "6bdd1fc6-810f-11d0-bec7-08002be2092f", &[r"USB\CLASS_06"], true);
const CAMERA: SetupClass = class("Camera", "ca3e7ab9-b4c3-4ae6-8251-579ef933890f", &[r"USB\CLASS_0E"], true);
const PORTS: SetupClass = class("Ports", "4d36e978-e325-11ce-bfc1-08002be10318", &[], true);
const MODEM: SetupClass = class("Modem", "4d36e96d-e325-11ce-bfc1-08002be10318", &[], true);
const INFRARED: SetupClass = class("Infrared", "6bdd1fc5-810f-11d0-bec7-08002be2092f", &[], true);
const IEEE_1394: SetupClass = class("1394", "6bdd1fc1-810f-11d0-bec7-08002be2092f", &[], true);

/// Group to setup classes (plan 4.7a). `other` is a fixed list of known unwanted
/// classes, not a catch-all; network adapters are not in it (edge case 65).
pub const USB_CLASSES: &[(UsbGroup, &[SetupClass])] = &[
    (UsbGroup::Storage, &[DISK_DRIVE, CDROM]),
    (UsbGroup::Printers, &[PRINTER]),
    (UsbGroup::Imaging, &[IMAGE, CAMERA]),
    (UsbGroup::Phones, &[WPD]),
    (UsbGroup::Other, &[PORTS, MODEM, INFRARED, IEEE_1394]),
];

/// The Windows Portable Devices GUIDs of the Staff-hive removable-storage policy
/// (`RemovableStorageDevices\{GUID}\Deny_Read/Deny_Write`, plan 4.7; unverified).
pub const STAFF_WPD_GUIDS: &[&str] = &["{6AC27878-A6FA-4155-BA85-F98F491D4F33}", "{F33FDC04-D1AC-4E8E-9A30-19BBD4B108AE}"];

/// One entry of [`NEVER_BLOCK`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NeverBlock {
    pub name: &'static str,
    /// Setup class GUID, lower-case, without braces.
    pub guid: Option<&'static str>,
    /// Compatible-ID patterns (upper-case). A pattern ending in `\` stands for the whole
    /// enumerator; otherwise it matches itself and everything that continues it after `&`.
    pub compatible_ids: &'static [&'static str],
}

const fn never(name: &'static str, guid: Option<&'static str>, compatible_ids: &'static [&'static str]) -> NeverBlock {
    NeverBlock { name, guid, compatible_ids }
}

/// Everything no Rulebox policy may block or remove (invariant I10, owner rule
/// 2026-11-08). Fixed in code; there is no switch for any of it.
pub const NEVER_BLOCK: &[NeverBlock] = &[
    // Keyboards, mice, touchpads, touch screens, pens, HID barcode scanners (wedge).
    never("HIDClass", Some("745a17a0-74d3-11d0-b6fe-00a0c90f57da"), &[r"USB\CLASS_03", r"HID\"]),
    never("Keyboard", Some("4d36e96b-e325-11ce-bfc1-08002be10318"), &[]),
    never("Mouse", Some("4d36e96f-e325-11ce-bfc1-08002be10318"), &[]),
    // USB hubs, root hubs, host controllers and composite-device parents are class USB.
    never(
        "USB",
        Some("36fc9e60-c465-11cf-8056-444553540000"),
        &[
            r"USB\CLASS_09",
            r"USB\COMPOSITE",
            r"USB\ROOT_HUB",
            r"USB\ROOT_HUB20",
            r"USB\ROOT_HUB30",
            r"USB\USB20_HUB",
            r"USB\USB30_HUB",
        ],
    ),
    // Bluetooth radios, Bluetooth keyboards and mice.
    never("Bluetooth", Some("e0cbf06c-cd8b-4647-bb8a-263b43f0f974"), &[r"USB\CLASS_E0", r"BTHENUM\", r"BTHLE\", r"BTH\"]),
    // The device's own built-in devices.
    never("System", Some("4d36e97d-e325-11ce-bfc1-08002be10318"), &[r"ACPI\", r"ROOT\", r"PCI\"]),
    never("Display", Some("4d36e968-e325-11ce-bfc1-08002be10318"), &[]),
    never("Monitor", Some("4d36e96e-e325-11ce-bfc1-08002be10318"), &[]),
    never("Computer", Some("4d36e966-e325-11ce-bfc1-08002be10318"), &[]),
    never("Processor", Some("50127dc3-0f36-415e-a6cc-4cb3be910b65"), &[]),
    never("HDC", Some("4d36e96a-e325-11ce-bfc1-08002be10318"), &[]),
    never("SCSIAdapter", Some("4d36e97b-e325-11ce-bfc1-08002be10318"), &[]),
    never("Battery", Some("72631e54-78a4-11d0-bcf7-00aa00b7b32a"), &[]),
    never("Biometric", Some("53d29ef7-377c-4d14-864b-eb3a85769359"), &[]),
    // A USB headset keeps its audio (the HID buttons are HIDClass above).
    never("Media", Some("4d36e96c-e325-11ce-bfc1-08002be10318"), &[]),
];

// ---------------------------------------------------------------- matching

/// A class GUID as the comparison key: lower-case, no braces, no spaces.
pub fn norm_guid(guid: &str) -> String {
    guid.trim().trim_matches(|c| c == '{' || c == '}').to_ascii_lowercase()
}

fn norm_id(id: &str) -> String {
    id.trim().to_ascii_uppercase()
}

/// `shorter` covers `longer`: equal, or `longer` continues `shorter` after `&` or `\`
/// (or `shorter` is a whole enumerator ending in `\`). Whole components only, so
/// `USB\CLASS_0` does not cover `USB\CLASS_08`.
fn covers(shorter: &str, longer: &str) -> bool {
    if shorter == longer {
        return true;
    }
    if !longer.starts_with(shorter) {
        return false;
    }
    shorter.ends_with('\\') || matches!(longer.as_bytes().get(shorter.len()), Some(b'&' | b'\\'))
}

/// Two compatible-ID patterns refer to some same device when one covers the other.
pub fn compatible_ids_collide(a: &str, b: &str) -> bool {
    let (a, b) = (norm_id(a), norm_id(b));
    !a.is_empty() && !b.is_empty() && (covers(&a, &b) || covers(&b, &a))
}

/// The never-block entry a class GUID or compatible ID falls into, if any.
pub fn never_block_hit(class_guid: &str, compatible_ids: &[String]) -> Option<&'static NeverBlock> {
    let guid = norm_guid(class_guid);
    NEVER_BLOCK.iter().find(|entry| {
        entry.guid.is_some_and(|g| g == guid)
            || compatible_ids.iter().any(|id| entry.compatible_ids.iter().any(|pattern| compatible_ids_collide(id, pattern)))
    })
}

// ---------------------------------------------------------------- generated tables

/// One class in a deny list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenyClass {
    pub group: UsbGroup,
    pub name: String,
    /// Lower-case, no braces.
    pub guid: String,
    pub compatible_ids: Vec<String>,
    /// May `usb.retroactive` remove installed devices of this class?
    pub retroactive_ok: bool,
}

/// How the Staff-hive removable-storage policy treats storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaffStorage {
    ReadOnly,
    Block,
}

/// The Staff-scope part: the removable-storage policy of 4.7.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StaffUsbRules {
    pub storage: Option<StaffStorage>,
    /// The `RemovableStorageDevices\{GUID}` subkeys denied (phones), braces included.
    pub wpd_guids: Vec<String>,
}

/// Everything `lockdown.usb` makes the layers write: the machine-wide deny classes
/// (`DeviceInstall\Restrictions`, 4.8), the Staff-hive rules (4.7) and whether
/// installed devices of the machine classes are removed too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DenyTables {
    pub machine: Vec<DenyClass>,
    pub staff: StaffUsbRules,
    pub retroactive: bool,
}

/// The classes of a group (empty for a group not in [`USB_CLASSES`]).
pub fn classes_of(group: UsbGroup) -> &'static [SetupClass] {
    USB_CLASSES.iter().find(|(g, _)| *g == group).map_or(&[], |(_, classes)| *classes)
}

fn push_group(out: &mut Vec<DenyClass>, group: UsbGroup) {
    for class in classes_of(group) {
        out.push(DenyClass {
            group,
            name: class.name.to_string(),
            guid: class.guid.to_string(),
            compatible_ids: class.compatible_ids.iter().map(|id| (*id).to_string()).collect(),
            retroactive_ok: class.retroactive_ok,
        });
    }
}

/// Builds the deny lists from the document, using the real scope rule.
pub fn generate(policy: &UsbPolicy) -> DenyTables {
    generate_with(policy, UsbGroup::scope)
}

/// [`generate`] with the scope rule given, so a test can prove that the lists stay
/// clean of input devices if the owner moves a group to the other scope. Only storage
/// and phones have a Staff-hive mechanism; the other groups are machine-wide always.
pub fn generate_with(policy: &UsbPolicy, scope: impl Fn(UsbGroup) -> UsbScope) -> DenyTables {
    let mut tables = DenyTables { retroactive: policy.retroactive, ..DenyTables::default() };
    match policy.storage {
        UsbStorageMode::ReadOnly => tables.staff.storage = Some(StaffStorage::ReadOnly),
        UsbStorageMode::Block => match scope(UsbGroup::Storage) {
            UsbScope::Staff => tables.staff.storage = Some(StaffStorage::Block),
            UsbScope::Machine => push_group(&mut tables.machine, UsbGroup::Storage),
        },
        UsbStorageMode::Allow | UsbStorageMode::Unknown => {}
    }
    if policy.phones == UsbSwitch::Block {
        match scope(UsbGroup::Phones) {
            UsbScope::Staff => tables.staff.wpd_guids = STAFF_WPD_GUIDS.iter().map(|g| (*g).to_string()).collect(),
            UsbScope::Machine => push_group(&mut tables.machine, UsbGroup::Phones),
        }
    }
    for (group, switch) in
        [(UsbGroup::Printers, policy.printers), (UsbGroup::Imaging, policy.imaging), (UsbGroup::Other, policy.other)]
    {
        if switch == UsbSwitch::Block {
            push_group(&mut tables.machine, group);
        }
    }
    tables
}

impl DenyTables {
    /// The classes `usb.retroactive` removes installed devices of: the machine deny
    /// classes that allow it, and only when the flag is on.
    pub fn retroactive_classes(&self) -> Vec<&DenyClass> {
        if self.retroactive {
            self.machine.iter().filter(|class| class.retroactive_ok).collect()
        } else {
            Vec::new()
        }
    }

    /// Every class GUID the tables name anywhere (machine classes, the retroactive
    /// list and the Staff-hive WPD subkeys), normalised.
    pub fn all_guids(&self) -> Vec<String> {
        let mut guids: Vec<String> = self.machine.iter().map(|class| norm_guid(&class.guid)).collect();
        guids.extend(self.retroactive_classes().iter().map(|class| norm_guid(&class.guid)));
        guids.extend(self.staff.wpd_guids.iter().map(|guid| norm_guid(guid)));
        guids
    }

    /// Every place the tables intersect [`NEVER_BLOCK`], by class GUID and by
    /// compatible ID. Empty when the tables are safe. Fixed texts: names, not values.
    pub fn input_device_conflicts(&self) -> Vec<String> {
        let mut found = Vec::new();
        let mut note = |what: &str, name: &str, hit: &NeverBlock| found.push(format!("{what} {name} reaches {}", hit.name));
        for class in &self.machine {
            if let Some(hit) = never_block_hit(&class.guid, &class.compatible_ids) {
                note("deny class", &class.name, hit);
            }
        }
        for class in self.retroactive_classes() {
            if let Some(hit) = never_block_hit(&class.guid, &class.compatible_ids) {
                note("retroactive class", &class.name, hit);
            }
        }
        for guid in &self.staff.wpd_guids {
            if let Some(hit) = never_block_hit(guid, &[]) {
                note("Staff-hive class", guid, hit);
            }
        }
        found
    }

    /// Windows' install restriction: a device is refused when the setup class of one of
    /// its functions is in the machine deny list. Class only, as Windows does it.
    pub fn blocks_machine(&self, function: &DeviceFunction) -> bool {
        let guid = norm_guid(&function.class_guid);
        self.machine.iter().any(|class| norm_guid(&class.guid) == guid)
    }

    /// The Staff-hive policy: storage functions on a USB device, and WPD functions.
    pub fn blocks_for_staff(&self, function: &DeviceFunction) -> bool {
        let guid = norm_guid(&function.class_guid);
        let storage = [DISK_DRIVE, CDROM].iter().any(|class| class.guid == guid);
        let portable = WPD.guid == guid;
        (storage && self.staff.storage.is_some()) || (portable && !self.staff.wpd_guids.is_empty())
    }
}

// ---------------------------------------------------------------- devices (for the tests and Step 5)

/// One function of a (possibly composite) device: the child that has its own class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFunction {
    pub class_guid: String,
    pub compatible_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceBus {
    Usb,
    Bluetooth,
    BuiltIn,
    Other,
}

/// A device that is installed now (what retroactive removal looks at).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledDevice {
    pub instance_id: String,
    pub class_guid: String,
    pub compatible_ids: Vec<String>,
    pub bus: DeviceBus,
}

/// The installed devices `usb.retroactive` may remove. Defence in depth on top of the
/// invariant: only USB devices, only a class of the tables that allows it, and never
/// anything that falls into [`NEVER_BLOCK`] by class or compatible ID.
pub fn retroactive_targets<'a>(tables: &DenyTables, devices: &'a [InstalledDevice]) -> Vec<&'a InstalledDevice> {
    let classes = tables.retroactive_classes();
    devices
        .iter()
        .filter(|device| device.bus == DeviceBus::Usb)
        .filter(|device| never_block_hit(&device.class_guid, &device.compatible_ids).is_none())
        .filter(|device| classes.iter().any(|class| norm_guid(&class.guid) == norm_guid(&device.class_guid)))
        .collect()
}

// ---------------------------------------------------------------- temporary allow (Step 5)

/// The document as the layers see it: while a `usbTempAllow` is running, the USB class
/// blocks are lifted for this PC (`lockdown.usb` becomes "everything allowed, nothing
/// retroactive"). It only ever *removes* rules; it cannot add one, and it cannot touch
/// anything outside `lockdown.usb`. The caller applies this on every apply, so the
/// deny keys come back by themselves when the allow has ended.
pub fn with_temp_allow(doc: &AgentDoc, now_ms: u64) -> Cow<'_, AgentDoc> {
    let active = doc.usb_temp_allow.is_some_and(|allow| allow.effective_until(now_ms).is_some());
    match &doc.lockdown {
        Some(lockdown) if active && lockdown.usb != UsbPolicy::default() => {
            let mut lifted = doc.clone();
            if let Some(lockdown) = lifted.lockdown.as_mut() {
                lockdown.usb = UsbPolicy::default();
            }
            Cow::Owned(lifted)
        }
        _ => Cow::Borrowed(doc),
    }
}

/// When the running temporary allow ends (Unix ms), if one is running: the moment the
/// agent's own timer re-applies the document (no polling of the server). `None` when
/// there is no allow or it has already ended.
pub fn temp_allow_deadline(doc: &AgentDoc, now_ms: u64) -> Option<u64> {
    doc.usb_temp_allow.and_then(|allow| allow.effective_until(now_ms))
}

#[cfg(test)]
pub(in crate::lockdown) mod tests;
