use std::path::PathBuf;

/// Zentrale Pfad- und Einstellungsverwaltung des Launchers.
#[derive(Debug, Clone)]
pub struct LauncherConfig {
    /// Wurzelverzeichnis, entspricht dem klassischen `.minecraft`.
    pub root: PathBuf,
}

impl LauncherConfig {
    pub fn load() -> Self {
        // iPhone: die App darf nur in ihren eigenen Ordner schreiben (HOME = App-Container) → Library/Application Support
        #[cfg(target_os = "ios")]
        let root = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support/nutclient-launcher");
        #[cfg(not(target_os = "ios"))]
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("nutclient-launcher");
        Self { root }
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn libraries_dir(&self) -> PathBuf {
        self.root.join("libraries")
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    pub fn version_dir(&self, id: &str) -> PathBuf {
        self.versions_dir().join(id)
    }

    /// Datei, in der das Konto (inkl. Refresh-Token) verschlüsselt/lokal abgelegt wird.
    pub fn account_file(&self) -> PathBuf {
        self.root.join("account.json")
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            self.versions_dir(),
            self.libraries_dir(),
            self.assets_dir().join("objects"),
            self.assets_dir().join("indexes"),
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}
