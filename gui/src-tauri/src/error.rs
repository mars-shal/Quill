use serde::{Serialize, Serializer};

/// Serializable error type returned across the Tauri IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("credential store error: {0}")]
    Keyring(String),

    #[error("validation failed: {0}")]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),

    /// The sync server could not be reached.
    ///
    /// Kept distinct from every other variant because it is an expected
    /// condition rather than a fault: Quill is local-first, so an absent server
    /// must degrade to fully offline use and must never surface as an error the
    /// reader has to dismiss.
    #[error("the sync server is unreachable")]
    Offline,

    #[error("{0}")]
    Other(String),
}

impl From<keyring::Error> for AppError {
    fn from(value: keyring::Error) -> Self {
        AppError::Keyring(value.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::Other(value.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
