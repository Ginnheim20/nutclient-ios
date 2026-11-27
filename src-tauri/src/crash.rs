//! Absturzanalyse ohne Internet: Nach dem Spielende liest der Launcher den neuesten Crash-Report (falls einer während
//! der Sitzung entstanden ist) und das Spiel-Log und erkennt die häufigsten Ursachen. Nichts wird hochgeladen.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Ergebnis für das Frontend: was passiert ist, was man tun kann, welche Datei es belegt.
#[derive(Clone, Serialize)]
pub struct CrashReport {
    pub title: String,
    pub cause: String,
    pub hint: String,
    pub detail: String,
    pub file: String,
}

/// Ist das Spiel abgestürzt? Dann eine Analyse, sonst `None`. `started` = Startzeit, ältere Reports zählen nicht.
pub fn check(game_dir: &Path, exit_ok: bool, started: SystemTime) -> Option<CrashReport> {
    let report = newest_report(game_dir, started);
    if exit_ok && report.is_none() {
        return None;
    }
    let (text, file) = match &report {
        Some(p) => (std::fs::read_to_string(p).unwrap_or_default(), p.clone()),
        None => {
            let log = game_dir.join("logs").join("latest.log");
            (std::fs::read_to_string(&log).unwrap_or_default(), log)
        }
    };
    let (cause, hint) = analyze(&text);
    Some(CrashReport {
        title: "Minecraft ist abgestürzt".into(),
        cause,
        hint,
        detail: key_line(&text),
        file: file.display().to_string(),
    })
}

/// Während das Spiel läuft: ist das Laden der Mods gescheitert? NeoForge zeigt dann einen Fehlerbildschirm (oft mit
/// kaputter Schrift, weil die Ressourcen fehlen) statt abzustürzen – der Launcher erklärt es stattdessen selbst.
/// Liest `logs/latest.log`, wenn es nach `started` geschrieben wurde.
pub fn loading_error(game_dir: &Path, started: SystemTime) -> Option<CrashReport> {
    let log = game_dir.join("logs").join("latest.log");
    let modified = std::fs::metadata(&log).ok()?.modified().ok()?;
    if modified < started {
        return None;
    }
    let text = std::fs::read_to_string(&log).ok()?;
    analyze_loading(&text, &log.display().to_string())
}

/// Ladefehler im Log erkennen und erklären (siehe loading_error).
fn analyze_loading(text: &str, file: &str) -> Option<CrashReport> {
    if !text.contains("[net.neoforged.fml.ModLoader/LOADING]: Failed to wait for future")
        && !text.contains("net.neoforged.fml.ModLoadingException")
    {
        return None;
    }
    // Erste aussagekräftige Fehlerzeile nach dem Ladefehler (Suppressed/Caused by/…Exception: …)
    // ab dem ersten Ladefehler suchen (davor stehen oft harmlosere Fehler, z. B. von Texturen)
    let from = text.lines().position(|l| l.contains("/LOADING]") && (l.contains("/ERROR]") || l.contains("/FATAL]"))).unwrap_or(0);
    let detail = text
        .lines()
        .skip(from)
        .filter(|l| {
            let t = l.trim_start();
            (t.starts_with("Suppressed:") || t.starts_with("Caused by:") || t.starts_with("java.lang."))
                && t.contains("Exception")
        })
        .map(|l| l.trim().chars().take(300).collect::<String>())
        .next()
        .unwrap_or_else(|| key_line(text));
    let modid = text
        .lines()
        .find_map(|l| l.split("dispatch for modid ").nth(1).map(|m| m.trim().to_string()));
    let (cause, hint) = if text.contains("Caught error loading resourcepacks") {
        let res = text
            .lines()
            .skip_while(|l| !l.contains("Caught error loading resourcepacks"))
            .find(|l| l.contains("Caused by:") || l.contains("Exception:"))
            .map(|l| l.trim().chars().take(200).collect::<String>())
            .unwrap_or_default();
        (
            format!(
                "Beim Laden der Texturen ist ein Fehler passiert ({res}). Minecraft hat daraufhin alles neu geladen, \
                 und dabei melden sich Mods doppelt an{}.",
                modid.as_deref().map(|m| format!(" (zuerst „{m}“)")).unwrap_or_default()
            ),
            "Meist ersetzen zwei Mods dieselben Texturen oder Partikel (z. B. zwei Regen-/Wetter-Mods). Eine davon \
             abschalten – die im Fehler genannte Datei zeigt, welche."
                .to_string(),
        )
    } else {
        (
            format!(
                "Eine Mod konnte nicht geladen werden{}.",
                modid.as_deref().map(|m| format!(": „{m}“")).unwrap_or_default()
            ),
            "Die genannte Mod (oder die zuletzt hinzugefügte) abschalten oder eine passende Version wählen.".to_string(),
        )
    };
    Some(CrashReport { title: "Mods konnten nicht geladen werden".into(), cause, hint, detail, file: file.to_string() })
}

/// Neuester Crash-Report aus `crash-reports/`, der nach dem Start entstanden ist.
fn newest_report(game_dir: &Path, started: SystemTime) -> Option<PathBuf> {
    let dir = std::fs::read_dir(game_dir.join("crash-reports")).ok()?;
    dir.filter_map(|e| e.ok())
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            (modified >= started).then_some((modified, e.path()))
        })
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

/// Bekannte Muster → (Ursache, Lösungstipp). Reihenfolge = Wichtigkeit.
fn analyze(text: &str) -> (String, String) {
    let has = |s: &str| text.contains(s);
    let cause = |c: &str, h: &str| (c.to_string(), h.to_string());
    if has("java.lang.OutOfMemoryError") || has("Out of memory") {
        return cause(
            "Zu wenig Arbeitsspeicher (RAM) für Minecraft.",
            "Gib dem Profil mehr RAM: Einstellungen → Spiel → RAM (z. B. 4–6 GB). Große Modpacks brauchen mehr.",
        );
    }
    if has("UnsupportedClassVersionError") || has("has been compiled by a more recent version of the Java Runtime") {
        return cause(
            "Falsche Java-Version für eine Mod oder das Spiel.",
            "Eine Mod braucht ein neueres Java. Entferne die Mod oder nimm eine passende Version der Mod.",
        );
    }
    if has("Mod resolution encountered an incompatible mod set") || has("Incompatible mods found") {
        let line = first_line_with(text, &["requires", "is incompatible with", "breaks"]);
        return cause(
            &format!("Mods passen nicht zusammen oder eine Abhängigkeit fehlt.{}", suffix(&line)),
            "Prüfe die genannte Mod im Profil: passende Version für deine Minecraft-Version wählen oder die fehlende Mod hinzufügen.",
        );
    }
    if has("Found duplicate mod") || has("Duplicate mod") || has("duplicate mods") {
        return cause(
            "Eine Mod ist doppelt installiert.",
            "Im Profil unter Mods die doppelte Mod entfernen (nur eine Version behalten).",
        );
    }
    if has("Mixin apply failed") || has("MixinApplyError") || has("InvalidInjectionException") || has("MixinTransformerError") {
        let line = first_line_with(text, &["mixins.json", "from mod"]);
        return cause(
            &format!("Zwei Mods vertragen sich nicht (Mixin-Konflikt).{}", suffix(&line)),
            "Deaktiviere die zuletzt hinzugefügte Mod oder die im Detail genannte Mod und starte erneut.",
        );
    }
    if has("Pixel format not accelerated") || has("GLFW error 65542") || has("No OpenGL context") || has("WGL: The driver does not appear to support OpenGL") {
        return cause(
            "Der Grafiktreiber unterstützt OpenGL nicht richtig.",
            "Grafiktreiber aktualisieren (NVIDIA/AMD/Intel-Website). Bei Laptops die richtige Grafikkarte für Java wählen.",
        );
    }
    if has("EXCEPTION_ACCESS_VIOLATION") || has("A fatal error has been detected by the Java Runtime") {
        return cause(
            "Absturz außerhalb von Java (meist Grafiktreiber, Shader oder Sodium/Iris).",
            "Grafiktreiber aktualisieren, Shaderpack ausschalten und es erneut versuchen.",
        );
    }
    if has("Could not find or load main class") || has("ClassNotFoundException: net.fabricmc") {
        return cause(
            "Die Installation des Profils ist beschädigt.",
            "Profil einmal neu starten lassen – der Launcher lädt fehlende Dateien nach. Hilft das nicht: Profil neu anlegen.",
        );
    }
    if has("NoClassDefFoundError") || has("ClassNotFoundException") {
        let line = first_line_with(text, &["NoClassDefFoundError", "ClassNotFoundException"]);
        return cause(
            &format!("Eine Mod sucht eine Klasse, die fehlt – meist fehlt eine Abhängigkeit oder die Mod passt nicht zur Version.{}", suffix(&line)),
            "Prüfe die Mods im Profil auf passende Versionen und fehlende Abhängigkeiten (z. B. Fabric API).",
        );
    }
    cause(
        "Die Ursache ließ sich nicht eindeutig erkennen.",
        "Im Detail steht die wichtigste Fehlerzeile. Oft hilft es, die zuletzt hinzugefügte Mod zu deaktivieren.",
    )
}

fn suffix(line: &str) -> String {
    if line.is_empty() {
        String::new()
    } else {
        format!(" ({})", line.trim())
    }
}

fn first_line_with(text: &str, keys: &[&str]) -> String {
    text.lines()
        .find(|l| keys.iter().any(|k| l.contains(k)))
        .map(|l| l.chars().take(220).collect())
        .unwrap_or_default()
}

/// Wichtigste Zeile: Beschreibung aus dem Crash-Report, sonst die erste Fehler- bzw. „Caused by“-Zeile.
fn key_line(text: &str) -> String {
    for key in ["Description:", "Caused by:", "Exception", "ERROR"] {
        if let Some(l) = text.lines().find(|l| l.contains(key)) {
            return l.trim().chars().take(300).collect();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::analyze;

    #[test]
    fn erkennt_ram() {
        assert!(analyze("java.lang.OutOfMemoryError: Java heap space").0.contains("Arbeitsspeicher"));
    }

    #[test]
    fn erkennt_mixin() {
        let (c, _) = analyze("Mixin apply failed foo.mixins.json:BarMixin from mod foo");
        assert!(c.contains("Mixin"));
    }

    #[test]
    fn erkennt_doppeltes_laden() {
        let log = "[Render thread/INFO] [net.minecraft.client.Minecraft/]: Caught error loading resourcepacks, removing all selected resourcepacks
java.util.concurrent.CompletionException: java.lang.IndexOutOfBoundsException: Cannot get rain_4 as sheet only contains 4 sprites
Caused by: java.lang.IndexOutOfBoundsException: Cannot get rain_4 as sheet only contains 4 sprites
[Worker-Main-2/ERROR] [net.neoforged.fml.ModContainer/LOADING]: Caught exception during event FMLCommonSetupEvent dispatch for modid blueprint
java.lang.IllegalArgumentException: A Tracked Data with key 'blueprint:slabfish_head' is already registered!
[modloading-worker-0/FATAL] [net.neoforged.fml.ModLoader/LOADING]: Failed to wait for future Common setup, 1 errors found";
        let r = super::analyze_loading(log, "x").expect("erkannt");
        assert!(r.cause.contains("rain_4"), "{}", r.cause);
        assert!(r.cause.contains("blueprint"));
        assert!(r.detail.contains("already registered"), "{}", r.detail);
        assert!(super::analyze_loading("alles gut", "x").is_none());
    }

    #[test]
    fn unbekannt() {
        assert!(analyze("irgendwas").0.contains("nicht eindeutig"));
    }
}
