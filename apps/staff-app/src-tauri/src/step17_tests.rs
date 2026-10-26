//! Step 17 tests: app icons leave the broadcast state for the icon store.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use rulebox_staff_lib::tasks::IconStore;

/// A real (1x1) PNG as base64.
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

#[test]
fn an_app_icon_becomes_a_short_address_that_serves_the_same_png() {
    let store = IconStore::default();
    let url = store.intern_app_icon(&format!("data:image/png;base64,{PNG_B64}")).expect("a url");
    assert!(url.starts_with("http://rbicon.localhost/app:"), "{url}");
    assert!(url.len() < 60, "the catalogue must not carry the icon: {url}");

    let key = url.trim_start_matches("http://rbicon.localhost/");
    let png = store.render(key, 48).expect("the stored icon");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn the_same_icon_gets_the_same_address_and_a_different_one_a_different_address() {
    let store = IconStore::default();
    let data = format!("data:image/png;base64,{PNG_B64}");
    let again = store.intern_app_icon(&data);
    assert_eq!(store.intern_app_icon(&data), again);
    // Different content (a changed character in the middle still decodes).
    let changed = PNG_B64.replacen("AAAABC", "AAAACC", 1);
    assert_ne!(changed, PNG_B64);
    let other = store.intern_app_icon(&format!("data:image/png;base64,{changed}"));
    assert!(other.is_some());
    assert_ne!(other, again);
}

#[test]
fn only_png_data_urls_that_decode_are_taken() {
    let store = IconStore::default();
    assert_eq!(store.intern_app_icon("https://example.com/x.png"), None);
    assert_eq!(store.intern_app_icon("data:image/svg+xml;base64,PHN2Zz4="), None);
    assert_eq!(store.intern_app_icon("data:image/png;base64,@@@not-base64@@@"), None);
    // An address nobody stored serves nothing.
    assert!(store.render("app:0000000000000000", 48).is_none());
}
