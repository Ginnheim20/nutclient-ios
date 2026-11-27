//! Profile mit NUTclient: Fabric-Loader installieren, Mods in den Profilordner legen (NUTclient, Fabric API,
//! In-Game Account Switcher), die Launcher-Farbe für den Client hinterlegen und Minecraft aus dem Profilordner starten.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::config::LauncherConfig;
use crate::error::{Error, Result};
use crate::minecraft::install::download_verified;
use crate::minecraft::manifest::Arguments;

const FABRIC_META: &str = "https://meta.fabricmc.net/v2/versions/loader";
const MODRINTH: &str = "https://api.modrinth.com/v2/project";
/// Mods, die jedes NUTclient-Profil automatisch bekommt (Modrinth-Slugs).
pub const AUTO_MODS: &[&str] = &["fabric-api", "in-game-account-switcher", "e4mc"];

#[derive(Debug, Deserialize)]
struct LoaderEntry {
    loader: LoaderVersion,
}

#[derive(Debug, Deserialize)]
struct LoaderVersion {
    version: String,
    #[serde(default)]
    stable: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FabricProfile {
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Vec<FabricLibrary>,
    #[serde(default)]
    pub arguments: Option<Arguments>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FabricLibrary {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub sha1: Option<String>,
}

impl FabricLibrary {
    /// Maven-Pfad aus „gruppe:artefakt:version“.
    pub fn path(&self) -> Option<String> {
        let mut parts = self.name.split(':');
        let group = parts.next()?;
        let artifact = parts.next()?;
        let version = parts.next()?;
        Some(format!(
            "{}/{artifact}/{version}/{artifact}-{version}.jar",
            group.replace('.', "/")
        ))
    }
}

/// Alle Fabric-Loader-Versionen für die Minecraft-Version (neueste zuerst) und ob sie stabil sind.
pub async fn fabric_versions(http: &reqwest::Client, mc: &str) -> Result<Vec<(String, bool)>> {
    let entries: Vec<LoaderEntry> = http
        .get(format!("{FABRIC_META}/{mc}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(entries.into_iter().map(|e| (e.loader.version, e.loader.stable)).collect())
}

/// Fabric-Start-Profil: gewünschte Loader-Version, sonst der neueste stabile Loader für die Minecraft-Version.
pub async fn fabric_profile(http: &reqwest::Client, mc: &str, wanted: Option<&str>) -> Result<FabricProfile> {
    let version = match wanted.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v.to_string(),
        None => {
            let all = fabric_versions(http, mc).await?;
            all.iter()
                .find(|(_, stable)| *stable)
                .or_else(|| all.first())
                .map(|(v, _)| v.clone())
                .ok_or_else(|| Error::Other(format!("Kein Fabric-Loader für Minecraft {mc}")))?
        }
    };
    let profile: FabricProfile = http
        .get(format!("{FABRIC_META}/{mc}/{version}/profile/json"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(profile)
}

/// Lädt die Fabric-Libraries und gibt ihre Pfade (für den Classpath, in dieser Reihenfolge) zurück.
pub async fn install_fabric(
    http: &reqwest::Client,
    cfg: &LauncherConfig,
    profile: &FabricProfile,
) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for lib in &profile.libraries {
        let Some(rel) = lib.path() else { continue };
        let dest = cfg.libraries_dir().join(&rel);
        let base = if lib.url.ends_with('/') { lib.url.clone() } else { format!("{}/", lib.url) };
        download_verified(http, &format!("{base}{rel}"), lib.sha1.as_deref().unwrap_or(""), &dest).await?;
        paths.push(dest);
    }
    Ok(paths)
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthVersion {
    project_id: String,
    files: Vec<ModrinthFile>,
    #[serde(default)]
    dependencies: Vec<ModrinthDep>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    hashes: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthDep {
    project_id: Option<String>,
    dependency_type: String,
}

/// Neueste Fabric-Version eines Modrinth-Mods (per Projekt-ID oder Slug) für diese Minecraft-Version in den
/// Mods-Ordner legen. Die Datei heißt „<Projekt-ID>--<Datei>“ – so liegt jede Mod nur einmal da, egal ob sie per
/// Slug oder ID angefragt wurde. Ist die Projekt-ID schon in {@code done}, wird nichts geladen. Gibt die Projekt-ID
/// und die Projekt-IDs der Pflicht-Abhängigkeiten zurück.
pub async fn install_modrinth_mod(
    http: &reqwest::Client,
    id: &str,
    mc: &str,
    loader: &str,
    mods_dir: &Path,
    done: &[String],
) -> Result<(String, Vec<String>)> {
    let url = format!(
        "{MODRINTH}/{id}/version?loaders=%5B%22{loader}%22%5D&game_versions=%5B%22{mc}%22%5D"
    );
    let versions: Vec<ModrinthVersion> = http.get(url).send().await?.error_for_status()?.json().await?;
    let Some(version) = versions.first() else {
        return Err(Error::Other(format!("{id} gibt es nicht als {}-Mod für Minecraft {mc}", crate::instance::loader_name(loader))));
    };
    let pid = version.project_id.clone();
    if done.contains(&pid) {
        return Ok((pid, Vec::new()));
    }
    let deps: Vec<String> = version
        .dependencies
        .iter()
        .filter(|d| d.dependency_type == "required")
        .filter_map(|d| d.project_id.clone())
        .collect();
    let Some(file) = version.files.iter().find(|f| f.primary).or_else(|| version.files.first()) else {
        return Ok((pid, deps));
    };
    std::fs::create_dir_all(mods_dir)?;
    let dest = mods_dir.join(format!("{pid}--{}", file.filename));
    if !dest.exists() {
        // alte Versionen dieses Mods entfernen
        if let Ok(entries) = std::fs::read_dir(mods_dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(&format!("{pid}--")) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let sha1 = file.hashes.get("sha1").cloned().unwrap_or_default();
    download_verified(http, &file.url, &sha1, &dest).await?;
    Ok((pid, deps))
}

/// Eine gewählte Mod-Datei.
pub struct ModPick {
    pub project_id: String,
    version: ModrinthVersion,
}

/// Ergebnis der Auflösung: gewählte Dateien, Mods ohne Fassung für Loader/Version, Mods mit Netzwerkfehler.
pub struct Resolution {
    pub picks: Vec<ModPick>,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
}

/// Mods samt Pflicht-Abhängigkeiten auflösen (jeweils die neueste Fassung für Loader + Minecraft-Version).
pub async fn resolve_mods(http: &reqwest::Client, top: &[String], mc: &str, loader: &str) -> Resolution {
    use std::collections::HashMap;
    // angefragte ID/Slug → Versionen (Err(true) = gibt es nicht, Err(false) = Netzwerkfehler)
    let mut cache: HashMap<String, std::result::Result<Vec<ModrinthVersion>, bool>> = HashMap::new();
    // Projekt-ID → (angefragte ID, Index in der Versionsliste)
    let mut picks: HashMap<String, (String, usize)> = HashMap::new();
    let mut missing = Vec::new();
    let mut errors = Vec::new();
    let mut queue: Vec<String> = top.iter().rev().cloned().collect();
    let mut steps = 0;
    while let Some(id) = queue.pop() {
        steps += 1;
        if steps > 300 {
            break;
        }
        if !cache.contains_key(&id) {
            let url = format!(
                "{MODRINTH}/{id}/version?loaders=%5B%22{loader}%22%5D&game_versions=%5B%22{mc}%22%5D"
            );
            let got = match http.get(url).send().await.and_then(|r| r.error_for_status()) {
                Ok(r) => r.json::<Vec<ModrinthVersion>>().await.map_err(|_| false),
                Err(e) => Err(e.status().map(|s| s.as_u16() == 404).unwrap_or(false)),
            };
            cache.insert(id.clone(), got);
        }
        let versions = match cache.get(&id) {
            Some(Ok(v)) if !v.is_empty() => v,
            Some(Err(false)) => {
                if !errors.contains(&id) {
                    errors.push(id.clone());
                }
                continue;
            }
            _ => {
                if !missing.contains(&id) {
                    missing.push(id.clone());
                }
                continue;
            }
        };
        let pid = versions[0].project_id.clone();
        if picks.contains_key(&pid) {
            continue;
        }
        let idx = 0; // neueste zuerst
        for dep in versions[idx].dependencies.iter().filter(|d| d.dependency_type == "required") {
            if let Some(dp) = &dep.project_id {
                queue.push(dp.clone());
            }
        }
        picks.insert(pid, (id, idx));
    }
    let mut out = Vec::new();
    for (pid, (id, idx)) in picks {
        if let Some(Ok(list)) = cache.get(&id) {
            if let Some(v) = list.get(idx) {
                out.push(ModPick { project_id: pid, version: v.clone() });
            }
        }
    }
    Resolution { picks: out, missing, errors }
}

/// Gewählte Datei als „<Projekt-ID>--<Datei>“ in den Mods-Ordner legen (ältere Fassungen dieser Mod fliegen raus).
pub async fn download_pick(http: &reqwest::Client, pick: &ModPick, mods_dir: &Path) -> Result<()> {
    let pid = &pick.project_id;
    let Some(file) = pick.version.files.iter().find(|f| f.primary).or_else(|| pick.version.files.first()) else {
        return Ok(());
    };
    std::fs::create_dir_all(mods_dir)?;
    let dest = mods_dir.join(format!("{pid}--{}", file.filename));
    if !dest.exists() {
        if let Ok(entries) = std::fs::read_dir(mods_dir) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with(&format!("{pid}--")) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let sha1 = file.hashes.get("sha1").cloned().unwrap_or_default();
    download_verified(http, &file.url, &sha1, &dest).await
}

/// Ressourcenpaket oder Shader von Modrinth in einen Ordner legen (neueste Datei für diese Minecraft-Version, sonst die
/// neueste überhaupt). Dateiname „<Projekt-ID>--<Datei>“. Gibt die Projekt-ID zurück.
pub async fn install_modrinth_pack(http: &reqwest::Client, id: &str, mc: &str, dir: &Path) -> Result<String> {
    let url = format!("{MODRINTH}/{id}/version?game_versions=%5B%22{mc}%22%5D");
    let mut versions: Vec<ModrinthVersion> = http.get(url).send().await?.error_for_status()?.json().await?;
    if versions.is_empty() {
        versions = http.get(format!("{MODRINTH}/{id}/version")).send().await?.error_for_status()?.json().await?;
    }
    let Some(version) = versions.first() else {
        return Err(Error::Other(format!("{id}: keine Datei gefunden")));
    };
    let pid = version.project_id.clone();
    let Some(file) = version.files.iter().find(|f| f.primary).or_else(|| version.files.first()) else {
        return Ok(pid);
    };
    std::fs::create_dir_all(dir)?;
    let new_name = format!("{pid}--{}", file.filename);
    let dest = dir.join(&new_name);
    if !dest.exists() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let old = e.file_name().to_string_lossy().to_string();
                if old.starts_with(&format!("{pid}--")) {
                    let _ = std::fs::remove_file(e.path());
                    if let Some(game_dir) = dir.parent() {
                        follow_iris_shader(game_dir, &old, &new_name);
                    }
                }
            }
        }
    }
    let sha1 = file.hashes.get("sha1").cloned().unwrap_or_default();
    download_verified(http, &file.url, &sha1, &dest).await?;
    Ok(pid)
}

/// Fassung einer Mod für einen anderen Loader (z. B. NeoForge-Jar in einer Fabric-Instanz) auf Modrinth suchen: erst über den SHA1 der Datei (stammt sie von
/// Modrinth, kennt man so das Projekt), sonst über den Namen (nur bei genau passendem Slug/Titel). Gibt Projekt-ID und
/// Titel zurück, wenn es das Projekt für Fabric + diese Minecraft-Version gibt.
pub async fn loader_twin(http: &reqwest::Client, jar: &Path, mc: &str, loader: &str) -> Option<(String, String)> {
    use sha1::{Digest, Sha1};
    #[derive(Deserialize)]
    struct VersionFile {
        project_id: String,
    }
    #[derive(Deserialize)]
    struct Project {
        id: String,
        title: String,
    }
    #[derive(Deserialize)]
    struct Hit {
        project_id: String,
        slug: String,
        title: String,
    }
    #[derive(Deserialize)]
    struct Search {
        hits: Vec<Hit>,
    }
    let api = "https://api.modrinth.com/v2";
    let bytes = std::fs::read(jar).ok()?;
    let sha = hex::encode(Sha1::digest(&bytes));
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(r) = http.get(format!("{api}/version_file/{sha}?algorithm=sha1")).send().await {
        if let Ok(v) = r.error_for_status() {
            if let Ok(v) = v.json::<VersionFile>().await {
                candidates.push(v.project_id);
            }
        }
    }
    // Name aus der Datei: „weatherglass-0.6.0-1.21.1-neoforge.jar“ → „weatherglass“
    let stem = jar.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let base: String = stem
        .split(|c: char| c == '-' || c == '_' || c == '+')
        .take_while(|p| !p.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true))
        .filter(|p| !matches!(*p, "neoforge" | "forge" | "fabric" | "mc"))
        .collect::<Vec<_>>()
        .join("-");
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    if !base.is_empty() {
        let url = format!(
            "{api}/search?query={base}&limit=5&facets=%5B%5B%22project_type:mod%22%5D,%5B%22categories:{loader}%22%5D,%5B%22versions:{mc}%22%5D%5D"
        );
        if let Ok(r) = http.get(url).send().await {
            if let Ok(s) = r.json::<Search>().await {
                for h in s.hits {
                    if norm(&h.slug) == norm(&base) || norm(&h.title) == norm(&base) {
                        candidates.push(h.project_id);
                    }
                }
            }
        }
    }
    for id in candidates {
        let url = format!("{MODRINTH}/{id}/version?loaders=%5B%22{loader}%22%5D&game_versions=%5B%22{mc}%22%5D");
        let Ok(r) = http.get(url).send().await else { continue };
        let Ok(list) = r.json::<Vec<ModrinthVersion>>().await else { continue };
        if list.is_empty() {
            continue;
        }
        let Ok(r) = http.get(format!("{MODRINTH}/{id}")).send().await else { continue };
        if let Ok(p) = r.json::<Project>().await {
            return Some((p.id, p.title));
        }
    }
    None
}

/// Wird eine Shader-Datei durch eine neuere Fassung ersetzt, zeigt Iris' Auswahl sonst ins Leere (Shader aus).
fn follow_iris_shader(game_dir: &Path, old: &str, new: &str) {
    let path = game_dir.join("config").join("iris.properties");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let mut changed = false;
    let out: Vec<String> = text
        .lines()
        .map(|l| {
            if l.trim() == format!("shaderPack={old}") {
                changed = true;
                format!("shaderPack={new}")
            } else {
                l.to_string()
            }
        })
        .collect();
    if changed {
        let _ = std::fs::write(&path, out.join("\n") + "\n");
    }
}

/// Mods entfernen, die der Launcher verwaltet (Dateien „<id>--…“), aber nicht mehr gewünscht sind
/// (abgeschaltet oder aus der Instanz entfernt). Eigene Dateien wie die NUTclient-Jar bleiben unberührt.
pub fn remove_unwanted(mods_dir: &Path, keep: &[String]) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(mods_dir) else {
        return Ok(());
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some((prefix, _)) = name.split_once("--") {
            if !keep.iter().any(|k| k == prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

/// NUTclient-Mod für diese Version in den Mods-Ordner kopieren (immer die mitgelieferte, aktuelle Fassung).
pub fn install_nutclient(source: &Path, mods_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(mods_dir)?;
    if let Ok(entries) = std::fs::read_dir(mods_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("nutclient") && name.ends_with(".jar") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "nutclient.jar".into());
    std::fs::copy(source, mods_dir.join(name))?;
    Ok(())
}

/// Launcher-Farbe für den Client hinterlegen (config/nutclient/launcher.json). `applied` wird nur zurückgesetzt,
/// wenn sich die Farbe geändert hat – im Spiel gewählte Farben bleiben sonst erhalten.
pub fn write_launcher_color(game_dir: &Path, accent: &str) -> Result<()> {
    let dir = game_dir.join("config").join("nutclient");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("launcher.json");
    let old: Option<serde_json::Value> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let same = old
        .as_ref()
        .and_then(|v| v.get("accent"))
        .and_then(|a| a.as_str())
        .map(|a| a.eq_ignore_ascii_case(accent))
        .unwrap_or(false);
    let applied = same
        && old
            .as_ref()
            .and_then(|v| v.get("applied"))
            .and_then(|a| a.as_bool())
            .unwrap_or(false);
    let json = serde_json::json!({ "accent": accent, "applied": applied });
    std::fs::write(file, serde_json::to_vec_pretty(&json)?)?;
    Ok(())
}

/// NeoForge-Fix-Mod (`nutfix-neoforge-<mc>.jar`, Quelle `neoforge-fixes/`) dazulegen, wenn eine Mod drin ist, deren
/// Fehler sie behebt (Weather2: Wetterdaten-Paket stürzt im LAN ab), sonst wieder entfernen.
pub fn sync_neo_fixes(resource_dir: Option<PathBuf>, mods_dir: &Path, mc: &str) {
    let name = format!("nutfix-neoforge-{mc}.jar");
    let target = mods_dir.join(&name);
    let needed = std::fs::read_dir(mods_dir)
        .map(|it| {
            it.flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.ends_with(".jar") && n.contains("weather2")
            })
        })
        .unwrap_or(false);
    let source = resource_dir
        .map(|d| d.join("mods").join(&name))
        .filter(|p| p.exists())
        .or_else(|| Some(std::env::current_dir().ok()?.join("resources").join("mods").join(&name)).filter(|p| p.exists()));
    match (needed, source) {
        (true, Some(src)) => {
            let _ = std::fs::copy(src, &target);
        }
        _ => {
            let _ = std::fs::remove_file(&target);
        }
    }
}

/// Mitgelieferte NUTclient-Jar für eine Minecraft-Version suchen: erst in den Ressourcen des Launchers
/// (`mods/nutclient-<version>.jar`), in der Entwicklung im Build-Ordner des Client-Projekts.
/// NUTclient Classic (neue Client-Fassung): `mods/nutclient-classic-<mc>.jar` aus den Ressourcen, in der Entwicklung
/// `../minecraft-client-26/build/libs/nutclient-classic-*+<mc>.jar` (`./gradlew build -Pclassic`). None = für diese Version nicht da.
pub fn find_classic_jar(resource_dir: Option<PathBuf>, mc: &str) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        let p = dir.join("mods").join(format!("nutclient-classic-{mc}.jar"));
        if p.exists() {
            return Some(p);
        }
    }
    let dev = std::env::current_dir().ok()?.parent()?.join("minecraft-client-26").join("build").join("libs");
    std::fs::read_dir(dev).ok()?.flatten().map(|e| e.path()).find(|p| {
        let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        n.starts_with("nutclient-classic-") && n.ends_with(&format!("+{mc}.jar")) && !n.contains("-sources")
    })
}

pub fn find_nutclient_jar(resource_dir: Option<PathBuf>, mc: &str) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        let p = dir.join("mods").join(format!("nutclient-{mc}.jar"));
        if p.exists() {
            return Some(p);
        }
    }
    // Entwicklung: ../minecraft-client/build/libs/<name>.jar (ohne -sources); 26.x liegt in
    // ../minecraft-client-26 und heißt nutclient-<mod>+<mc>.jar.
    let port = mc.starts_with("26.");
    let project = if port { "minecraft-client-26" } else { "minecraft-client" };
    let dev = std::env::current_dir().ok()?.parent()?.join(project).join("build").join("libs");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(dev).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".jar") || name.contains("-sources") || name.starts_with("nutclient-classic-")
            || (port && !name.ends_with(&format!("+{mc}.jar")))
        {
            continue;
        }
        let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
            best = Some((t, e.path()));
        }
    }
    best.map(|(_, p)| p)
}
