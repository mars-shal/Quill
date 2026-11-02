//! Reading an image off disk for use as a texture or a wallpaper.
//!
//! The webview cannot read files, and that is deliberate:
//! `capabilities/default.json` grants only `core:default`, `dialog:default`,
//! `opener:default` and `window-state:default`, and the file says so in its own
//! description. The obvious fix -- adding `@tauri-apps/plugin-fs` and an
//! `assetProtocol` block, then letting CSS load `file://` -- would hand a
//! content renderer read access to the user's disk so that one background image
//! could work. A `data:` URL is the narrow version of the same capability: the
//! dialog plugin chooses a path, Rust reads exactly that one file, and the
//! webview only ever sees a string.
//!
//! The validation is the substance of this module. A `data:` URL carrying a
//! multi-megabyte image is a settings row that gets read, parsed, and written to
//! SQLite on every launch, and the reader has no way to tell which of their
//! themes is the one that made startup slow. The limits are checked before the
//! file is read, and the errors name the number rather than saying "too large".
//!
//! `base64` is already a dependency, so this needs no new crate.

use std::path::Path;

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// The extensions accepted, and the media type each one maps to.
///
/// A fixed list rather than a sniffed type: an extension is what the reader
/// chose in the dialog, it is what the dialog's own filter will have offered,
/// and an allowlist means a file called `theme.png` that is actually a shell
/// script is refused rather than handed to the webview as `image/png`.
const ACCEPTED: [(&str, &str); 6] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
];

/// Room for `data:<media-type>;base64,`, the longest of which is
/// `data:image/svg+xml;base64,`.
const DATA_URL_PREFIX_ROOM: u64 = 64;

/// The largest file accepted, in bytes.
///
/// This is derived from the stored cap rather than picked alongside it, because
/// base64 inflates by four thirds and the two numbers have to agree. Choosing
/// 4 MB here against a 4 MB stored cap looked fine and was not: a 3.5 MB photo
/// passed every check in this module, was shown in the picker, and was then
/// dropped without a word on save, because its encoded form no longer fit the
/// settings row. So the file cap is whatever fits the stored cap once encoded,
/// and the assertion below fails the build if that ever stops being true.
pub const MAX_BYTES: u64 =
    ((crate::settings::MAX_IMAGE_DATA_BYTES as u64 - DATA_URL_PREFIX_ROOM) / 4) * 3;

/// The limit as a whole number of megabytes, for the error message. Rounded up,
/// because rounding down tells a reader their 3 MB file is over a 2 MB limit.
const MAX_MB: u64 = MAX_BYTES.div_ceil(1024 * 1024);

/// SVG gets the same byte cap as everything else for a reason worth stating: an
/// SVG is markup, and a 20MB one is a script-sized payload the renderer will
/// parse. Three megabytes is generous for a vector texture and still refuses
/// the pathological case.
///
/// This assertion is the whole point of deriving `MAX_BYTES` above: it is the
/// statement that every file we accept can be stored.
const _: () = assert!(
    MAX_BYTES.div_ceil(3) * 4 + DATA_URL_PREFIX_ROOM
        <= crate::settings::MAX_IMAGE_DATA_BYTES as u64,
    "an accepted file must always fit the stored data-URL cap"
);

/// `Debug` is derived so a test's `expect_err` can print the value it did not
/// expect. Without it the compiler asks for the trait, and the alternative is a
/// hand-written formatter that says less.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    /// A `data:` URL, ready to be assigned to `background-image`.
    pub data_url: String,
    pub media_type: String,
    pub byte_len: u64,
    /// The file's own name, for showing in the settings row.
    pub file_name: String,
}

/// The media type for a path, or a validation error naming what is allowed.
fn media_type_for(path: &Path) -> AppResult<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ACCEPTED
        .iter()
        .find(|(name, _)| *name == extension)
        .map(|(_, media_type)| *media_type)
        .ok_or_else(|| {
            // The list is built from ACCEPTED rather than written out, so a new
            // extension cannot be accepted here and missing from the message.
            let allowed: Vec<&str> = ACCEPTED.iter().map(|(name, _)| *name).collect();
            AppError::Validation(format!(
                "{} is not an image Quill can use. Choose one of: {}.",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("that file"),
                allowed.join(", ")
            ))
        })
}

/// Reads a file and returns it as a `data:` URL.
///
/// The order is deliberate: the path is checked for a shape that can be read at
/// all, the extension is checked, the size is checked, and only then is anything
/// opened. An extension check that runs after the read has already paid the cost
/// it was supposed to prevent.
pub fn read_image_as_data_url(path: &Path) -> AppResult<ImageData> {
    let media_type = media_type_for(path)?;

    let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => AppError::Validation(format!(
            "{} is no longer there. Pick the file again.",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("That file")
        )),
        std::io::ErrorKind::PermissionDenied => AppError::Validation(
            "Quill is not allowed to read that file. Move it somewhere readable, or use one of the bundled textures.".into(),
        ),
        _ => AppError::Other(format!("could not read that image: {error}")),
    })?;

    if !metadata.is_file() {
        return Err(AppError::Validation(
            "That is a folder, not an image.".into(),
        ));
    }

    let byte_len = metadata.len();
    if byte_len == 0 {
        return Err(AppError::Validation("That image is empty.".into()));
    }
    if byte_len > MAX_BYTES {
        return Err(AppError::Validation(format!(
            "That image is {} MB. The limit is {} MB.",
            byte_len.div_ceil(1024 * 1024),
            MAX_MB
        )));
    }

    let bytes = std::fs::read(path)
        .map_err(|error| AppError::Other(format!("could not read that image: {error}")))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageData {
        // `data_url` is a data URL, not a URL: it never leaves the process, so
        // it needs no escaping beyond the base64 alphabet, and it is what
        // `img-src data:` in the CSP already permits.
        data_url: format!("data:{media_type};base64,{encoded}"),
        media_type: media_type.to_string(),
        byte_len,
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    /// A temp file that removes itself, so the tests do not leave artefacts in
    /// the repo and do not depend on the order they run in.
    struct TempFile(PathBuf);

    impl TempFile {
        fn new(name: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!("quill-image-test-{name}"));
            let mut file = std::fs::File::create(&path).expect("create temp file");
            file.write_all(bytes).expect("write temp file");
            TempFile(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    // A one-pixel PNG. The bytes matter only in that they are a real file; the
    // module does not decode, and pretending it does would be the first place a
    // real decoder would belong.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89,
    ];

    #[test]
    fn a_png_round_trips_to_a_data_url() {
        let file = TempFile::new("round-trip.png", PNG);
        let image = read_image_as_data_url(&file.0).expect("a png is readable");

        assert_eq!(image.media_type, "image/png");
        assert_eq!(image.byte_len, PNG.len() as u64);
        // The name comes from the path, not from a fixed list, because the
        // settings row shows it back to the reader.
        assert_eq!(image.file_name, "quill-image-test-round-trip.png");
        assert!(image.data_url.starts_with("data:image/png;base64,"));

        // The payload is the file, so a round trip is verifiable rather than
        // merely plausible: decode it and compare.
        let encoded = image
            .data_url
            .split_once("base64,")
            .expect("a base64 data url")
            .1;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("the payload is base64");
        assert_eq!(decoded, PNG);
    }

    #[test]
    fn every_accepted_extension_maps_to_its_media_type() {
        for (extension, expected) in ACCEPTED {
            let file = TempFile::new(&format!("accept.{extension}"), b"x");
            let image = read_image_as_data_url(&file.0).expect("an accepted extension is readable");
            assert_eq!(image.media_type, expected, "{extension}");
            assert!(image
                .data_url
                .starts_with(&format!("data:{expected};base64,")));
        }
    }

    #[test]
    fn the_extension_check_is_case_insensitive() {
        // A macOS filesystem is case-insensitive by default, so a file can
        // arrive as `PHOTO.PNG` and be refused by a naive lowercase comparison
        // that only handles the other direction.
        let file = TempFile::new("upper.PNG", PNG);
        let image = read_image_as_data_url(&file.0).expect("PNG is PNG");
        assert_eq!(image.media_type, "image/png");
    }

    #[test]
    fn a_wrong_extension_is_refused_with_the_allowed_list() {
        let file = TempFile::new("payload.png.bak", PNG);
        let error = read_image_as_data_url(&file.0).expect_err("a .bak is not an image");
        let message = error.to_string();
        // The name, so the reader knows which file was rejected...
        assert!(
            message.contains("payload.png.bak"),
            "message was: {message}"
        );
        // ...and the list, so they know what to pick instead.
        for extension in ["png", "jpg", "webp", "gif", "svg"] {
            assert!(
                message.contains(extension),
                "message omitted {extension}: {message}"
            );
        }
    }

    #[test]
    fn a_file_with_no_extension_is_refused() {
        let file = TempFile::new("noextension", PNG);
        let error = read_image_as_data_url(&file.0).expect_err("no extension is not an image");
        assert!(
            error.to_string().contains("not an image"),
            "message was: {error}"
        );
    }

    #[test]
    fn an_oversized_file_is_refused_before_it_is_read() {
        // A sparse file: the size check has to reject this without allocating
        // four megabytes to find out, and without reading it at all.
        let path = std::env::temp_dir().join("quill-image-test-oversized.png");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(MAX_BYTES + 1).expect("make it large");
        drop(file);

        let error = read_image_as_data_url(&path).expect_err("over the limit is refused");
        let message = error.to_string();
        assert!(
            message.contains("MB"),
            "the message names the size: {message}"
        );
        assert!(
            message.contains(&format!("{} MB", MAX_BYTES.div_ceil(1024 * 1024))),
            "and the limit: {message}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_exactly_at_the_limit_is_accepted() {
        // The boundary has to be inclusive, or the message says "4 MB" and a
        // 4MB file is still refused.
        let path = std::env::temp_dir().join("quill-image-test-atlimit.png");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(MAX_BYTES).expect("make it exactly the limit");
        drop(file);

        let image = read_image_as_data_url(&path).expect("the limit itself is allowed");
        assert_eq!(image.byte_len, MAX_BYTES);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_at_the_limit_survives_the_settings_cap() {
        // The regression this pins: the largest file this module accepts used to
        // be larger than the largest data URL the settings would keep, so a file
        // at the limit was read, previewed, and then silently dropped on save.
        // The reader's cap and the stored cap are the same decision, and this is
        // the test that makes the connection between them an assertion rather
        // than a coincidence nobody re-checks.
        let path = std::env::temp_dir().join("quill-image-test-fits-settings.png");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len(MAX_BYTES).expect("make it exactly the limit");
        drop(file);

        let image = read_image_as_data_url(&path).expect("read");
        let longest_prefix = "data:image/svg+xml;base64,".len();
        assert!(
            image.data_url.len() + longest_prefix <= crate::settings::MAX_IMAGE_DATA_BYTES,
            "an accepted file's data URL ({}) plus room for the longest prefix ({}) must fit the {} byte settings cap",
            image.data_url.len(),
            longest_prefix,
            crate::settings::MAX_IMAGE_DATA_BYTES
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_empty_file_is_refused() {
        // A zero-byte file passes the size check, and produces `data:image/png;
        // base64,` -- a URL that parses and paints nothing.
        let file = TempFile::new("empty.png", b"");
        let error = read_image_as_data_url(&file.0).expect_err("an empty file is refused");
        assert!(error.to_string().contains("empty"), "message was: {error}");
    }

    #[test]
    fn a_missing_file_says_so_rather_than_reporting_an_io_error() {
        let error = read_image_as_data_url(Path::new("/definitely/not/here.png"))
            .expect_err("a missing file is refused");
        let message = error.to_string();
        assert!(
            message.contains("no longer there"),
            "message was: {message}"
        );
        assert!(
            message.contains("Pick the file again"),
            "and says what to do: {message}"
        );
    }

    #[test]
    fn a_directory_is_refused() {
        // The dialog can return a folder on some platforms, and reading one
        // would fail with an EISDIR that says nothing useful.
        let dir = std::env::temp_dir();
        let error = read_image_as_data_url(&dir).expect_err("a directory is not an image");
        // The extension check fires first, which is also correct: it is not an
        // image, whatever it is.
        assert!(
            error.to_string().contains("not an image"),
            "message was: {error}"
        );
    }
}
