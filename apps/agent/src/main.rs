use rulebox_policy::{DesiredState, EXAMPLE_DESIRED_STATE_JSON};

// Stub only: replaced by proper error handling in Phase 2 Step 5.
#[allow(clippy::expect_used)]
fn main() {
    let state: DesiredState =
        serde_json::from_str(EXAMPLE_DESIRED_STATE_JSON).expect("PRD example desired state parses");
    println!(
        "rulebox-agent {}: desired state v{} OK",
        env!("CARGO_PKG_VERSION"),
        state.version
    );
}