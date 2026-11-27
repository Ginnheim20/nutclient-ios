//! Modpacks in eine Instanz installieren.
//! - **Modrinth** (.mrpack, online per Projekt-ID oder als Datei): alle Dateien aus `modrinth.index.json` (nur, was der
//!   Client braucht) mit SHA1-Prüfung, danach `overrides/` und `client-overrides/` entpacken.
//! - **CurseForge** (.zip mit `manifest.json`): Ohne CurseForge-API-Schlüssel gibt es keine Download-Links zu den
//!   Datei-Nummern im Manifest. Deshalb werden die Mods aus `modlist.html` (Name + CurseForge-Slug) auf Modrinth
//!   gesucht (gleicher Slug, sonst gleicher Name) – passend zu Minecraft-Version und Loader. Nicht gefundene stehen
//!   in `missing`. Danach `overrides/` entpacken.
//! Vorhandene Dateien werden übersprungen – ein abgebrochener Download läuft beim nächsten Mal weiter.
use crate::error::{Error, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const API: &str = "https://api.modrinth.com/v2";
/// Gleichzeitige Downloads.
const PARALLEL: usize = 6;

#[derive(Deserialize)]
struct PackVersion {
    version_number: String,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    version_type: String,
    files: Vec<PackFile>,
}

#[derive(Deserialize)]
struct PackFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Index {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "versionId")]
    version_id: String,
    #[serde(default)]
    files: Vec<IndexFile>,
    #[serde(default)]
    dependencies: HashMap<String, String>,
}

#[derive(Deserialize)]
struct IndexFile {
    path: String,
    #[serde(default)]
    hashes: HashMap<String, String>,
    #[serde(default)]
    env: Option<Env>,
    #[serde(default)]
    downloads: Vec<String>,
}

#[derive(Deserialize)]
struct Env {
    #[serde(default)]
    client: String,
}

/// Ergebnis: womit die Instanz starten muss.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// Minecraft-Version, z. B. „1.21.1“.
    pub mc: String,
    /// „fabric“ oder „neoforge“.
    pub loader: String,
    /// Name des Packs (aus der Datei; leer, wenn unbekannt).
    pub name: String,
    /// Fassung des Packs.
    pub version: String,
    /// Anzahl der geladenen Dateien.
    pub files: usize,
    /// Nicht gefundene Mods (nur CurseForge-Import).
    pub missing: Vec<String>,
}

/// Pfad aus dem Pack sicher unter `root` auflösen (keine absoluten Pfade, kein „..“).
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    let mut out = root.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (out != root).then_some(out)
}

type Zip = zip::ZipArchive<std::io::Cursor<Vec<u8>>>;

fn open_zip(bytes: Vec<u8>) -> Result<Zip> {
    zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| Error::Other(format!("Datei beschädigt oder kein ZIP: {e}")))
}

fn read_text(zip: &mut Zip, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Alle Einträge unter `prefix` nach `game_dir` entpacken.
fn extract(zip: &mut Zip, prefix: &str, game_dir: &Path) -> Result<()> {
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| Error::Other(e.to_string()))?;
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix(prefix) else { continue };
        if rel.is_empty() || entry.is_dir() {
            continue;
        }
        let Some(dest) = safe_join(game_dir, rel) else { continue };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// Liste (url, sha1, ziel, anzeigename) parallel laden; gibt die Fehler zurück.
async fn download_all(
    http: &reqwest::Client,
    jobs: Vec<(String, String, PathBuf, String)>,
    progress: &impl Fn(usize, usize, &str),
) -> Vec<String> {
    let total = jobs.len().max(1);
    let mut done = 0usize;
    let mut failed = Vec::new();
    let mut stream = futures_util::stream::iter(jobs.into_iter().map(|(url, sha1, dest, name)| async move {
        let mut last = None;
        for _ in 0..3 {
            match super::install::download_verified(http, &url, &sha1, &dest).await {
                Ok(()) => return (name, None),
                Err(e) => last = Some(e.to_string()),
            }
        }
        (name, last)
    }))
    .buffer_unordered(PARALLEL);
    while let Some((name, err)) = stream.next().await {
        done += 1;
        if let Some(e) = err {
            failed.push(format!("{name}: {e}"));
        }
        progress(done, total, &name);
    }
    failed
}

/// Modrinth-Modpack `project_id` (online) in `game_dir` installieren.
pub async fn install(
    http: &reqwest::Client,
    project_id: &str,
    game_dir: &Path,
    progress: impl Fn(usize, usize, &str),
) -> Result<Installed> {
    progress(0, 1, "Modpack suchen");
    let versions: Vec<PackVersion> = http
        .get(format!("{API}/project/{project_id}/version"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let usable = |v: &&PackVersion| v.loaders.iter().any(|l| l == "fabric" || l == "neoforge");
    // neueste stabile Fassung, sonst die neueste überhaupt (Modrinth liefert neueste zuerst)
    let version = versions
        .iter()
        .filter(usable)
        .find(|v| v.version_type == "release")
        .or_else(|| versions.iter().find(usable))
        .ok_or_else(|| Error::Other("Dieses Modpack gibt es nicht für Fabric oder NeoForge (Forge/Quilt werden nicht unterstützt)".into()))?;
    let file = version
        .files
        .iter()
        .find(|f| f.primary && f.filename.ends_with(".mrpack"))
        .or_else(|| version.files.iter().find(|f| f.filename.ends_with(".mrpack")))
        .ok_or_else(|| Error::Other("Modpack ohne .mrpack-Datei".into()))?;

    progress(0, 1, "Modpack laden");
    let bytes = http.get(&file.url).send().await?.error_for_status()?.bytes().await?;
    let mut res = install_mrpack(http, open_zip(bytes.to_vec())?, game_dir, &progress).await?;
    res.version = version.version_number.clone();
    Ok(res)
}

/// Modpack aus einer Datei (.mrpack von Modrinth oder .zip von CurseForge) in `game_dir` installieren.
pub async fn install_file(
    http: &reqwest::Client,
    path: &Path,
    game_dir: &Path,
    progress: impl Fn(usize, usize, &str),
) -> Result<Installed> {
    progress(0, 1, "Datei lesen");
    let mut zip = open_zip(std::fs::read(path)?)?;
    if zip.by_name("modrinth.index.json").is_ok() {
        return install_mrpack(http, zip, game_dir, &progress).await;
    }
    if zip.by_name("manifest.json").is_ok() {
        return install_curseforge(http, zip, game_dir, &progress).await;
    }
    Err(Error::Other("Kein Modpack: weder modrinth.index.json (Modrinth) noch manifest.json (CurseForge) gefunden".into()))
}

async fn install_mrpack(http: &reqwest::Client, mut zip: Zip, game_dir: &Path, progress: &impl Fn(usize, usize, &str)) -> Result<Installed> {
    let index: Index = serde_json::from_str(
        &read_text(&mut zip, "modrinth.index.json").ok_or_else(|| Error::Other("Modpack ohne modrinth.index.json".into()))?,
    )?;
    let mc = index
        .dependencies
        .get("minecraft")
        .cloned()
        .ok_or_else(|| Error::Other("Modpack ohne Minecraft-Version".into()))?;
    let loader = if index.dependencies.contains_key("neoforge") {
        "neoforge"
    } else if index.dependencies.contains_key("fabric-loader") {
        "fabric"
    } else if index.dependencies.contains_key("quilt-loader") {
        return Err(Error::Other("Quilt-Modpacks werden nicht unterstützt".into()));
    } else if index.dependencies.contains_key("forge") {
        return Err(Error::Other("Forge-Modpacks werden nicht unterstützt".into()));
    } else {
        "fabric"
    };

    let mut jobs = Vec::new();
    for f in index.files.iter().filter(|f| f.env.as_ref().map(|e| e.client != "unsupported").unwrap_or(true)) {
        let dest = safe_join(game_dir, &f.path).ok_or_else(|| Error::Other(format!("Ungültiger Pfad im Modpack: {}", f.path)))?;
        let url = f
            .downloads
            .iter()
            .find(|u| u.starts_with("https://"))
            .cloned()
            .ok_or_else(|| Error::Other(format!("Kein Download für {}", f.path)))?;
        let sha1 = f.hashes.get("sha1").cloned().unwrap_or_default();
        let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        jobs.push((url, sha1, dest, name));
    }
    let total = jobs.len();
    progress(0, total.max(1), "Mods laden");
    let failed = download_all(http, jobs, progress).await;
    if !failed.is_empty() {
        return Err(Error::Other(format!(
            "{} von {total} Dateien nicht geladen – beim nächsten Versuch geht es weiter ({})",
            failed.len(),
            failed[0]
        )));
    }

    progress(total, total.max(1), "Einstellungen entpacken");
    extract(&mut zip, "overrides/", game_dir)?;
    extract(&mut zip, "client-overrides/", game_dir)?;
    Ok(Installed {
        mc,
        loader: loader.to_string(),
        name: index.name,
        version: index.version_id,
        files: total,
        missing: Vec::new(),
    })
}

// ---- CurseForge ---------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct CfManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    minecraft: CfMinecraft,
    #[serde(default)]
    overrides: Option<String>,
}

#[derive(Deserialize)]
struct CfMinecraft {
    version: String,
    #[serde(default, rename = "modLoaders")]
    mod_loaders: Vec<CfLoader>,
}

#[derive(Deserialize)]
struct CfLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}

#[derive(Deserialize)]
struct SearchPage {
    #[serde(default)]
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    project_id: String,
    slug: String,
    title: String,
}

/// Eintrag aus `modlist.html`: Art (Ordner), CurseForge-Slug, Name.
struct CfEntry {
    kind: &'static str,
    slug: String,
    name: String,
}

/// `<li><a href="https://www.curseforge.com/minecraft/mc-mods/jei">Just Enough Items (by mezz)</a></li>` → Einträge.
fn parse_modlist(html: &str) -> Vec<CfEntry> {
    let mut out = Vec::new();
    for part in html.split("href=\"").skip(1) {
        let Some(end) = part.find('"') else { continue };
        let url = &part[..end];
        let segs: Vec<&str> = url.trim_end_matches('/').split('/').collect();
        let (Some(slug), Some(cat)) = (segs.last(), segs.len().checked_sub(2).and_then(|i| segs.get(i))) else { continue };
        let kind = match *cat {
            "mc-mods" => "mod",
            "texture-packs" => "resourcepack",
            "shaders" => "shader",
            _ => continue,
        };
        let text = part[end..].split('>').nth(1).and_then(|t| t.split('<').next()).unwrap_or(slug).trim();
        let name = match text.rfind(" (by ") {
            Some(i) => &text[..i],
            None => text,
        };
        out.push(CfEntry { kind, slug: slug.to_string(), name: html_unescape(name) });
    }
    out
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">")
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// Name ohne Zusätze in Klammern: „FerriteCore ((Neo)Forge)“ → „FerriteCore“,
/// „YUNG's API (NeoForge) [1.20.4-1.21.1 ONLY]“ → „YUNG's API“.
fn clean_name(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let t = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        s.trim().to_string()
    } else {
        t
    }
}

/// Wörter sortiert („Skin Layers 3D“ = „3D Skin Layers“).
fn words(s: &str) -> Vec<String> {
    let mut w: Vec<String> = s
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect();
    w.sort();
    w
}

/// Neueste passende Datei eines Modrinth-Projekts (Mods: Loader + Version; Pakete: Version, sonst neueste).
async fn modrinth_file(http: &reqwest::Client, id: &str, kind: &str, mc: &str, loader: &str) -> Option<PackFile> {
    let url = format!("{API}/project/{id}/version");
    let mut req = http.get(&url).query(&[("game_versions", format!("[\"{mc}\"]"))]);
    if kind == "mod" {
        req = req.query(&[("loaders", format!("[\"{loader}\"]"))]);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mut versions: Vec<PackVersion> = resp.json().await.ok()?;
    if versions.is_empty() && kind != "mod" {
        versions = http.get(&url).send().await.ok()?.json().await.ok()?;
    }
    let v = versions.into_iter().next()?;
    let mut files = v.files;
    let i = files.iter().position(|f| f.primary).unwrap_or(0);
    (i < files.len()).then(|| files.swap_remove(i))
}

/// Mod auf Modrinth finden: erst gleicher Slug, dann Suche nach gleichem Namen.
async fn find_on_modrinth(http: &reqwest::Client, e: &CfEntry, mc: &str, loader: &str) -> Option<PackFile> {
    if let Some(f) = modrinth_file(http, &e.slug, e.kind, mc, loader).await {
        return Some(f);
    }
    let ptype = if e.kind == "shader" { "shader" } else { e.kind };
    let facets = if e.kind == "mod" {
        format!("[[\"project_type:mod\"],[\"categories:{loader}\"],[\"versions:{mc}\"]]")
    } else {
        format!("[[\"project_type:{ptype}\"]]")
    };
    let clean = clean_name(&e.name);
    let page: SearchPage = http
        .get(format!("{API}/search"))
        .query(&[("query", clean.as_str()), ("facets", facets.as_str()), ("limit", "10")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let want = norm(&clean);
    let want_words = words(&clean);
    let cf_slug = norm(&e.slug);
    let hit = page.hits.iter().find(|h| {
        let t = clean_name(&h.title);
        norm(&t) == want || words(&t) == want_words || h.slug == e.slug || norm(&h.slug) == cf_slug
    })?;
    modrinth_file(http, &hit.project_id, e.kind, mc, loader).await
}

async fn install_curseforge(http: &reqwest::Client, mut zip: Zip, game_dir: &Path, progress: &impl Fn(usize, usize, &str)) -> Result<Installed> {
    let manifest: CfManifest = serde_json::from_str(
        &read_text(&mut zip, "manifest.json").ok_or_else(|| Error::Other("CurseForge-Pack ohne manifest.json".into()))?,
    )?;
    let mc = manifest.minecraft.version.clone();
    let primary = manifest
        .minecraft
        .mod_loaders
        .iter()
        .find(|l| l.primary)
        .or_else(|| manifest.minecraft.mod_loaders.first())
        .map(|l| l.id.to_lowercase())
        .unwrap_or_default();
    let loader = if primary.starts_with("neoforge") {
        "neoforge"
    } else if primary.starts_with("fabric") || primary.is_empty() {
        "fabric"
    } else if primary.starts_with("forge") {
        return Err(Error::Other(format!("„{}“ ist ein Forge-Modpack – Forge wird nicht unterstützt (nur Fabric und NeoForge)", manifest.name)));
    } else {
        return Err(Error::Other(format!("Loader „{primary}“ wird nicht unterstützt (nur Fabric und NeoForge)")));
    };
    let entries = parse_modlist(&read_text(&mut zip, "modlist.html").unwrap_or_default());
    if entries.is_empty() {
        return Err(Error::Other("Im Pack fehlt die Mod-Liste (modlist.html) – ohne CurseForge-Schlüssel lassen sich die Mods nicht finden".into()));
    }

    // 1) jede Mod auf Modrinth suchen
    let total = entries.len();
    progress(0, total, "Mods suchen");
    let mut found: Vec<(String, String, PathBuf, String)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    {
        let mc_ref = mc.as_str();
        let mut done = 0usize;
        let mc_owned = mc_ref.to_string();
        let mut stream = futures_util::stream::iter(entries.into_iter().map(|e| {
            let mc = mc_owned.clone();
            async move {
                let f = find_on_modrinth(http, &e, &mc, loader).await;
                (e, f)
            }
        }))
            .buffer_unordered(PARALLEL);
        while let Some((e, file)) = stream.next().await {
            done += 1;
            progress(done, total * 2, &format!("Suche: {}", e.name));
            match file {
                Some(f) => {
                    let folder = match e.kind {
                        "resourcepack" => "resourcepacks",
                        "shader" => "shaderpacks",
                        _ => "mods",
                    };
                    let Some(dest) = safe_join(&game_dir.join(folder), &f.filename) else { continue };
                    let sha1 = f.hashes.get("sha1").cloned().unwrap_or_default();
                    found.push((f.url, sha1, dest, e.name.clone()));
                }
                None => missing.push(e.name.clone()),
            }
        }
    }

    // 2) laden (Fortschritt läuft in der zweiten Hälfte des Balkens weiter)
    let n = found.len();
    let failed = download_all(http, found, &|d: usize, _t: usize, m: &str| progress(total + d * total / n.max(1), total * 2, m)).await;
    if !failed.is_empty() {
        return Err(Error::Other(format!("{} Dateien nicht geladen – beim nächsten Versuch geht es weiter ({})", failed.len(), failed[0])));
    }

    progress(total * 2, total * 2, "Einstellungen entpacken");
    let overrides = manifest.overrides.clone().unwrap_or_else(|| "overrides".into());
    extract(&mut zip, &format!("{}/", overrides.trim_end_matches('/')), game_dir)?;
    missing.sort();
    Ok(Installed { mc, loader: loader.to_string(), name: manifest.name, version: manifest.version, files: n, missing })
}
