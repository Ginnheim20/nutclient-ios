// Empfaenger fuer das Vencord-Plugin „nutBridge" (siehe discord-bridge/).
//
// Das Plugin laeuft im Discord-Client und schickt Ereignisse (DM, Erwaehnung,
// eingehender Anruf) als JSON per POST an 127.0.0.1:PORT/event. Hier wird das
// Ereignis angenommen und als Tauri-Event „discord://event" ans Frontend
// weitergereicht. Der Server bindet bewusst nur auf Loopback – von aussen
// nicht erreichbar.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Muss mit `PORT` im Vencord-Plugin (`discord-bridge/nutBridge/native.ts`) übereinstimmen.
pub const PORT: u16 = 47824;

const MAX_HEAD: usize = 8 * 1024;
const MAX_BODY: usize = 16 * 1024;
const MAX_TITLE: usize = 80;
const MAX_BODY_TEXT: usize = 300;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordEvent {
    /// "dm" | "mention" | "call"
    pub kind: String,
    pub title: String,
    pub body: String,
    pub channel_id: Option<String>,
    /// Name des Servers bzw. der Webseite (bei Discord-Erwähnungen den Servernamen)
    #[serde(default)]
    pub guild: Option<String>,
    /// Akzentfarbe der Leiste als `#rrggbb` (Browser-Erweiterung: pro Webseite)
    #[serde(default)]
    pub color: Option<String>,
}

impl DiscordEvent {
    /// Länge begrenzen, damit ein fremder Prozess die UI nicht mit Riesentexten flutet.
    fn sanitized(mut self) -> Self {
        self.title = self.title.chars().take(MAX_TITLE).collect();
        self.body = self.body.chars().take(MAX_BODY_TEXT).collect();
        self.channel_id = self.channel_id.map(|c| c.chars().take(40).collect());
        self.guild = self.guild.map(|g| g.chars().take(MAX_TITLE).collect());
        // Nur echte Hex-Farben durchlassen – der Wert landet als CSS-Variable im Frontend.
        self.color = self.color.filter(|c| {
            c.is_ascii() && c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
        });
        self
    }
}

/// Startet den Lauschserver im Hintergrund. Schlägt das Binden fehl (Port belegt),
/// läuft der Launcher ohne Discord-Brücke weiter.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("discord_bridge: Port {PORT} nicht frei ({e}) – Brücke inaktiv");
                return;
            }
        };
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle(&mut sock, &app).await;
            });
        }
    });
}

async fn handle(sock: &mut TcpStream, app: &AppHandle) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];

    // Header lesen bis zur Leerzeile.
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEAD {
            return respond(sock, "431 Request Header Fields Too Large").await;
        }
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let content_length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);

    if !request_line.starts_with("POST /event ") {
        return respond(sock, "404 Not Found").await;
    }
    if content_length > MAX_BODY {
        return respond(sock, "413 Payload Too Large").await;
    }

    // Body nachlesen.
    let body_start = head_end + 4;
    while buf.len() < body_start + content_length {
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = buf.get(body_start..body_start + content_length).unwrap_or(&[]);

    match serde_json::from_slice::<DiscordEvent>(body) {
        Ok(ev) => {
            let ev = ev.sanitized();
            eprintln!("discord_bridge: Ereignis angenommen ({}): {}", ev.kind, ev.title);
            let line = format!("{} OK kind={} title={:?} guild={:?}", stamp(), ev.kind, ev.title, ev.guild);
            match app.emit("discord://event", ev) {
                Ok(()) => {
                    eprintln!("discord_bridge: an Oberflaeche weitergereicht");
                    log_line(&format!("{line} -> emit ok"));
                }
                Err(e) => {
                    eprintln!("discord_bridge: emit fehlgeschlagen: {e}");
                    log_line(&format!("{line} -> emit FEHLER {e}"));
                }
            }
            respond(sock, "204 No Content").await
        }
        Err(e) => {
            log_line(&format!("{} PARSE-FEHLER {e} body={:?}", stamp(), String::from_utf8_lossy(body)));
            respond(sock, "400 Bad Request").await
        }
    }
}

/// Protokolldatei neben dem Projekt (`discord-bridge.log`) – nur beim Entwickeln. In Release-Builds wird nichts
/// geschrieben, damit kein Entwickler-Pfad in die Programmdatei wandert und auf fremden Rechnern versucht wird.
fn log_line(msg: &str) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("discord-bridge.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{msg}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

fn stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

async fn respond(sock: &mut TcpStream, status: &str) -> std::io::Result<()> {
    let resp = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    sock.write_all(resp.as_bytes()).await
}
