//! Dateien einer Instanz: Ordner öffnen, eigene Dateien (per Ziehen hineingelegt) auflisten, importieren und entfernen.
//! Vom Launcher verwaltete Dateien heißen „<Projekt-ID>--<Datei>“ und tauchen hier nicht auf.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

/// Unterordner, in die Inhalte gehören.
pub const MODS: &str = "mods";
pub const RESOURCEPACKS: &str = "resourcepacks";
pub const SHADERPACKS: &str = "shaderpacks";

fn check_folder(folder: &str) -> Result<()> {
    if matches!(folder, "" | MODS | RESOURCEPACKS | SHADERPACKS | "saves" | "screenshots" | "logs") {
        Ok(())
    } else {
        Err(Error::Other(format!("Unbekannter Ordner: {folder}")))
    }
}

/// Ordner (oder Unterordner) der Instanz im Explorer öffnen; fehlt er, wird er angelegt.
pub fn open(dir: &Path, folder: &str) -> Result<()> {
    check_folder(folder)?;
    let path = if folder.is_empty() { dir.to_path_buf() } else { dir.join(folder) };
    std::fs::create_dir_all(&path)?;
    #[cfg(windows)]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(&path).spawn().map_err(Error::Io)?;
    Ok(())
}

/// Eigene Dateien eines Unterordners (ohne die vom Launcher verwalteten und ohne die NUTclient-Jar).
pub fn list(dir: &Path, folder: &str) -> Result<Vec<String>> {
    check_folder(folder)?;
    let Ok(entries) = std::fs::read_dir(dir.join(folder)) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.contains("--") && !(n.starts_with("nutclient") && n.ends_with(".jar")))
        .filter(|n| {
            let l = n.to_lowercase();
            l.ends_with(".jar") || l.ends_with(".zip") || l.ends_with(".jar.disabled") || l.ends_with(".zip.disabled")
        })
        .collect();
    out.sort_by_key(|n| n.to_lowercase());
    Ok(out)
}

/// Eine Datei hineinlegen: .jar → Mods, .zip mit „shaders/“ → Shader, sonst → Ressourcenpakete.
/// Gibt den Unterordner zurück.
pub fn import(dir: &Path, source: &Path) -> Result<String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| Error::Other("Keine Datei".into()))?;
    let lower = name.to_lowercase();
    let folder = if lower.ends_with(".jar") {
        MODS
    } else if lower.ends_with(".zip") {
        if zip_has_shaders(source) {
            SHADERPACKS
        } else {
            RESOURCEPACKS
        }
    } else {
        return Err(Error::Other(format!("„{name}“ ist keine Mod (.jar) und kein Paket (.zip)")));
    };
    let target_dir = dir.join(folder);
    std::fs::create_dir_all(&target_dir)?;
    // „--“ ist für vom Launcher verwaltete Dateien reserviert – sonst würde sie beim Start weggeräumt
    let safe = name.replace("--", "-");
    std::fs::copy(source, target_dir.join(safe))?;
    Ok(folder.to_string())
}

/// Anzeigename eines Loaders.
pub fn loader_name(loader: &str) -> &'static str {
    match loader {
        "neoforge" => "NeoForge",
        "forge" => "Forge",
        _ => "Fabric",
    }
}

/// Für welche Loader eine .jar gebaut ist („fabric“, „neoforge“, „forge“; leer = reine Bibliothek/unbekannt).
fn jar_loaders(path: &Path) -> Vec<&'static str> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return Vec::new() };
    let mut has = |n: &str| zip.by_name(n).is_ok();
    let mut out = Vec::new();
    if has("fabric.mod.json") || has("quilt.mod.json") {
        out.push("fabric");
    }
    if has("META-INF/neoforge.mods.toml") {
        out.push("neoforge");
    }
    if has("META-INF/mods.toml") || has("mcmod.info") {
        out.push("forge");
    }
    out
}

/// Ist die .jar für einen anderen Loader als `loader` gebaut? Dann dessen Anzeigename – der Loader der Instanz
/// würde sie still übergehen. None = passt (oder unbekannt).
pub fn foreign_loader(path: &Path, loader: &str) -> Option<&'static str> {
    let found = jar_loaders(path);
    if found.is_empty() || found.contains(&loader) {
        return None;
    }
    Some(loader_name(found[0]))
}

/// Eigene Mods der Instanz, die nicht für ihren Loader sind: (Dateiname, Loader).
pub fn foreign_mods(dir: &Path, loader: &str) -> Vec<(String, String)> {
    let Ok(names) = list(dir, MODS) else {
        return Vec::new();
    };
    names
        .into_iter()
        .filter(|n| n.to_lowercase().ends_with(".jar"))
        .filter_map(|n| foreign_loader(&dir.join(MODS).join(&n), loader).map(|l| (n, l.to_string())))
        .collect()
}

/// Hat die Instanz eigene (hineingezogene) Mods? Dann braucht der Start Fabric.
pub fn has_own_mods(dir: &Path) -> bool {
    list(dir, MODS).map(|v| v.iter().any(|n| n.to_lowercase().ends_with(".jar"))).unwrap_or(false)
}

fn zip_has_shaders(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return false;
    };
    (0..zip.len()).any(|i| {
        zip.by_index(i)
            .map(|f| {
                let n = f.name().to_lowercase();
                n.starts_with("shaders/") || n.contains("/shaders/")
            })
            .unwrap_or(false)
    })
}

/// Eigene Datei entfernen (in den Papierkorb).
pub fn remove(dir: &Path, folder: &str, name: &str) -> Result<()> {
    check_folder(folder)?;
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(Error::Other("Ungültiger Dateiname".into()));
    }
    let path: PathBuf = dir.join(folder).join(name);
    if !path.is_file() {
        return Ok(());
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    trash::delete(&path).map_err(|e| Error::Other(format!("Papierkorb: {e}")))?;
    // Handy: kein Papierkorb – Datei wandert in den Ordner „.papierkorb“ der Instanz
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let bin = dir.join(".papierkorb");
        std::fs::create_dir_all(&bin)?;
        std::fs::rename(&path, bin.join(name))?;
    }
    Ok(())
}

/// Mod-Kennung einer .jar (Fabric/Quilt `fabric.mod.json` → „id“, NeoForge → erstes `modId`).
pub fn mod_id(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    if let Ok(mut f) = zip.by_name("fabric.mod.json") {
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        return v.get("id").and_then(|i| i.as_str()).map(String::from);
    }
    let mut f = zip.by_name("META-INF/neoforge.mods.toml").ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    s.lines()
        .map(str::trim)
        .find(|l| l.starts_with("modId"))
        .and_then(|l| l.split('"').nth(1))
        .map(String::from)
}

/// Kennungen der eigenen Mods (alles ohne „--“ im Namen, z. B. aus einem Modpack).
pub fn own_mod_ids(dir: &Path) -> std::collections::HashSet<String> {
    list(dir, MODS)
        .unwrap_or_default()
        .into_iter()
        .filter(|n| !n.contains("--") && n.to_lowercase().ends_with(".jar"))
        .filter_map(|n| mod_id(&dir.join(MODS).join(n)))
        .collect()
}

/// Eine eigene Datei im Mods-Ordner mit Angaben aus der Jar (für die Liste in der Instanz-Ansicht).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInfo {
    /// Dateiname (ggf. mit „.disabled“).
    pub file: String,
    /// Anzeigename aus der Jar, sonst der Dateiname ohne Endung.
    pub name: String,
    pub version: String,
    pub enabled: bool,
    /// Für einen anderen Loader gebaut (Anzeigename), läuft hier nicht.
    pub foreign: Option<String>,
}

/// Name und Version aus `fabric.mod.json` bzw. `META-INF/neoforge.mods.toml` / `mods.toml`.
fn jar_meta(path: &Path) -> (Option<String>, Option<String>) {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else { return (None, None) };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return (None, None) };
    let mut text = |n: &str| -> Option<String> {
        let mut f = zip.by_name(n).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        Some(s)
    };
    if let Some(s) = text("fabric.mod.json").or_else(|| text("quilt.mod.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            let base = v.get("quilt_loader").and_then(|q| q.get("metadata")).unwrap_or(&v);
            let name = base.get("name").and_then(|x| x.as_str()).map(String::from);
            let version = v
                .get("version")
                .or_else(|| v.get("quilt_loader").and_then(|q| q.get("version")))
                .and_then(|x| x.as_str())
                .map(String::from);
            return (name, version);
        }
    }
    let toml = text("META-INF/neoforge.mods.toml").or_else(|| text("META-INF/mods.toml"));
    if let Some(s) = toml {
        let val = |key: &str| {
            s.lines()
                .map(str::trim)
                .find(|l| l.starts_with(key) && l[key.len()..].trim_start().starts_with('='))
                .and_then(|l| l.split('"').nth(1))
                .map(String::from)
        };
        let version = val("version").filter(|v| !v.contains("${"));
        return (val("displayName"), version);
    }
    (None, None)
}

/// Alle eigenen Mods (ohne Launcher-Downloads „--“) mit Name, Version, an/aus und Loader-Prüfung.
pub fn mod_infos(dir: &Path, loader: &str) -> Vec<ModInfo> {
    let names = list(dir, MODS).unwrap_or_default();
    names
        .into_iter()
        .filter(|n| {
            let l = n.to_lowercase();
            l.ends_with(".jar") || l.ends_with(".jar.disabled")
        })
        .map(|file| {
            let path = dir.join(MODS).join(&file);
            let enabled = !file.to_lowercase().ends_with(".disabled");
            let (name, version) = jar_meta(&path);
            let fallback = file.trim_end_matches(".disabled").trim_end_matches(".jar").to_string();
            ModInfo {
                name: name.filter(|n| !n.trim().is_empty()).unwrap_or(fallback),
                version: version.unwrap_or_default(),
                enabled,
                foreign: if enabled { foreign_loader(&path, loader).map(String::from) } else { None },
                file,
            }
        })
        .collect()
}

/// Eigene Datei an-/ausschalten: „x.jar“ ↔ „x.jar.disabled“ (Minecraft lädt nur „.jar“/„.zip“). Gibt den neuen Namen.
pub fn set_enabled(dir: &Path, folder: &str, name: &str, enabled: bool) -> Result<String> {
    check_folder(folder)?;
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err(Error::Other("Ungültiger Dateiname".into()));
    }
    let base = name.strip_suffix(".disabled").unwrap_or(name);
    // (Pfadtrenner oben geprüft)
    let target = if enabled { base.to_string() } else { format!("{base}.disabled") };
    if target == name {
        return Ok(target);
    }
    let from = dir.join(folder).join(name);
    let to = dir.join(folder).join(&target);
    if to.exists() {
        return Err(Error::Other(format!("„{target}“ gibt es schon")));
    }
    std::fs::rename(from, to)?;
    Ok(target)
}

/// Ordner, die sich Profile teilen können.
pub const SHAREABLE: [&str; 5] = ["saves", "resourcepacks", "shaderpacks", "screenshots", "schematics"];

/// Ist der Ordner eine Verknüpfung (Junction/Symlink) statt eines echten Ordners?
pub fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Welche teilbaren Ordner dieser Instanz gerade geteilt sind.
pub fn shared(dir: &Path) -> Vec<String> {
    SHAREABLE.iter().filter(|f| is_link(&dir.join(f))).map(|f| f.to_string()).collect()
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else if !dst.exists() {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Ordner teilen: Inhalt wandert (ohne etwas zu überschreiben) nach `<shared>/<ordner>`, an seine Stelle kommt eine
/// Verknüpfung (Windows-Junction, braucht keine Admin-Rechte). Was dort schon gleichnamig liegt, bleibt in
/// `<ordner>-vorher` liegen. Aufheben: Verknüpfung weg, der geteilte Inhalt wird in einen eigenen Ordner kopiert.
pub fn set_shared(shared_root: &Path, dir: &Path, folder: &str, share: bool) -> Result<()> {
    if !SHAREABLE.contains(&folder) {
        return Err(Error::Other(format!("„{folder}“ lässt sich nicht teilen")));
    }
    let local = dir.join(folder);
    let target = shared_root.join(folder);
    if share {
        if is_link(&local) {
            return Ok(());
        }
        std::fs::create_dir_all(&target)?;
        if local.is_dir() {
            let mut left = false;
            for e in std::fs::read_dir(&local)?.flatten() {
                let dst = target.join(e.file_name());
                if dst.exists() || std::fs::rename(e.path(), &dst).is_err() {
                    left = true;
                }
            }
            if left {
                let keep = dir.join(format!("{folder}-vorher"));
                std::fs::rename(&local, &keep)?;
            } else {
                std::fs::remove_dir(&local)?;
            }
        }
        std::fs::create_dir_all(dir)?;
        link(&target, &local)
    } else {
        if !is_link(&local) {
            return Ok(());
        }
        // Junction/Symlink entfernen – der geteilte Ordner selbst bleibt unberührt
        std::fs::remove_dir(&local).or_else(|_| std::fs::remove_file(&local))?;
        copy_dir(&target, &local)?;
        Ok(())
    }
}

#[cfg(windows)]
fn link(target: &Path, at: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(at)
        .arg(target)
        .creation_flags(0x0800_0000) // kein Konsolenfenster
        .output()?;
    if !out.status.success() {
        return Err(Error::Other(format!("Verknüpfung fehlgeschlagen: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

#[cfg(not(windows))]
fn link(target: &Path, at: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, at)?;
    Ok(())
}
