//! System-Medienwiedergabe (Windows SMTC): liest und steuert, was gerade in
//! Spotify, einem Browser (YouTube/Netflix), einer Musik-App usw. läuft –
//! wie die Windows-11-Medienanzeige.
//!
//! Die WinRT-Futures sind `!Send`, deshalb laufen die Aufrufe synchron
//! (`.join()`) und werden von den Tauri-Commands über `spawn_blocking`
//! ausgelagert.

use serde::Serialize;

/// Discord-Voice-Zustand (nur Näherung – Discord gibt echten Call-State nicht raus).
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscordCall {
    /// Discord nutzt gerade das Mikrofon → vermutlich im Voice-Call.
    pub in_call: bool,
    /// Kontext aus dem Discord-Fenstertitel: Server-Name oder @Person (DM).
    pub context: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// true, sobald irgendeine Medien-Session existiert
    pub active: bool,
    pub title: String,
    pub artist: String,
    /// AppUserModelId der Quelle (z. B. "Spotify.exe", "…Chrome…")
    pub app_id: String,
    pub playing: bool,
    pub can_next: bool,
    pub can_prev: bool,
    /// Position / Länge in Sekunden (0, wenn die Quelle keine Zeitleiste liefert)
    pub position: f64,
    pub duration: f64,
    /// Cover als data-URL (falls die Quelle eins liefert)
    pub thumb: Option<String>,
}

/// Lokale Uhrzeit als "HH:MM" direkt vom Betriebssystem – die WebView-Engine
/// verrechnet sich manchmal um die Sommerzeit.
#[cfg(windows)]
pub fn local_hm() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let st = unsafe { GetLocalTime() };
    format!("{:02}:{:02}", st.wHour, st.wMinute)
}

#[cfg(not(windows))]
pub fn local_hm() -> String {
    String::new()
}

#[cfg(not(windows))]
pub fn ensure_mta() {}

#[cfg(not(windows))]
pub fn now_playing() -> NowPlaying {
    NowPlaying::default()
}

#[cfg(not(windows))]
pub fn control(_action: &str) -> Result<(), String> {
    Err("nur unter Windows".into())
}

#[cfg(not(windows))]
pub fn discord_call() -> DiscordCall {
    DiscordCall::default()
}

/// Discord-Fenstertitel → kurzer Kontext.
/// `"● #kanal | Server Name - Discord"` → `"Server Name"`
/// `"@Freund - Discord"` (DM-Call)          → `"@Freund"`
/// `"Discord"`                              → `""`
pub fn parse_discord_title(raw: &str) -> String {
    let t = raw
        .trim()
        .trim_end_matches("- Discord")
        .trim()
        .trim_start_matches(['●', '•', '*'])
        .trim();
    // führende "(3)" / "[3]" Benachrichtigungszähler weg
    let t = t
        .split_once(')')
        .filter(|(a, _)| a.starts_with('(') && a[1..].chars().all(|c| c.is_ascii_digit()))
        .map(|(_, b)| b.trim())
        .unwrap_or(t);
    if t.is_empty() || t.eq_ignore_ascii_case("discord") {
        return String::new();
    }
    match t.split_once(" | ") {
        Some((_channel, server)) => server.trim().to_string(),
        None => t.to_string(),
    }
}

/// Discord über das `discord://`-Protokoll in den Vordergrund holen.
pub fn focus_discord() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "discord://"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn();
    }
}

#[cfg(windows)]
mod win {
    use super::NowPlaying;
    use base64::Engine;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

    /// Sorgt dafür, dass der Prozess einen MTA-Apartment hat – nötig, damit die
    /// WinRT-Aufrufe von den Blocking-Threads aus funktionieren.
    pub fn ensure_mta() {
        use windows::Win32::System::Com::CoIncrementMTAUsage;
        // Cookie absichtlich nicht gehalten – MTA bleibt für die Laufzeit bestehen.
        let _ = unsafe { CoIncrementMTAUsage() };
    }

    fn session() -> windows::core::Result<Session> {
        let mgr = Manager::RequestAsync()?.join()?;
        mgr.GetCurrentSession()
    }

    fn read_thumb(reference: IRandomAccessStreamReference) -> Option<String> {
        let stream = reference.OpenReadAsync().ok()?.join().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > 6_000_000 {
            return None;
        }
        let size = size as u32;
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        reader.LoadAsync(size).ok()?.join().ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        let ct = stream
            .ContentType()
            .map(|h| h.to_string_lossy())
            .unwrap_or_else(|_| "image/png".to_string());
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Some(format!("data:{ct};base64,{b64}"))
    }

    pub fn now_playing() -> NowPlaying {
        let Ok(s) = session() else {
            return NowPlaying::default();
        };
        let mut np = NowPlaying {
            active: true,
            ..Default::default()
        };

        if let Ok(info) = s.GetPlaybackInfo() {
            if let Ok(status) = info.PlaybackStatus() {
                np.playing = status == Status::Playing;
            }
            if let Ok(c) = info.Controls() {
                np.can_next = c.IsNextEnabled().unwrap_or(false);
                np.can_prev = c.IsPreviousEnabled().unwrap_or(false);
            }
        }

        np.app_id = s
            .SourceAppUserModelId()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();

        if let Ok(tl) = s.GetTimelineProperties() {
            let secs = |t: windows::Foundation::TimeSpan| t.Duration as f64 / 1e7;
            let pos = tl.Position().map(secs).unwrap_or(0.0);
            let start = tl.StartTime().map(secs).unwrap_or(0.0);
            let end = tl.EndTime().map(secs).unwrap_or(0.0);
            if end > start {
                np.duration = end - start;
                // SMTC aktualisiert `Position` nur sporadisch → seit dem letzten
                // Update verstrichene Zeit dazurechnen, damit die Anzeige läuft.
                let mut p = (pos - start).max(0.0);
                if np.playing {
                    if let Ok(lu) = tl.LastUpdatedTime() {
                        let lu_unix = lu.UniversalTime as f64 / 1e7 - 11_644_473_600.0;
                        if let Ok(now) =
                            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        {
                            let elapsed = now.as_secs_f64() - lu_unix;
                            if (0.0..3600.0).contains(&elapsed) {
                                p += elapsed;
                            }
                        }
                    }
                }
                np.position = p.min(np.duration);
            }
        }

        if let Ok(op) = s.TryGetMediaPropertiesAsync() {
            if let Ok(props) = op.join() {
                np.title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
                np.artist = props
                    .Artist()
                    .map(|h| h.to_string_lossy())
                    .unwrap_or_default();
                if np.artist.is_empty() {
                    np.artist = props
                        .AlbumArtist()
                        .map(|h| h.to_string_lossy())
                        .unwrap_or_default();
                }
                if let Ok(thumb_ref) = props.Thumbnail() {
                    np.thumb = read_thumb(thumb_ref);
                }
            }
        }

        np
    }

    fn process_name(pid: u32) -> String {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .is_ok();
            let _ = CloseHandle(h);
            if ok {
                String::from_utf16_lossy(&buf[..len as usize]).to_lowercase()
            } else {
                String::new()
            }
        }
    }

    /// Sichtbares Fenster eines „discord"-Prozesses mit Titel finden.
    fn discord_window_title() -> Option<String> {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
            IsWindowVisible,
        };

        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
                    return TRUE;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == 0 || !process_name(pid).contains("discord") {
                    return TRUE;
                }
                let mut buf = [0u16; 512];
                let n = GetWindowTextW(hwnd, &mut buf);
                if n > 0 {
                    let title = String::from_utf16_lossy(&buf[..n as usize]);
                    let out = &mut *(lparam.0 as *mut Option<String>);
                    // längeren/aussagekräftigeren Titel bevorzugen
                    if out.as_deref().map(|s| title.len() > s.len()).unwrap_or(true) {
                        *out = Some(title);
                    }
                }
                TRUE
            }
        }

        let mut result: Option<String> = None;
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut result as *mut _ as isize));
        }
        result
    }

    /// Grobe Erkennung „gerade im Discord-Voice-Call": Discord hat eine
    /// aktive Aufnahme-Session auf dem Standard-Mikrofon. (Discord gibt den
    /// echten Call-Zustand nicht an Fremd-Apps – das ist die beste Näherung.)
    pub fn discord_call() -> super::DiscordCall {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::{
            eCapture, eConsole, AudioSessionStateActive, IAudioSessionControl2,
            IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

        let none = super::DiscordCall::default();
        unsafe {
            let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return none;
            };
            let Ok(device) = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) else {
                return none;
            };
            let Ok(mgr) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                return none;
            };
            let Ok(sessions) = mgr.GetSessionEnumerator() else {
                return none;
            };
            let Ok(count) = sessions.GetCount() else {
                return none;
            };
            for i in 0..count {
                let Ok(ctrl) = sessions.GetSession(i) else { continue };
                if ctrl.GetState().map(|s| s != AudioSessionStateActive).unwrap_or(true) {
                    continue;
                }
                let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
                let Ok(pid) = ctrl2.GetProcessId() else { continue };
                if pid != 0 && process_name(pid).contains("discord") {
                    let context = discord_window_title()
                        .map(|t| super::parse_discord_title(&t))
                        .unwrap_or_default();
                    return super::DiscordCall { in_call: true, context };
                }
            }
        }
        none
    }

    pub fn control(action: &str) -> Result<(), String> {
        let s = session().map_err(|e| e.to_string())?;
        let res = match action {
            "playpause" => s.TryTogglePlayPauseAsync(),
            "play" => s.TryPlayAsync(),
            "pause" => s.TryPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            _ => return Err(format!("unbekannte Aktion: {action}")),
        };
        res.map_err(|e| e.to_string())?
            .join()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
pub use win::{control, discord_call, ensure_mta, now_playing};
