//! The seam between the backend/enrollment code (Step 8) and the kiosk reconciler
//! (Step 9). Step 8 needs three things from the reconciler and nothing else:
//! "a new document arrived", "reconcile now and tell me how it went" (enrollment,
//! plan Section 5.4 step 7) and "run Disable" (unenrollment, Section 5.6).
//!
//! The real implementation is `kiosk::ReconcilerHandle`, backed by the reconciler's
//! `Trigger` channel. Tests use [`FakeKioskControl`].

use futures_util::future::BoxFuture;
#[cfg(test)]
use futures_util::FutureExt;
use rulebox_ipc::types::KioskStatus;

pub trait KioskControl: Send + Sync + 'static {
    /// A new desired state was accepted (`Trigger::DesiredChanged`). Never blocks.
    fn desired_changed(&self);

    /// Enrollment finished: reconcile now and answer with the kiosk status
    /// afterwards. The caller waits at most 120 seconds for it.
    fn reconcile_now(&self) -> BoxFuture<'static, KioskStatus>;

    /// Section 5.6 "Disable", for `unenroll`. `Err` carries a short reason; the
    /// caller then keeps the enrollment and the journal.
    fn disable(&self) -> BoxFuture<'static, Result<(), String>>;
}

/// A scripted reconciler for tests: counts what it is asked and answers as told.
#[cfg(test)]
pub struct FakeKioskControl {
    pub changed: std::sync::atomic::AtomicUsize,
    pub reconciles: std::sync::atomic::AtomicUsize,
    pub disables: std::sync::atomic::AtomicUsize,
    /// What `reconcile_now` answers.
    pub kiosk: std::sync::Mutex<KioskStatus>,
    /// `reconcile_now` never answers.
    pub hang_reconcile: std::sync::atomic::AtomicBool,
    /// `disable` fails with this reason.
    pub disable_error: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
impl FakeKioskControl {
    pub fn new() -> Self {
        use rulebox_ipc::types::KioskPhase;
        Self {
            changed: std::sync::atomic::AtomicUsize::new(0),
            reconciles: std::sync::atomic::AtomicUsize::new(0),
            disables: std::sync::atomic::AtomicUsize::new(0),
            kiosk: std::sync::Mutex::new(KioskStatus {
                enabled: true,
                phase: KioskPhase::Applied,
                error_code: None,
            }),
            hang_reconcile: std::sync::atomic::AtomicBool::new(false),
            disable_error: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl KioskControl for FakeKioskControl {
    fn desired_changed(&self) {
        self.changed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn reconcile_now(&self) -> BoxFuture<'static, KioskStatus> {
        use std::sync::atomic::Ordering;
        self.reconciles.fetch_add(1, Ordering::SeqCst);
        if self.hang_reconcile.load(Ordering::SeqCst) {
            return std::future::pending().boxed();
        }
        std::future::ready(crate::state::lock(&self.kiosk).clone()).boxed()
    }

    fn disable(&self) -> BoxFuture<'static, Result<(), String>> {
        self.disables.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let result = match crate::state::lock(&self.disable_error).clone() {
            Some(reason) => Err(reason),
            None => Ok(()),
        };
        std::future::ready(result).boxed()
    }
}
