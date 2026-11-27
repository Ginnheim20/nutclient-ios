//! Block-Texturen als Profilbilder: werden aus der bereits heruntergeladenen Minecraft-Jar gelesen (nichts wird
//! mitgeliefert). Nur einfache 16×16-Bilder – animierte Streifen (Wasser, Lava …) fallen raus.

use std::io::Read;
use std::path::PathBuf;

use base64::Engine;
use serde::Serialize;

use crate::config::LauncherConfig;
use crate::error::{Error, Result};

#[derive(Serialize)]
pub struct BlockTexture {
    pub name: String,
    /// `data:image/png;base64,…`
    pub url: String,
}

/// Neueste vorhandene Client-Jar unter `versions/<id>/<id>.jar`.
fn newest_client_jar(cfg: &LauncherConfig) -> Option<PathBuf> {
    let dir = cfg.root.join("versions");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        let jar = e.path().join(format!("{id}.jar"));
        if let Ok(meta) = std::fs::metadata(&jar) {
            let t = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                best = Some((t, jar));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Breite und Höhe aus dem PNG-Kopf (IHDR).
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[1..4] != b"PNG" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

/// Alle 16×16-Blocktexturen der neuesten installierten Version.
pub fn list(cfg: &LauncherConfig) -> Result<Vec<BlockTexture>> {
    let jar = newest_client_jar(cfg)
        .ok_or_else(|| Error::Other("Noch keine Minecraft-Version heruntergeladen – einmal spielen, dann gibt es Texturen.".into()))?;
    let file = std::fs::File::open(jar)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| Error::Other(e.to_string()))?;
    let prefix = "assets/minecraft/textures/block/";
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| Error::Other(e.to_string()))?;
        let name = entry.name().to_string();
        if !name.starts_with(prefix) || !name.ends_with(".png") || name[prefix.len()..].contains('/') {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        if png_size(&bytes) != Some((16, 16)) {
            continue;
        }
        let short = name[prefix.len()..name.len() - 4].to_string();
        let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
        out.push(BlockTexture { name: short, url });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
