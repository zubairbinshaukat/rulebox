//! Master volume on the default render device (plan Step 10).
//!
//! The COM objects live on the system worker thread (MTA), not on the
//! message loop. Change callbacks only enqueue work; they never unregister.

use std::sync::Arc;

use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows_core::implement;

use crate::error::{DesktopError, Result};

/// Master volume. `level` is 0.0–1.0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Volume {
    pub level: f32,
    pub muted: bool,
}

/// Clamp to 0.0–1.0. NaN becomes 0; infinities sit on the ends.
pub fn clamp_level(level: f32) -> f32 {
    if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 1.0)
    }
}

/// Nearest percent, 0–100, after clamping.
pub fn round_percent(level: f32) -> u8 {
    let scaled = clamp_level(level) * 100.0;
    scaled.round().clamp(0.0, 100.0) as u8
}

/// The default render endpoint, plus the callbacks that ask for a re-read
/// or a re-bind. Dropping this unregisters both; do that on the worker
/// thread, never from inside a callback.
pub(crate) struct Endpoint {
    volume: IAudioEndpointVolume,
    callback: IAudioEndpointVolumeCallback,
    enumerator: IMMDeviceEnumerator,
    device_callback: IMMNotificationClient,
}

impl Endpoint {
    pub(crate) fn open(
        on_volume: Arc<dyn Fn() + Send + Sync>,
        on_device: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Option<Self>> {
        // SAFETY: COM is initialized on this thread (the system worker).
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| DesktopError::win32("CoCreateInstance(MMDeviceEnumerator)", &e))?;
        let device = match unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) } {
            Ok(device) => device,
            Err(error) => {
                tracing::info!(%error, "no default audio device");
                return Ok(None);
            }
        };
        let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| DesktopError::win32("Activate(IAudioEndpointVolume)", &e))?;

        let callback: IAudioEndpointVolumeCallback = VolumeCallback {
            on_change: on_volume,
        }
        .into();
        unsafe { volume.RegisterControlChangeNotify(&callback) }
            .map_err(|e| DesktopError::win32("RegisterControlChangeNotify", &e))?;

        let device_callback: IMMNotificationClient = DeviceCallback {
            on_change: on_device,
        }
        .into();
        if let Err(error) =
            unsafe { enumerator.RegisterEndpointNotificationCallback(&device_callback) }
        {
            tracing::warn!(%error, "audio device changes will not be followed");
        }

        Ok(Some(Self {
            volume,
            callback,
            enumerator,
            device_callback,
        }))
    }

    pub(crate) fn read(&self) -> Result<Volume> {
        // SAFETY: `volume` is a live endpoint on this thread.
        let level = unsafe { self.volume.GetMasterVolumeLevelScalar() }
            .map_err(|e| DesktopError::win32("GetMasterVolumeLevelScalar", &e))?;
        let muted = unsafe { self.volume.GetMute() }
            .map_err(|e| DesktopError::win32("GetMute", &e))?;
        Ok(Volume {
            level: clamp_level(level),
            muted: muted.as_bool(),
        })
    }

    pub(crate) fn set_level(&self, level: f32) -> Result<()> {
        let level = clamp_level(level);
        unsafe { self.volume.SetMasterVolumeLevelScalar(level, std::ptr::null()) }
            .map_err(|e| DesktopError::win32("SetMasterVolumeLevelScalar", &e))
    }

    pub(crate) fn set_muted(&self, muted: bool) -> Result<()> {
        unsafe {
            self.volume
                .SetMute(muted, std::ptr::null())
        }
        .map_err(|e| DesktopError::win32("SetMute", &e))
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        // SAFETY: unregister on the thread that registered, before the
        // callback objects are released. Not called from a callback.
        unsafe {
            let _ = self.volume.UnregisterControlChangeNotify(&self.callback);
            let _ = self
                .enumerator
                .UnregisterEndpointNotificationCallback(&self.device_callback);
        }
    }
}

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeCallback {
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl IAudioEndpointVolumeCallback_Impl for VolumeCallback_Impl {
    fn OnNotify(&self, _notify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows_core::Result<()> {
        (self.on_change)();
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceCallback {
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl IMMNotificationClient_Impl for DeviceCallback_Impl {
    fn OnDeviceStateChanged(
        &self,
        _id: &windows_core::PCWSTR,
        _state: DEVICE_STATE,
    ) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDeviceAdded(&self, _id: &windows_core::PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, _id: &windows_core::PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        _role: ERole,
        _id: &windows_core::PCWSTR,
    ) -> windows_core::Result<()> {
        (self.on_change)();
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _id: &windows_core::PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows_core::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_clamps_and_rounds() {
        assert_eq!(clamp_level(1.4), 1.0);
        assert_eq!(clamp_level(-0.2), 0.0);
        assert_eq!(clamp_level(f32::NAN), 0.0);
        assert_eq!(clamp_level(0.4), 0.4);
        assert_eq!(round_percent(0.0), 0);
        assert_eq!(round_percent(0.2), 20);
        assert_eq!(round_percent(1.0), 100);
        assert_eq!(round_percent(1.8), 100);
        assert_eq!(round_percent(f32::INFINITY), 100);
    }
}
