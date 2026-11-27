use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Netzwerkfehler: {0}")]
    Http(#[from] reqwest::Error),

    #[error("IO-Fehler: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON-Fehler: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Authentifizierung nicht abgeschlossen")]
    NotAuthenticated,

    #[error("Version '{0}' nicht gefunden")]
    VersionNotFound(String),

    #[error("Hash stimmt nicht überein für {0}")]
    HashMismatch(String),

    #[error("{0}")]
    Other(String),
}

// Damit `Error` über Tauri-Commands ans Frontend zurückgegeben werden kann.
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
