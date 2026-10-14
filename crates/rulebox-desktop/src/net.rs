//! Connectivity: none, local network, or internet (plan Step 10).
//!
//! Status only. There is no network list, no connect and no toggle.

use std::sync::Arc;

use windows::Win32::Networking::NetworkListManager::{
    INetworkListManager, INetworkListManagerEvents, INetworkListManagerEvents_Impl,
    NLM_CONNECTIVITY, NetworkListManager,
};
use windows::Win32::System::Com::{
    CoCreateInstance, IConnectionPoint, IConnectionPointContainer, CLSCTX_ALL,
};

use windows_core::{implement, Interface};

use crate::error::{DesktopError, Result};

/// What quick settings may say about the network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Connectivity {
    None,
    Local,
    Internet,
}

// NLM_CONNECTIVITY (netlistmgr.h). IPv4 internet is 0x40, not 0x100.
const INTERNET: u32 = 0x0000_0040 | 0x0000_0200;
const LOCAL: u32 = 0x0000_0010 | 0x0000_0020 | 0x0000_0080 | 0x0000_0100;

/// Map `NLM_CONNECTIVITY` flags. Internet wins over local.
pub fn map_connectivity(flags: u32) -> Connectivity {
    if flags & INTERNET != 0 {
        Connectivity::Internet
    } else if flags & LOCAL != 0 {
        Connectivity::Local
    } else {
        Connectivity::None
    }
}

/// Network List Manager, plus the connectivity event. Drop unadvises.
pub(crate) struct Watch {
    manager: INetworkListManager,
    point: Option<IConnectionPoint>,
    cookie: u32,
}

impl Watch {
    pub(crate) fn open(on_change: Arc<dyn Fn() + Send + Sync>) -> Result<Self> {
        // SAFETY: COM is initialized on this thread (the system worker).
        let manager: INetworkListManager =
            unsafe { CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) }
                .map_err(|e| DesktopError::win32("CoCreateInstance(NetworkListManager)", &e))?;
        let sink: INetworkListManagerEvents = ConnectivityCallback { on_change }.into();
        let advised = advise(&manager, &sink);
        let (point, cookie) = match advised {
            Ok(pair) => (Some(pair.0), pair.1),
            Err(error) => {
                tracing::warn!(%error, "network changes will be missed until restart");
                (None, 0)
            }
        };
        // Advise holds its own reference. Dropping `sink` here leaves that one.
        drop(sink);
        Ok(Self {
            manager,
            point,
            cookie,
        })
    }

    pub(crate) fn read(&self) -> Result<Connectivity> {
        // SAFETY: `manager` is a live object on this thread.
        let flags = unsafe { self.manager.GetConnectivity() }
            .map_err(|e| DesktopError::win32("GetConnectivity", &e))?;
        Ok(map_connectivity(flags.0 as u32))
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        if let Some(point) = self.point.take() {
            if self.cookie != 0 {
                // SAFETY: `cookie` came from Advise on this point.
                let _ = unsafe { point.Unadvise(self.cookie) };
            }
        }
    }
}

fn advise(
    manager: &INetworkListManager,
    sink: &INetworkListManagerEvents,
) -> Result<(IConnectionPoint, u32)> {
    let container: IConnectionPointContainer = manager
        .cast()
        .map_err(|e| DesktopError::win32("IConnectionPointContainer", &e))?;
    // SAFETY: standard connection-point advise. Unadvise is in Drop.
    let point = unsafe { container.FindConnectionPoint(&INetworkListManagerEvents::IID) }
        .map_err(|e| DesktopError::win32("FindConnectionPoint", &e))?;
    let cookie = unsafe { point.Advise(sink) }
        .map_err(|e| DesktopError::win32("IConnectionPoint::Advise", &e))?;
    Ok((point, cookie))
}

#[implement(INetworkListManagerEvents)]
struct ConnectivityCallback {
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl INetworkListManagerEvents_Impl for ConnectivityCallback_Impl {
    fn ConnectivityChanged(&self, _new: NLM_CONNECTIVITY) -> windows_core::Result<()> {
        (self.on_change)();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectivity_mapping() {
        assert_eq!(map_connectivity(0), Connectivity::None);
        assert_eq!(map_connectivity(0x1), Connectivity::None);
        assert_eq!(map_connectivity(0x10), Connectivity::Local);
        assert_eq!(map_connectivity(0x20), Connectivity::Local);
        assert_eq!(map_connectivity(0x100), Connectivity::Local);
        assert_eq!(map_connectivity(0x40), Connectivity::Internet);
        assert_eq!(map_connectivity(0x200), Connectivity::Internet);
        assert_eq!(map_connectivity(0x40 | 0x20), Connectivity::Internet);
    }
}
