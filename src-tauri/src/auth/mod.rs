use serde::{Deserialize, Serialize};

use crate::config::LauncherConfig;
use crate::error::{Error, Result};

pub mod microsoft;

/// Ein angemeldetes Spielerkonto. `access_token` bleibt im Backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    pub uuid: String,
    #[serde(skip_serializing, default)]
    pub access_token: String,
    /// Microsoft-Refresh-Token für stilles Erneuern.
    #[serde(skip_serializing, default)]
    pub refresh_token: String,
    /// Offline-Konto (kein Microsoft-Login, nur zum Testen / für Offline-Server).
    #[serde(default)]
    pub offline: bool,
}

/// Reduzierte Sicht, die ans Frontend geht.
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub username: String,
    pub uuid: String,
    pub offline: bool,
}

impl From<&Account> for AccountView {
    fn from(a: &Account) -> Self {
        Self {
            username: a.username.clone(),
            uuid: a.uuid.clone(),
            offline: a.offline,
        }
    }
}

/// Offline-UUID wie in Vanilla: `UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`
/// (namensbasierte UUID v3 über MD5).
pub fn offline_uuid(name: &str) -> String {
    let mut hash = md5::compute(format!("OfflinePlayer:{name}").as_bytes()).0;
    hash[6] = (hash[6] & 0x0f) | 0x30; // Version 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // Variante RFC 4122
    hex::encode(hash)
}

/// Legt ein Offline-Konto an und speichert es als aktives Konto.
pub fn offline_account(cfg: &LauncherConfig, username: &str) -> Result<Account> {
    let name = username.trim();
    if name.is_empty() || name.len() > 16 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(Error::Other(
            "Ungültiger Name: 1–16 Zeichen, nur Buchstaben, Ziffern, Unterstrich.".into(),
        ));
    }
    let acc = Account {
        username: name.to_string(),
        uuid: offline_uuid(name),
        access_token: String::new(),
        refresh_token: String::new(),
        offline: true,
    };
    save_account(cfg, &acc)?;
    Ok(acc)
}

pub fn load_account(cfg: &LauncherConfig) -> Result<Option<Account>> {
    let path = cfg.account_file();
    if !path.exists() {
        return Ok(None);
    }
    let acc: Account = serde_json::from_slice(&std::fs::read(path)?)?;
    Ok(Some(acc))
}

pub fn save_account(cfg: &LauncherConfig, acc: &Account) -> Result<()> {
    cfg.ensure_dirs()?;
    // Hinweis: für die Grundlage im Klartext. Später: OS-Keychain / Verschlüsselung.
    std::fs::write(cfg.account_file(), serde_json::to_vec_pretty(acc)?)?;
    Ok(())
}

pub fn require_account(cfg: &LauncherConfig) -> Result<Account> {
    load_account(cfg)?.ok_or(Error::NotAuthenticated)
}
