//! Instanz als Modrinth-Modpack (.mrpack) exportieren – zum Weitergeben an Freunde.
//! Mods/Ressourcenpakete/Shader, die es auf Modrinth gibt, stehen nur als Download-Verweis im Pack (die Autoren
//! bekommen ihre Downloads, das Pack bleibt klein); alles andere und `config/` kommt als `overrides/` mit hinein.
//! Der NUTclient selbst bleibt draußen (den legt der Launcher beim Start dazu), ausgeschaltete Dateien auch.
use crate::error::{Error, Result};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const API: &str = "https://api.modrinth.com/v2";

struct Entry {
    /// Pfad im Spielordner, z. B. „mods/sodium.jar“ (Datei auf der Platte).
    disk: PathBuf,
    /// Ordner im Pack („mods“, „resourcepacks“, „shaderpacks“).
    folder: &'static str,
    file: String,
    sha1: String,
}

fn files_in(dir: &Path, folder: &'static str, ext: &str) -> Vec<Entry> {
    let Ok(rd) = std::fs::read_dir(dir.join(folder)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !path.is_file() || !lower.ends_with(ext) || (lower.starts_with("nutclient") && lower.ends_with(".jar")) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        out.push(Entry { disk: path, folder, file: name, sha1: hex::encode(Sha1::digest(&bytes)) });
    }
    out
}

/// Dateiname ohne Zeichen, die Windows nicht mag.
fn safe_name(s: &str) -> String {
    let t: String = s.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches('.').to_string();
    if t.is_empty() { "Modpack".into() } else { t }
}

fn add_dir(zip: &mut zip::ZipWriter<std::fs::File>, root: &Path, rel: &str, opts: zip::write::SimpleFileOptions) -> Result<()> {
    let base = root.join(rel);
    let Ok(rd) = std::fs::read_dir(&base) else { return Ok(()) };
    for e in rd.flatten() {
        let p = e.path();
        let file = e.file_name().to_string_lossy().to_lowercase();
        // Persönliches bleibt draußen: NUTclient-Daten (YouTube-Zugang, Profile …), Konten, Tokens, Passwörter
        if rel == "config" && file == "nutclient"
            || ["account", "token", "secret", "password", "passwort", "auth", "session", "credential"].iter().any(|w| file.contains(w))
        {
            continue;
        }
        let name = format!("{rel}/{}", e.file_name().to_string_lossy());
        if p.is_dir() {
            add_dir(zip, root, &name, opts)?;
        } else if p.is_file() {
            zip.start_file(format!("overrides/{name}"), opts).map_err(|e| Error::Other(e.to_string()))?;
            zip.write_all(&std::fs::read(&p)?)?;
        }
    }
    Ok(())
}

pub async fn mrpack(
    http: &reqwest::Client,
    game_dir: &Path,
    name: &str,
    mc: &str,
    loader: &str,
    loader_version: Option<&str>,
) -> Result<PathBuf> {
    // Loader-Version: gewählte, sonst die, mit der der Launcher startet (neueste stabile)
    let loader_version = match loader_version.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v.to_string(),
        None if loader == "neoforge" => crate::minecraft::neoforge::latest(http, mc).await?,
        None => {
            let all = crate::minecraft::profile::fabric_versions(http, mc).await?;
            all.iter().find(|(_, s)| *s).or_else(|| all.first()).map(|(v, _)| v.clone()).unwrap_or_default()
        }
    };

    let mut entries = files_in(game_dir, "mods", ".jar");
    entries.extend(files_in(game_dir, "resourcepacks", ".zip"));
    entries.extend(files_in(game_dir, "shaderpacks", ".zip"));

    // Welche Dateien kennt Modrinth? (eine Anfrage für alle)
    let hashes: Vec<&str> = entries.iter().map(|e| e.sha1.as_str()).collect();
    let known: HashMap<String, Value> = if hashes.is_empty() {
        HashMap::new()
    } else {
        http.post(format!("{API}/version_files"))
            .json(&json!({ "hashes": hashes, "algorithm": "sha1" }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?
    };

    let mut files = Vec::new();
    let mut extra: Vec<&Entry> = Vec::new();
    for e in &entries {
        let file = known.get(&e.sha1).and_then(|v| {
            v.get("files")?.as_array()?.iter().find(|f| f.pointer("/hashes/sha1").and_then(|h| h.as_str()) == Some(e.sha1.as_str())).cloned()
        });
        match file {
            Some(f) => {
                let filename = f.get("filename").and_then(|x| x.as_str()).unwrap_or(&e.file).to_string();
                files.push(json!({
                    "path": format!("{}/{}", e.folder, filename),
                    "hashes": { "sha1": e.sha1, "sha512": f.pointer("/hashes/sha512").cloned().unwrap_or(Value::Null) },
                    "env": { "client": "required", "server": if e.folder == "mods" { "optional" } else { "unsupported" } },
                    "downloads": [f.get("url").cloned().unwrap_or(Value::Null)],
                    "fileSize": f.get("size").cloned().unwrap_or(json!(0)),
                }));
            }
            None => extra.push(e),
        }
    }

    let dep_key = if loader == "neoforge" { "neoforge" } else { "fabric-loader" };
    let mut deps = serde_json::Map::new();
    deps.insert("minecraft".into(), json!(mc));
    if loader == "neoforge" || loader == "fabric" || !loader_version.is_empty() {
        deps.insert(dep_key.into(), json!(loader_version));
    }
    let index = json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": name,
        "summary": "Exportiert mit dem NUTclient Launcher",
        "files": files,
        "dependencies": deps,
    });

    let out_dir = std::env::var_os("NUT_EXPORT_DIR")
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .unwrap_or_else(|| game_dir.to_path_buf());
    std::fs::create_dir_all(&out_dir)?;
    let base = safe_name(name);
    let mut out = out_dir.join(format!("{base}.mrpack"));
    let mut n = 2;
    while out.exists() {
        out = out_dir.join(format!("{base} ({n}).mrpack"));
        n += 1;
    }
    let file = std::fs::File::create(&out)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("modrinth.index.json", opts).map_err(|e| Error::Other(e.to_string()))?;
    zip.write_all(serde_json::to_string_pretty(&index)?.as_bytes())?;
    // Dateien, die Modrinth nicht kennt (eigene Jars, CurseForge-Mods …), direkt ins Pack
    for e in extra {
        zip.start_file(format!("overrides/{}/{}", e.folder, e.file), opts).map_err(|er| Error::Other(er.to_string()))?;
        zip.write_all(&std::fs::read(&e.disk)?)?;
    }
    add_dir(&mut zip, game_dir, "config", opts)?;
    zip.finish().map_err(|e| Error::Other(e.to_string()))?;
    Ok(out)
}
