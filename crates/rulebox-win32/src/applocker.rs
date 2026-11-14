//! AppLocker (plan 4.5, 4.9, Step 7).
//!
//! Two ways to install a policy, both **unverified** until the VM run of Step 21 (plan
//! Section 21: which of them Windows Pro honours, and whether the rules reach processes the
//! SYSTEM service starts):
//!
//! * [`Mechanism::Local`] writes the rules where the local policy lives, below
//!   `HKLM\SOFTWARE\Policies\Microsoft\Windows\SrpV2`: one key per rule collection holding
//!   `EnforcementMode`, one subkey per rule (named by the rule id) holding the rule element
//!   as the value `Value`. `get_policy` reads the same layout.
//! * [`Mechanism::Csp`] goes through the MDM bridge (`root\cimv2\mdm\dmmap`): one instance of
//!   the AppLocker CSP class per rule collection, the collection XML in its `Policy`
//!   property. The class and parent names below follow the CSP documentation and are the
//!   first thing to fix if the VM says otherwise.
//!
//! The pure part, [`check_policy`], splits a policy XML into its collections and rules and
//! refuses what Rulebox never installs (the DLL collection, an element it does not know).
//! The XML is Rulebox's own, produced by the agent; this is a splitter for that shape, not a
//! general XML parser.

use std::mem::ManuallyDrop;

use windows::core::{BSTR, PCWSTR};
use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BSTR};
use windows::Win32::System::Wmi::{IWbemClassObject, IWbemContext, IWbemServices, WBEM_GENERIC_FLAG_TYPE};

use crate::error::{Result, Win32Error};
use crate::guard::require_test_machine;
use crate::registry::{count_hklm_subkeys, delete_hklm_tree, get_hklm, set_hklm, RegValue};
use crate::wmi::{hr_err, with_services};

/// Which AppLocker management path carries a policy (plan 4.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mechanism {
    /// The MDM bridge (`AppLocker` CSP).
    Csp,
    /// The local policy store.
    Local,
}

/// `SOFTWARE\Policies\Microsoft\Windows\SrpV2`: the local AppLocker policy, one subkey per
/// rule collection, one subkey per rule below it.
const SRP_V2: &str = r"SOFTWARE\Policies\Microsoft\Windows\SrpV2";
/// The rule collections AppLocker knows (what [`get_policy`] reports).
const COLLECTIONS: &[&str] = &["Exe", "Msi", "Script", "Dll", "Appx"];
/// The rule collections Rulebox writes. `Dll` is never among them (plan 4.9: it costs too
/// much on a 4 GB laptop).
pub const WRITTEN_COLLECTIONS: &[&str] = &["Exe", "Msi", "Script", "Appx"];
const APP_ID_SERVICE_KEY: &str = r"SYSTEM\CurrentControlSet\Services\AppIDSvc";

/// `EnforcementMode` values of the local policy store.
pub const ENFORCE_AUDIT_ONLY: u32 = 0;
pub const ENFORCE_ENABLED: u32 = 1;

/// The WMI namespace of the MDM bridge, the AppLocker CSP node that holds Rulebox's
/// instances and the instance id the rules of a collection are saved under.
const MDM_NAMESPACE: &str = r"ROOT\cimv2\mdm\dmmap";
const CSP_PARENT_ID: &str = "./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/Rulebox";

/// One rule collection of the installed policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionState {
    pub name: String,
    /// `EnforcementMode`: 0 audit only, 1 enforce; `None` when not set.
    pub enforcement: Option<u32>,
    pub rules: u32,
}

/// What the local policy store holds (the foreign-policy check of Step 7 reads it).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AppLockerState {
    /// Only collections that exist.
    pub collections: Vec<CollectionState>,
    /// The Application Identity service's start type (AppLocker needs it running).
    pub app_id_svc_start: Option<u32>,
}

impl AppLockerState {
    /// Any rule at all.
    pub fn has_rules(&self) -> bool {
        self.collections.iter().any(|collection| collection.rules > 0)
    }
}

/// Reads the local AppLocker policy store. Read-only.
pub fn get_policy() -> Result<AppLockerState> {
    let mut state = AppLockerState::default();
    for name in COLLECTIONS {
        let path = format!(r"{SRP_V2}\{name}");
        let Some(rules) = count_hklm_subkeys(&path)? else {
            continue;
        };
        let enforcement = match get_hklm(&path, "EnforcementMode")? {
            Some(RegValue::Dword(mode)) => Some(mode),
            _ => None,
        };
        state.collections.push(CollectionState { name: (*name).to_string(), enforcement, rules });
    }
    state.app_id_svc_start = match get_hklm(APP_ID_SERVICE_KEY, "Start")? {
        Some(RegValue::Dword(start)) => Some(start),
        _ => None,
    };
    Ok(state)
}

// ---------------------------------------------------------------- the policy XML (pure)

/// One rule of a collection: its id and its element, as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleXml {
    pub id: String,
    pub xml: String,
}

/// One rule collection of a policy XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    /// `Exe`, `Msi`, `Script` or `Appx`.
    pub name: String,
    /// [`ENFORCE_AUDIT_ONLY`] or [`ENFORCE_ENABLED`].
    pub enforcement: u32,
    pub rules: Vec<RuleXml>,
    /// The whole `<RuleCollection>` element (what the CSP's `Policy` property carries).
    pub xml: String,
}

const RULE_ELEMENTS: &[&str] = &["FilePathRule", "FilePublisherRule", "FileHashRule"];

/// The value of attribute `name` in the opening tag text `tag`.
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn invalid(text: &str) -> Win32Error {
    Win32Error::Invalid(text.to_string())
}

fn is_guid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// Splits `xml` into its rule collections. Refuses anything Rulebox would not install: no
/// `<AppLockerPolicy>` root, a DLL collection, an enforcement mode other than `AuditOnly` or
/// `Enabled`, an element that is not a path, publisher or hash rule, a rule without a GUID id,
/// or the same id twice. A policy with no collection is fine (it removes nothing and adds
/// nothing). Pure: no API call, no guard.
pub fn check_policy(xml: &str) -> Result<Vec<Collection>> {
    if xml.trim().is_empty() {
        return Err(invalid("an empty AppLocker policy"));
    }
    let root = xml.find("<AppLockerPolicy").ok_or_else(|| invalid("no <AppLockerPolicy> element"))?;
    let body = &xml[root..];
    let mut collections: Vec<Collection> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    let mut at = 0;
    while let Some(found) = body[at..].find("<RuleCollection ") {
        let start = at + found;
        let tag_end = body[start..].find('>').ok_or_else(|| invalid("an unterminated <RuleCollection>"))? + start;
        let tag = &body[start..=tag_end];
        let name = attribute(tag, "Type").ok_or_else(|| invalid("a rule collection without Type"))?;
        if !WRITTEN_COLLECTIONS.contains(&name) {
            return Err(Win32Error::Forbidden(format!("the rule collection {name:?} is not one Rulebox installs")));
        }
        if collections.iter().any(|c| c.name == name) {
            return Err(invalid("a rule collection twice"));
        }
        let enforcement = match attribute(tag, "EnforcementMode") {
            Some("AuditOnly") => ENFORCE_AUDIT_ONLY,
            Some("Enabled") => ENFORCE_ENABLED,
            _ => return Err(invalid("EnforcementMode must be AuditOnly or Enabled")),
        };
        let (inner, end) = if tag.ends_with("/>") {
            ("", tag_end + 1)
        } else {
            let close = body[tag_end..].find("</RuleCollection>").ok_or_else(|| invalid("a rule collection is not closed"))? + tag_end;
            (&body[tag_end + 1..close], close + "</RuleCollection>".len())
        };
        let mut rules = Vec::new();
        let mut cursor = 0;
        while let Some(open) = inner[cursor..].find('<') {
            let open = cursor + open;
            let rest = &inner[open..];
            let element: String = rest[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if !RULE_ELEMENTS.contains(&element.as_str()) {
                return Err(Win32Error::Forbidden(format!("the element {element:?} is not a rule Rulebox installs")));
            }
            let close_tag = format!("</{element}>");
            let close = rest.find(&close_tag).ok_or_else(|| invalid("a rule element is not closed"))?;
            let rule = &rest[..close + close_tag.len()];
            let id = attribute(&rest[..rest.find('>').unwrap_or(rest.len())], "Id").ok_or_else(|| invalid("a rule without Id"))?;
            if !is_guid(id) {
                return Err(invalid("a rule id is not a GUID"));
            }
            if seen_ids.iter().any(|seen| seen == id) {
                return Err(invalid("a rule id twice"));
            }
            seen_ids.push(id.to_string());
            rules.push(RuleXml { id: id.to_string(), xml: rule.to_string() });
            cursor = open + rule.len();
        }
        collections.push(Collection { name: name.to_string(), enforcement, rules, xml: body[start..end].to_string() });
        at = end;
    }
    Ok(collections)
}

// ---------------------------------------------------------------- the writers

/// Installs a policy XML through `mechanism`. A collection the XML does not have is removed
/// (the policy replaces whatever Rulebox installed before).
///
/// DESTRUCTIVE: guarded.
pub fn set_policy(xml: &str, mechanism: Mechanism) -> Result<()> {
    let collections = check_policy(xml)?;
    require_test_machine()?;
    match mechanism {
        Mechanism::Local => set_local(&collections),
        Mechanism::Csp => set_csp(&collections),
    }
}

/// Removes the policy that `mechanism` carries.
///
/// DESTRUCTIVE: guarded.
pub fn clear_policy(mechanism: Mechanism) -> Result<()> {
    require_test_machine()?;
    match mechanism {
        Mechanism::Local => clear_local(),
        Mechanism::Csp => clear_csp(),
    }
}

fn collection_key(name: &str) -> Result<String> {
    // Only the four collections Rulebox writes ever reach a key name.
    if WRITTEN_COLLECTIONS.contains(&name) {
        Ok(format!(r"{SRP_V2}\{name}"))
    } else {
        Err(Win32Error::Forbidden(format!("the rule collection {name:?} is not one Rulebox installs")))
    }
}

fn clear_local() -> Result<()> {
    for name in WRITTEN_COLLECTIONS {
        delete_hklm_tree(&collection_key(name)?)?;
    }
    Ok(())
}

fn set_local(collections: &[Collection]) -> Result<()> {
    clear_local()?;
    for collection in collections {
        let key = collection_key(&collection.name)?;
        set_hklm(&key, "EnforcementMode", Some(&RegValue::Dword(collection.enforcement)))?;
        for rule in &collection.rules {
            set_hklm(&format!(r"{key}\{}", rule.id), "Value", Some(&RegValue::String(rule.xml.clone())))?;
        }
    }
    Ok(())
}

/// The CSP leaf (instance id) and the WMI class of a collection.
fn csp_names(collection: &str) -> (&'static str, &'static str) {
    match collection {
        "Exe" => ("EXE", "MDM_AppLocker_ApplicationLaunchRestrictions01_EXE03"),
        "Msi" => ("MSI", "MDM_AppLocker_ApplicationLaunchRestrictions01_MSI03"),
        "Script" => ("Script", "MDM_AppLocker_ApplicationLaunchRestrictions01_Script03"),
        _ => ("StoreApps", "MDM_AppLocker_ApplicationLaunchRestrictions01_StoreApps03"),
    }
}

/// A `VARIANT` holding a BSTR, cleared (and the string freed) on drop.
struct BstrVariant(VARIANT);

impl BstrVariant {
    fn new(text: &str) -> Self {
        let mut variant = VARIANT::default();
        // SAFETY: the variant was just created empty; the type tag is set together with the
        // member it selects, and `VariantClear` (in `drop`) frees the string.
        unsafe {
            let inner = &mut *variant.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(text));
        }
        Self(variant)
    }
}

impl Drop for BstrVariant {
    fn drop(&mut self) {
        // SAFETY: the variant is owned by this value and cleared once.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

fn put_property(object: &IWbemClassObject, name: &str, value: &str) -> Result<()> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let variant = BstrVariant::new(value);
    // SAFETY: `wide` is NUL-terminated and outlives the call; the variant is valid.
    unsafe { object.Put(PCWSTR(wide.as_ptr()), 0, &variant.0, 0) }.map_err(|e| hr_err("IWbemClassObject::Put", &e))
}

fn csp_put(services: &IWbemServices, collection: &Collection) -> Result<()> {
    let (leaf, class) = csp_names(&collection.name);
    // SAFETY: every pointer is a live local or null where the API allows it.
    unsafe {
        let mut class_object: Option<IWbemClassObject> = None;
        services
            .GetObject(&BSTR::from(class), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, Some(&mut class_object), None)
            .map_err(|e| hr_err("IWbemServices::GetObject", &e))?;
        let class_object = class_object.ok_or(Win32Error::NotFound)?;
        let instance = class_object.SpawnInstance(0).map_err(|e| hr_err("IWbemClassObject::SpawnInstance", &e))?;
        put_property(&instance, "ParentID", CSP_PARENT_ID)?;
        put_property(&instance, "InstanceID", leaf)?;
        put_property(&instance, "Policy", &collection.xml)?;
        services
            .PutInstance(&instance, WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, None)
            .map_err(|e| hr_err("IWbemServices::PutInstance", &e))
    }
}

/// `WBEM_E_NOT_FOUND`: there is no such instance.
const WBEM_E_NOT_FOUND: u32 = 0x8004_1002;

fn csp_delete(services: &IWbemServices, collection: &str) -> Result<()> {
    let (leaf, class) = csp_names(collection);
    let path = format!("{class}.ParentID=\"{CSP_PARENT_ID}\",InstanceID=\"{leaf}\"");
    // SAFETY: the path is a live BSTR; the optional arguments are null.
    let result = unsafe { services.DeleteInstance(&BSTR::from(path), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, None) };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.code().0 as u32 == WBEM_E_NOT_FOUND => Ok(()),
        Err(e) => Err(hr_err("IWbemServices::DeleteInstance", &e)),
    }
}

fn set_csp(collections: &[Collection]) -> Result<()> {
    with_services(MDM_NAMESPACE, |services| {
        for name in WRITTEN_COLLECTIONS {
            match collections.iter().find(|c| c.name == *name) {
                Some(collection) => csp_put(services, collection)?,
                None => csp_delete(services, name)?,
            }
        }
        Ok(())
    })
}

fn clear_csp() -> Result<()> {
    with_services(MDM_NAMESPACE, |services| {
        for name in WRITTEN_COLLECTIONS {
            csp_delete(services, name)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "11111111-2222-3333-4444-555555555555";
    const ID_B: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn sample() -> String {
        format!(
            "<AppLockerPolicy Version=\"1\">\n  <RuleCollection Type=\"Exe\" EnforcementMode=\"AuditOnly\">\n    \
             <FilePathRule Id=\"{ID_A}\" Name=\"a\" Description=\"\" UserOrGroupSid=\"S-1-5-32-544\" Action=\"Allow\">\n      \
             <Conditions><FilePathCondition Path=\"*\"/></Conditions>\n    </FilePathRule>\n    \
             <FileHashRule Id=\"{ID_B}\" Name=\"b\" Description=\"\" UserOrGroupSid=\"S-1-1-0\" Action=\"Allow\"><Conditions/></FileHashRule>\n  \
             </RuleCollection>\n  <RuleCollection Type=\"Appx\" EnforcementMode=\"Enabled\"/>\n</AppLockerPolicy>\n"
        )
    }

    #[test]
    fn a_policy_splits_into_its_collections_and_rules() {
        let collections = check_policy(&sample()).unwrap();
        assert_eq!(collections.len(), 2);
        assert_eq!((collections[0].name.as_str(), collections[0].enforcement), ("Exe", ENFORCE_AUDIT_ONLY));
        assert_eq!(collections[0].rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [ID_A, ID_B]);
        assert!(collections[0].rules[0].xml.starts_with("<FilePathRule ") && collections[0].rules[0].xml.ends_with("</FilePathRule>"));
        assert!(collections[0].xml.starts_with("<RuleCollection Type=\"Exe\"") && collections[0].xml.ends_with("</RuleCollection>"));
        assert_eq!((collections[1].name.as_str(), collections[1].enforcement, collections[1].rules.len()), ("Appx", ENFORCE_ENABLED, 0));
        // No collection at all is a policy that installs nothing.
        assert_eq!(check_policy("<AppLockerPolicy/>").unwrap(), Vec::new());
    }

    #[test]
    fn what_rulebox_never_installs_is_refused_before_the_guard() {
        let refused = [
            ("", "empty"),
            ("<Policy/>", "no root"),
            ("<AppLockerPolicy><RuleCollection Type=\"Dll\" EnforcementMode=\"Enabled\"/></AppLockerPolicy>", "dll collection"),
            ("<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"NotConfigured\"/></AppLockerPolicy>", "mode"),
            ("<AppLockerPolicy><RuleCollection Type=\"Exe\"/></AppLockerPolicy>", "no mode"),
            ("<AppLockerPolicy><RuleCollection EnforcementMode=\"Enabled\"/></AppLockerPolicy>", "no type"),
            (
                "<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"><Evil Id=\"x\"></Evil></RuleCollection></AppLockerPolicy>",
                "unknown element",
            ),
            (
                "<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"><FilePathRule Id=\"nope\"></FilePathRule></RuleCollection></AppLockerPolicy>",
                "bad id",
            ),
            (
                "<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"><FilePathRule Id=\"11111111-2222-3333-4444-555555555555\"></RuleCollection></AppLockerPolicy>",
                "unclosed rule",
            ),
        ];
        for (xml, why) in refused {
            assert!(check_policy(xml).is_err(), "{why}");
            assert!(set_policy(xml, Mechanism::Local).is_err(), "{why}");
        }
        let twice = format!(
            "<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"><FilePathRule Id=\"{ID_A}\"></FilePathRule><FilePathRule Id=\"{ID_A}\"></FilePathRule></RuleCollection></AppLockerPolicy>"
        );
        assert!(check_policy(&twice).is_err());
        let dup = "<AppLockerPolicy><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"/><RuleCollection Type=\"Exe\" EnforcementMode=\"Enabled\"/></AppLockerPolicy>";
        assert!(check_policy(dup).is_err());
        assert!(!WRITTEN_COLLECTIONS.contains(&"Dll"));
        assert!(collection_key("Dll").is_err() && collection_key(r"Exe\..\x").is_err());
    }

    #[test]
    fn writers_meet_the_guard_first_on_the_dev_machine() {
        if crate::guard::is_test_machine() {
            return;
        }
        assert!(matches!(set_policy("<AppLockerPolicy/>", Mechanism::Local), Err(Win32Error::Guard(_))));
        assert!(matches!(set_policy(&sample(), Mechanism::Csp), Err(Win32Error::Guard(_))));
        assert!(matches!(set_policy(&sample(), Mechanism::Local), Err(Win32Error::Guard(_))));
        assert!(matches!(clear_policy(Mechanism::Csp), Err(Win32Error::Guard(_))));
        assert!(matches!(clear_policy(Mechanism::Local), Err(Win32Error::Guard(_))));
    }

    #[test]
    fn the_csp_names_cover_the_four_collections() {
        let names: Vec<_> = WRITTEN_COLLECTIONS.iter().map(|c| csp_names(c)).collect();
        assert_eq!(names.len(), 4);
        assert!(names.iter().all(|(leaf, class)| !leaf.is_empty() && class.starts_with("MDM_AppLocker_")));
    }

    /// Reads the real policy store; never writes. Run by hand.
    #[test]
    #[ignore = "reads the real AppLocker policy store"]
    fn smoke_get_policy() {
        let state = get_policy().unwrap();
        println!("{state:?}");
    }
}
