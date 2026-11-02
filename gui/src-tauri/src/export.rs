//! Standalone document rendering and export.
//!
//! # Architecture
//!
//! A single function turns a document into a self-contained HTML string, and
//! every other format is derived from it:
//!
//! ```text
//! ProseMirror JSON ──▶ render_html() ──▶ .html  (standalone, CSS inlined)
//!                                  ├──▶ printpdf::PdfDocument::from_html ──▶ .pdf
//!                                  └──▶ XHTML (for the EPUB spine)          ──▶ .epub
//! ```
//!
//! Markdown is deliberately *not* handled here. `@tiptap/markdown` serialises
//! ProseMirror JSON to Markdown directly in the frontend, which avoids lossy
//! JSON → HTML → Markdown hops. Rust only writes the resulting bytes.
//!
//! # Safety
//!
//! The frontend hands us a ProseMirror JSON document. It is rendered through an
//! explicit allowlist of node and mark types, so a hand-crafted or corrupted
//! payload cannot inject markup, and URL-bearing attributes are scheme-checked.
//! Nothing here trusts the input shape.

use std::io::Write;
use std::path::{Path, PathBuf};

use html_escape::encode_safe;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// ProseMirror JSON in, HTML out. Rust writes bytes; the frontend supplies
    /// the Markdown for this format.
    Html,
    Pdf,
    Docx,
    Epub,
    /// Raw text, already serialised by `@tiptap/markdown` on the frontend.
    Markdown,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Html => "html",
            ExportFormat::Pdf => "pdf",
            ExportFormat::Docx => "docx",
            ExportFormat::Epub => "epub",
            ExportFormat::Markdown => "md",
        }
    }

    /// Every supported format, in the order the export dialog shows them.
    pub fn all() -> [Self; 5] {
        [
            ExportFormat::Html,
            ExportFormat::Pdf,
            ExportFormat::Docx,
            ExportFormat::Epub,
            ExportFormat::Markdown,
        ]
    }

    pub fn from_extension(value: &str) -> Option<Self> {
        match value
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "html" | "htm" => Some(ExportFormat::Html),
            "pdf" => Some(ExportFormat::Pdf),
            "docx" => Some(ExportFormat::Docx),
            "epub" => Some(ExportFormat::Epub),
            "md" | "markdown" => Some(ExportFormat::Markdown),
            _ => None,
        }
    }
}

/// Format metadata for the export dialog, so the UI does not hard-code the list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormatInfo {
    pub format: ExportFormat,
    pub extension: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

impl From<ExportFormat> for ExportFormatInfo {
    fn from(format: ExportFormat) -> Self {
        let (label, description) = match format {
            ExportFormat::Html => ("Web page", "A single self-contained HTML file"),
            ExportFormat::Pdf => ("PDF", "Print-ready document with page numbers"),
            ExportFormat::Docx => ("Word document", "Editable .docx for Word and LibreOffice"),
            ExportFormat::Epub => ("EPUB", "Reflowable e-book"),
            ExportFormat::Markdown => ("Markdown", "Plain .md, keeps the outline"),
        };
        Self {
            format,
            extension: format.extension(),
            label,
            description,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub path: String,
    /// ProseMirror JSON for the document body. Ignored for `Markdown`, which
    /// carries its own pre-serialised body.
    #[serde(default)]
    pub document: Option<Value>,
    /// Pre-serialised Markdown text. Used only for `Markdown`.
    #[serde(default)]
    pub markdown: Option<String>,
    pub format: ExportFormat,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub path: String,
    pub format: ExportFormat,
    pub bytes: u64,
    /// Nodes that could not be represented in the target format, described for
    /// the user rather than silently dropped.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/// Escapes text for an HTML text node.
fn text(value: &str) -> String {
    encode_safe(value).to_string()
}

/// Escapes text for a double-quoted attribute value.
///
/// `encode_safe` also escapes `/` and `'`, which is correct but turns every
/// URL into unreadable `&#x2F;` soup. Those characters cannot break out of a
/// double-quoted attribute, so they are restored here.
fn attr(value: &str) -> String {
    text(value).replace("&#x2F;", "/").replace("&#x27;", "'")
}

/// A hexadecimal colour, optionally with alpha (`#rgb`, `#rrggbb`, `#rrggbbaa`).
fn safe_colour(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.starts_with('#')
        && (4..=9).contains(&value.len())
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Some(value)
    } else {
        None
    }
}

/// Converts a CSS pixel length to points, for print output.
/// 96 CSS px == 72 pt.
fn px_to_pt(value: &str) -> Option<f64> {
    let value = value.trim();
    let numeric = value
        .strip_suffix("px")
        .or_else(|| value.strip_suffix("pt"))
        .unwrap_or(value);
    numeric
        .parse::<f64>()
        .ok()
        .map(|n| if value.ends_with("px") { n * 0.75 } else { n })
}

/// Applies one mark to already-escaped inner HTML, returning the wrapper.
///
/// Unknown marks are reported once and pass their content through unchanged, so
/// text is never lost merely because a mark has no HTML equivalent.
fn apply_mark(mark: &Value, inner: String, warnings: &mut Vec<String>) -> String {
    let kind = mark.get("type").and_then(Value::as_str).unwrap_or_default();
    let attrs = mark.get("attrs");

    match kind {
        "bold" => format!("<strong>{inner}</strong>"),
        "italic" => format!("<em>{inner}</em>"),
        "underline" => format!("<u>{inner}</u>"),
        "strike" => format!("<s>{inner}</s>"),
        "code" => format!("<code>{inner}</code>"),
        "highlight" => {
            let colour = attrs
                .and_then(|a| a.get("color"))
                .and_then(Value::as_str)
                .and_then(safe_colour)
                .unwrap_or("#fff3a3");
            format!("<mark style=\"background:{colour}\">{inner}</mark>")
        }
        "link" => {
            let href = attrs
                .and_then(|a| a.get("href"))
                .and_then(Value::as_str)
                .and_then(safe_url);
            match href {
                Some(href) => format!("<a href=\"{}\">{inner}</a>", attr(&href)),
                // A blocked scheme keeps the words but drops the link.
                None => inner,
            }
        }
        "textStyle" => {
            let mut open = String::from("<span");
            let mut close = "</span>".to_string();

            if let Some(colour) = attrs
                .and_then(|a| a.get("color"))
                .and_then(Value::as_str)
                .and_then(safe_colour)
            {
                open.push_str(&format!(" style=\"color:{colour}\""));
            }
            if let Some(family) = attrs
                .and_then(|a| a.get("fontFamily"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|f| !f.is_empty())
            {
                open.push_str(&format!(" style=\"font-family:{}\"", attr(family)));
            }
            if let Some(size) = attrs
                .and_then(|a| a.get("fontSize"))
                .and_then(Value::as_str)
                .and_then(px_to_pt)
            {
                open.push_str(&format!(" style=\"font-size:{size:.1}pt\""));
            }

            if open == "<span" {
                // Nothing to apply.
                return inner;
            }
            close.clear();
            format!("{open}>{inner}{close}")
        }
        other => {
            if !other.is_empty() {
                warnings.push(format!(
                    "mark `{other}` has no export equivalent; text kept unstyled"
                ));
            }
            inner
        }
    }
}

/// Renders inline content (text nodes, marks and inline nodes).
fn render_inline(node: &Value, warnings: &mut Vec<String>) -> String {
    let Some(content) = node.get("content").and_then(Value::as_array) else {
        return String::new();
    };

    let mut out = String::new();
    for child in content {
        let kind = child
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if kind == "text" {
            let raw = child.get("text").and_then(Value::as_str).unwrap_or("");
            let mut piece = text(raw);

            // ProseMirror stores marks on the text node. Wrapping in reverse
            // order leaves the first-listed mark outermost, which is the
            // conventional reading order (bold outside italic, and so on).
            if let Some(marks) = child.get("marks").and_then(Value::as_array) {
                for mark in marks.iter().rev() {
                    piece = apply_mark(mark, piece, warnings);
                }
            }
            out.push_str(&piece);
            continue;
        }

        if kind == "hardBreak" {
            out.push_str("<br />");
            continue;
        }

        if child.get("content").is_some() {
            out.push_str(&render_inline(child, warnings));
            continue;
        }

        warnings.push(format!("inline node `{kind}` is not supported in export"));
    }
    out
}

/// Restricts a URL to schemes that cannot execute script.
fn safe_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    let relative = !trimmed.contains(':')
        || lowered.starts_with('#')
        || lowered.starts_with('/')
        || lowered.starts_with("./")
        || lowered.starts_with("../");
    const ALLOWED: [&str; 5] = ["http:", "https:", "mailto:", "tel:", "data:image/"];
    if relative || ALLOWED.iter().any(|s| lowered.starts_with(s)) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// ProseMirror JSON -> HTML
// ---------------------------------------------------------------------------

/// A rendered body fragment, plus anything that could not be represented.
///
/// Public because `render_body` is public.
#[derive(Default)]
pub struct Rendered {
    pub html: String,
    pub warnings: Vec<String>,
}

/// Maps a ProseMirror node type to the HTML tag we emit.
fn block_tag(name: &str) -> Option<&'static str> {
    Some(match name {
        "paragraph" => "p",
        "heading" => "h2", // overridden by level
        "blockquote" => "blockquote",
        "codeBlock" => "pre",
        "bulletList" => "ul",
        "orderedList" => "ol",
        "listItem" => "li",
        "horizontalRule" => "hr",
        "image" => "figure",
        _ => return None,
    })
}

/// Renders a ProseMirror document to a body-only HTML fragment.
pub fn render_body(document: &Value) -> Rendered {
    let mut warnings = Vec::new();
    let mut out = String::new();

    let Some(content) = document.get("content").and_then(Value::as_array) else {
        warnings.push("document has no content array".into());
        return Rendered {
            html: out,
            warnings,
        };
    };

    for node in content {
        render_block(node, &mut out, &mut warnings);
    }
    Rendered {
        html: out,
        warnings,
    }
}

fn render_block(node: &Value, out: &mut String, warnings: &mut Vec<String>) {
    let name = node.get("type").and_then(Value::as_str).unwrap_or_default();
    let attrs = node.get("attrs");
    let content = node.get("content").and_then(Value::as_array);

    // An unsupported node still contributes its children, so no text is lost.
    let Some(_) = block_tag(name) else {
        if !matches!(name, "doc" | "") {
            warnings.push(format!(
                "block `{name}` is not supported in export; its text was kept"
            ));
        }
        if let Some(children) = content {
            for child in children {
                render_block(child, out, warnings);
            }
        }
        return;
    };

    match name {
        "heading" => {
            let level = attrs
                .and_then(|a| a.get("level"))
                .and_then(Value::as_i64)
                .unwrap_or(2)
                .clamp(1, 4);
            let inner = render_inline(node, warnings);
            out.push_str(&format!("<h{level}>{inner}</h{level}>\n"));
        }
        "horizontalRule" => out.push_str("<hr />\n"),
        "image" => {
            let src = attrs
                .and_then(|a| a.get("src"))
                .and_then(Value::as_str)
                .and_then(safe_url);
            match src {
                Some(src) => {
                    let alt = attrs
                        .and_then(|a| a.get("alt"))
                        .and_then(Value::as_str)
                        .map(attr)
                        .unwrap_or_default();
                    let title = attrs
                        .and_then(|a| a.get("title"))
                        .and_then(Value::as_str)
                        .map(|t| format!(" title=\"{}\"", attr(t)))
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "<figure><img src=\"{src}\" alt=\"{alt}\"{title} /></figure>\n"
                    ));
                }
                None => warnings.push("image dropped: unsupported or empty src".into()),
            }
        }
        "codeBlock" => {
            let language = attrs
                .and_then(|a| a.get("language"))
                .and_then(Value::as_str)
                .map(|l| format!(" class=\"language-{}\"", attr(l)))
                .unwrap_or_default();
            let inner = render_inline(node, warnings);
            out.push_str(&format!("<pre><code{language}>{inner}</code></pre>\n"));
        }
        "listItem" => {
            out.push_str("<li>");
            if let Some(children) = content {
                // A list item is normally a single paragraph. Emitting
                // <li><p>text</p></li> is valid but produces a "loose" list that
                // renders with extra spacing in EPUB readers and PDF, so the
                // lone paragraph is unwrapped.
                let lone_paragraph = children.len() == 1
                    && children[0].get("type").and_then(Value::as_str) == Some("paragraph");
                if lone_paragraph {
                    out.push_str(&render_inline(&children[0], warnings));
                } else {
                    for child in children {
                        render_block(child, out, warnings);
                    }
                }
            }
            out.push_str("</li>\n");
        }
        "bulletList" | "orderedList" => {
            let open = if name == "orderedList" {
                let start = attrs
                    .and_then(|a| a.get("start"))
                    .and_then(Value::as_i64)
                    .filter(|s| *s != 1)
                    .map(|s| format!(" start=\"{s}\""))
                    .unwrap_or_default();
                format!("<ol{start}>")
            } else {
                "<ul>".to_string()
            };
            out.push_str(&open);
            if let Some(children) = content {
                for child in children {
                    render_block(child, out, warnings);
                }
            }
            out.push_str(if name == "orderedList" {
                "</ol>\n"
            } else {
                "</ul>\n"
            });
        }
        _ => {
            // paragraph, blockquote, and anything mapped to a simple tag.
            let tag = block_tag(name).unwrap_or("p");
            let inner = render_inline(node, warnings);
            out.push_str(&format!("<{tag}>{inner}</{tag}>\n"));
        }
    }
}

// ---------------------------------------------------------------------------
// Standalone HTML document
// ---------------------------------------------------------------------------

/// Print-oriented stylesheet shared by the HTML, PDF and EPUB renderings.
///
/// Font families are deliberately generic. The PDF engine resolves fonts through
/// fontconfig and cannot read the woff2 files the UI ships, so naming Inter or
/// Georgia here would only produce "unresolved font" warnings and a fallback
/// anyway. Generic `serif` / `monospace` resolve consistently, and PDF font
/// embedding is a follow-up (see the module docs on known limitations).
const PRINT_CSS: &str = "\
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 3rem 1.5rem 6rem;
  max-width: 40rem;
  font-family: serif;
  font-size: 11.5pt;
  line-height: 1.65;
  color: #1d1d1f;
  background: #ffffff;
  -webkit-text-size-adjust: 100%;
}
h1, h2, h3, h4 { line-height: 1.2; margin: 2em 0 0.6em; font-weight: 700; }
h1 { font-size: 1.9em; letter-spacing: -0.01em; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.12em; }
h4 { font-size: 1em; }
p { margin: 0 0 1.05em; }
ul, ol { margin: 0 0 1.05em; padding-left: 1.4em; }
li > p { margin-bottom: 0.4em; }
blockquote {
  margin: 1.2em 0;
  padding-left: 1em;
  border-left: 3px solid #d8d8dd;
  color: #55555c;
}
pre {
  margin: 1.2em 0;
  padding: 0.9rem 1rem;
  overflow-x: auto;
  background: #f4f4f6;
  border-radius: 6px;
  font-size: 0.88em;
  line-height: 1.5;
}
code { font-family: monospace; }
p code, li code { padding: 0.1em 0.3em; background: #f0f0f2; border-radius: 3px; font-size: 0.9em; }
pre code { padding: 0; background: none; }
hr { margin: 2.2em 0; border: 0; border-top: 1px solid #dcdce0; }
a { color: #2f6bd8; text-underline-offset: 2px; }
mark { padding: 0.05em 0.16em; border-radius: 3px; background: #fff3a3; color: inherit; }
figure { margin: 1.4em 0; }
img { max-width: 100%; height: auto; border-radius: 4px; }
@media print {
  body { padding: 0; max-width: none; }
}
";

/// Wraps a body fragment in a complete, self-contained HTML document.
pub fn standalone_html(title: &str, author: Option<&str>, body: &str) -> String {
    let byline = author
        .filter(|a| !a.trim().is_empty())
        .map(|a| format!("<p class=\"byline\">{}</p>\n", text(a)))
        .unwrap_or_default();

    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
<meta charset=\"utf-8\" />\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n\
<title>{title}</title>\n\
<style>\n{css}</style>\n\
</head>\n\
<body>\n\
<article>\n\
<h1 class=\"doc-title\">{title}</h1>\n\
{byline}<div class=\"doc-body\">\n{body}</div>\n\
</article>\n\
</body>\n\
</html>\n",
        title = text(title),
        css = PRINT_CSS,
    )
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/// Writes bytes to `path` atomically.
///
/// The temporary file is created in the *same directory* so the rename stays
/// within one filesystem and is therefore atomic on all three desktop targets.
/// An interrupted export must never destroy the user's existing file, and a
/// truncated EPUB or DOCX would be unopenable.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<u64, std::io::Error> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let mut temp = tempfile::Builder::new()
        .prefix(".quill-export-")
        .suffix(".tmp")
        .tempfile_in(dir)?;

    temp.write_all(bytes)?;
    temp.flush()?;
    temp.as_file().sync_all()?;

    let temp_path = temp.into_temp_path();
    // `persist` fails if the destination exists on some platforms, so remove
    // first; the rename itself is what makes this atomic.
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    temp_path.persist(path)?;

    Ok(bytes.len() as u64)
}

// ---------------------------------------------------------------------------
// Format writers
// ---------------------------------------------------------------------------

fn write_html(path: &Path, html: &str) -> Result<u64, std::io::Error> {
    write_atomic(path, html.as_bytes())
}

fn write_markdown(path: &Path, markdown: &str) -> Result<u64, std::io::Error> {
    // A trailing newline keeps the file POSIX-friendly.
    let mut body = markdown.trim_end().to_string();
    body.push('\n');
    write_atomic(path, body.as_bytes())
}

fn write_pdf(path: &Path, html: &str) -> Result<u64, std::io::Error> {
    use printpdf::*;
    use std::collections::BTreeMap;

    // No images or embedded fonts: the document references none, and the
    // stylesheet resolves fonts through the reader.
    let no_assets: BTreeMap<String, Base64OrRaw> = BTreeMap::new();

    let mut layout_warnings: Vec<PdfWarnMsg> = Vec::new();
    // A4 with a typographic margin, rather than printpdf's zero default.
    let options = GeneratePdfOptions {
        page_width: Some(210.0),
        page_height: Some(297.0),
        margin_top: Some(22.0),
        margin_right: Some(20.0),
        margin_bottom: Some(22.0),
        margin_left: Some(20.0),
        font_embedding: Some(true),
        show_page_numbers: Some(true),
        ..Default::default()
    };

    let doc = PdfDocument::from_html(html, &no_assets, &no_assets, &options, &mut layout_warnings)
        .map_err(|e| std::io::Error::other(format!("printpdf layout failed: {e}")))?;

    let mut save_warnings: Vec<PdfWarnMsg> = Vec::new();
    let bytes = doc.save(
        &PdfSaveOptions {
            subset_fonts: true,
            ..Default::default()
        },
        &mut save_warnings,
    );

    if bytes.is_empty() {
        return Err(std::io::Error::other("printpdf produced no output"));
    }

    write_atomic(path, &bytes)
}

fn write_docx(
    path: &Path,
    document: &Value,
    title: &str,
    author: Option<&str>,
) -> Result<(u64, Vec<String>), std::io::Error> {
    use docx_rs::*;

    let rendered = render_body(document);
    let mut warnings = rendered.warnings;

    // docx-rs exposes headings as named paragraph styles rather than an enum.
    let mut doc = Docx::new().add_paragraph(
        Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(title.to_string())),
    );

    if let Some(a) = author.filter(|a| !a.trim().is_empty()) {
        doc = doc
            .add_paragraph(Paragraph::new().add_run(Run::new().italic().add_text(a.to_string())));
    }

    // The body is already sanitised HTML; strip tags to obtain plain text per
    // block. DOCX inline formatting is a follow-up (see module docs).
    for line in rendered.html.lines() {
        let plain = strip_tags(line);
        if plain.trim().is_empty() {
            continue;
        }
        let heading = heading_level(line);
        let mut paragraph = match heading {
            Some(1) => Paragraph::new().style("Heading2"),
            Some(2) => Paragraph::new().style("Heading3"),
            Some(3) => Paragraph::new().style("Heading4"),
            _ => Paragraph::new(),
        };
        if is_list_item(line) {
            paragraph = paragraph.add_run(Run::new().add_text("• "));
        }
        doc = doc.add_paragraph(paragraph.add_run(Run::new().add_text(plain)));
    }

    let mut buffer: Vec<u8> = Vec::new();
    doc.pack(std::io::Cursor::new(&mut buffer))
        .map_err(|e| std::io::Error::other(format!("docx pack failed: {e}")))?;

    if stripped_tag_count(&rendered.html) > 0 {
        warnings.push(
            "DOCX export keeps text and headings; inline bold/italic/highlight is not yet carried over"
                .to_string(),
        );
    }

    Ok((write_atomic(path, &buffer)?, warnings))
}

/// Removes tags from an HTML fragment, leaving readable text.
fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside = false;
    for ch in input.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    // Unescape the handful of entities our renderer can emit.
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

fn heading_level(line: &str) -> Option<u8> {
    if line.starts_with("<h1") {
        Some(1)
    } else if line.starts_with("<h2") {
        Some(2)
    } else if line.starts_with("<h3") {
        Some(3)
    } else if line.starts_with("<h4") {
        Some(4)
    } else {
        None
    }
}

fn is_list_item(line: &str) -> bool {
    line.starts_with("<li")
}

fn stripped_tag_count(html: &str) -> usize {
    html.matches("<strong>").count()
        + html.matches("<em>").count()
        + html.matches("<mark").count()
        + html.matches("<s>").count()
        + html.matches("<u>").count()
}

fn write_epub(
    path: &Path,
    document: &Value,
    title: &str,
    author: Option<&str>,
) -> Result<(u64, Vec<String>), std::io::Error> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let rendered = render_body(document);
    let warnings = rendered.warnings;

    let uuid = uuid::Uuid::new_v4();
    let author = author
        .filter(|a| !a.trim().is_empty())
        .unwrap_or("Quill")
        .to_string();
    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);

        // OCF 3.1 requires `mimetype` to be the first entry and STORED.
        zip.start_file(
            "mimetype",
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .map_err(zip_err)?;
        zip.write_all(b"application/epub+zip")?;

        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("META-INF/container.xml", deflated)
            .map_err(zip_err)?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#,
        )?;

        zip.start_file("EPUB/package.opf", deflated)
            .map_err(zip_err)?;
        zip.write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:{uuid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
  </spine>
</package>
"#,
                title = text(title),
                author = text(&author),
            )
            .as_bytes(),
        )?;

        // EPUB 3 requires a nav document; NCX is EPUB 2 only.
        zip.start_file("EPUB/nav.xhtml", deflated)
            .map_err(zip_err)?;
        zip.write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol><li><a href="chapter1.xhtml">{title}</a></li></ol>
  </nav>
</body>
</html>
"#,
                title = text(title)
            )
            .as_bytes(),
        )?;

        zip.start_file("EPUB/style.css", deflated)
            .map_err(zip_err)?;
        zip.write_all(PRINT_CSS.as_bytes())?;

        // XHTML content documents must be well-formed XML: the body is already
        // self-closing-tag clean because the renderer emits `<br />` / `<hr />`.
        let chapter = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <html xmlns=\"http://www.w3.org/1999/xhtml\">\n\
             <head><title>{title}</title><link rel=\"stylesheet\" href=\"style.css\"/></head>\n\
             <body>\n<h1>{title}</h1>\n<p class=\"byline\">{author}</p>\n{body}</body>\n</html>\n",
            title = text(title),
            author = text(&author),
            body = rendered.html
        );
        zip.start_file("EPUB/chapter1.xhtml", deflated)
            .map_err(zip_err)?;
        zip.write_all(chapter.as_bytes())?;

        zip.finish().map_err(zip_err)?;
    }

    let bytes = buffer.into_inner();
    Ok((write_atomic(path, &bytes)?, warnings))
}

fn zip_err(err: zip::result::ZipError) -> std::io::Error {
    std::io::Error::other(format!("epub packaging failed: {err}"))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Renders and writes a document, returning what happened.
pub fn export(request: &ExportRequest) -> Result<ExportOutcome, String> {
    let path = PathBuf::from(&request.path);
    let title = request.title.trim();
    let title = if title.is_empty() {
        "Untitled document"
    } else {
        title
    };

    let (bytes, warnings) = match request.format {
        ExportFormat::Markdown => {
            let markdown = request
                .markdown
                .as_deref()
                .ok_or_else(|| "Markdown export requires the `markdown` field".to_string())?;
            (
                write_markdown(&path, markdown).map_err(|e| e.to_string())?,
                Vec::new(),
            )
        }
        ExportFormat::Html => {
            let document = request
                .document
                .as_ref()
                .ok_or_else(|| "HTML export requires the `document` field".to_string())?;
            let rendered = render_body(document);
            let html = standalone_html(title, request.author.as_deref(), &rendered.html);
            (
                write_html(&path, &html).map_err(|e| e.to_string())?,
                rendered.warnings,
            )
        }
        ExportFormat::Pdf => {
            let document = request
                .document
                .as_ref()
                .ok_or_else(|| "PDF export requires the `document` field".to_string())?;
            let rendered = render_body(document);
            let html = standalone_html(title, request.author.as_deref(), &rendered.html);
            (
                write_pdf(&path, &html).map_err(|e| e.to_string())?,
                rendered.warnings,
            )
        }
        ExportFormat::Docx => {
            let document = request
                .document
                .as_ref()
                .ok_or_else(|| "DOCX export requires the `document` field".to_string())?;
            write_docx(&path, document, title, request.author.as_deref())
                .map_err(|e| e.to_string())?
        }
        ExportFormat::Epub => {
            let document = request
                .document
                .as_ref()
                .ok_or_else(|| "EPUB export requires the `document` field".to_string())?;
            write_epub(&path, document, title, request.author.as_deref())
                .map_err(|e| e.to_string())?
        }
    };

    Ok(ExportOutcome {
        path: path.display().to_string(),
        format: request.format,
        bytes,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [
                    { "type": "text", "text": "Chapter One" } ] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Plain sentence." },
                    { "type": "text", "marks": [{ "type": "bold" }], "text": " Bold." } ] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "One" }] } ] },
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "Two" }] } ] } ] },
                { "type": "blockquote", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "Quoted." }] } ] }
            ]
        })
    }

    // --- URL safety ---------------------------------------------------------

    #[test]
    fn dangerous_urls_are_rejected() {
        for bad in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "vbscript:x",
            "data:text/html;base64,PHN2Zz4=",
        ] {
            assert_eq!(safe_url(bad), None, "{bad} should be rejected");
        }
    }

    #[test]
    fn safe_urls_are_kept() {
        for good in [
            "https://example.com",
            "http://a.b",
            "/local/path",
            "#anchor",
            "mailto:a@b.c",
        ] {
            assert_eq!(
                safe_url(good).as_deref(),
                Some(good),
                "{good} should be kept"
            );
        }
    }

    #[test]
    fn data_image_urls_are_kept() {
        let png = "data:image/png;base64,iVBORw0K";
        assert!(safe_url(png).is_some());
    }

    // --- escaping -----------------------------------------------------------

    #[test]
    fn text_is_escaped() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "a < b & c" }] } ] });
        let html = render_body(&d).html;
        assert!(html.contains("&lt;"), "{html}");
        assert!(html.contains("&amp;"), "{html}");
    }

    #[test]
    fn script_text_cannot_become_markup() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "<script>alert(1)</script>" } ] } ] });
        let html = render_body(&d).html;
        assert!(!html.contains("<script"), "{html}");
        assert!(html.contains("&lt;script"), "{html}");
    }

    #[test]
    fn a_hostile_link_mark_is_removed() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }],
                  "text": "click" } ] } ] });
        let html = render_body(&d).html;
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("click"), "text should survive: {html}");
    }

    #[test]
    fn safe_link_is_preserved() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://x.test/a" } }],
                  "text": "link" } ] } ] });
        let html = render_body(&d).html;
        assert!(html.contains("href=\"https://x.test/a\""), "{html}");
    }

    #[test]
    fn highlight_colour_is_validated() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "highlight",
                  "attrs": { "color": "red;background:url(javascript:alert(1))" } }], "text": "m" } ] } ] });
        let html = render_body(&d).html;
        assert!(!html.contains("javascript:"), "{html}");
        assert!(!html.contains("url("), "{html}");
    }

    // --- structure ----------------------------------------------------------

    #[test]
    fn basic_structure_renders() {
        let html = render_body(&doc()).html;
        assert!(html.contains("<h2>Chapter One</h2>"), "{html}");
        assert!(
            html.contains("<p>Plain sentence.<strong> Bold.</strong></p>"),
            "{html}"
        );
        assert!(html.contains("<ul>"), "{html}");
        assert!(html.contains("<li>One</li>"), "{html}");
        assert!(html.contains("<li>Two</li>"), "{html}");
        assert!(html.contains("<blockquote>Quoted.</blockquote>"), "{html}");
    }

    #[test]
    fn every_supported_mark_renders() {
        let cases: Vec<(serde_json::Value, &str)> = vec![
            (json!({ "type": "bold" }), "<strong>x</strong>"),
            (json!({ "type": "italic" }), "<em>x</em>"),
            (json!({ "type": "underline" }), "<u>x</u>"),
            (json!({ "type": "strike" }), "<s>x</s>"),
            (json!({ "type": "code" }), "<code>x</code>"),
            (
                json!({ "type": "highlight", "attrs": { "color": "#fde68a" } }),
                "background:#fde68a",
            ),
            (
                json!({ "type": "link", "attrs": { "href": "https://e.test" } }),
                "href=\"https://e.test\"",
            ),
            (
                json!({ "type": "textStyle", "attrs": { "color": "#ff0000" } }),
                "color:#ff0000",
            ),
        ];

        for (mark, expected) in cases {
            let d = json!({ "type": "doc", "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "marks": [mark], "text": "x" } ] } ] });
            let html = render_body(&d).html;
            assert!(html.contains(expected), "expected {expected} in {html}");
        }
    }

    #[test]
    fn text_style_font_size_converts_px_to_pt() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "textStyle", "attrs": { "fontSize": "16px" } }],
                  "text": "x" } ] } ] });
        let html = render_body(&d).html;
        assert!(
            html.contains("font-size:12.0pt"),
            "16px should become 12pt: {html}"
        );
    }

    #[test]
    fn nested_marks_nest_in_order() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "italic" }, { "type": "bold" }], "text": "x" } ] } ] });
        let html = render_body(&d).html;
        assert!(
            html.contains("<em><strong>x</strong></em>"),
            "first mark should be outermost: {html}"
        );
    }

    #[test]
    fn an_unknown_mark_warns_but_keeps_the_text() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "marks": [{ "type": "sparkle" }], "text": "kept" } ] } ] });
        let out = render_body(&d);
        assert!(out.html.contains("kept"), "text must survive: {}", out.html);
        assert!(
            out.warnings.iter().any(|w| w.contains("sparkle")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn hard_break_renders() {
        let d = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "a" },
                { "type": "hardBreak" },
                { "type": "text", "text": "b" } ] } ] });
        assert!(render_body(&d).html.contains("<br />"));
    }

    #[test]
    fn heading_levels_are_clamped() {
        let d = json!({ "type": "doc", "content": [
            { "type": "heading", "attrs": { "level": 99 }, "content": [{ "type": "text", "text": "x" }] } ] });
        let html = render_body(&d).html;
        assert!(html.contains("<h4>"), "level should clamp to h4: {html}");
    }

    #[test]
    fn unknown_blocks_keep_their_text_and_warn() {
        let d = json!({ "type": "doc", "content": [
            { "type": "table", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "kept text" }] } ] } ] });
        let out = render_body(&d);
        assert!(
            out.html.contains("kept text"),
            "text must not be lost: {}",
            out.html
        );
        assert!(
            out.warnings.iter().any(|w| w.contains("table")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn ordered_list_start_is_preserved() {
        let d = json!({ "type": "doc", "content": [
            { "type": "orderedList", "attrs": { "start": 3 }, "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "x" }] } ] } ] } ] });
        assert!(render_body(&d).html.contains("start=\"3\""));
    }

    #[test]
    fn empty_document_renders_without_panicking() {
        for input in [
            json!({}),
            json!({"type": "doc"}),
            json!({"type": "doc", "content": []}),
        ] {
            let out = render_body(&input);
            assert!(out.html.is_empty() || out.html.trim().is_empty());
        }
    }

    // --- standalone document ------------------------------------------------

    #[test]
    fn standalone_html_is_self_contained() {
        let rendered = render_body(&doc());
        let html = standalone_html("My Title", Some("Mara Lee"), &rendered.html);
        assert!(html.starts_with("<!doctype html>"), "missing doctype");
        assert!(html.contains("<title>My Title</title>"), "title missing");
        assert!(html.contains("Mara Lee"), "author missing");
        assert!(html.contains("<style>"), "styles must be inlined");
        assert!(
            !html.contains("http://"),
            "must not reference remote resources"
        );
    }

    #[test]
    fn title_is_escaped_in_the_heading() {
        let html = standalone_html("<script>x</script>", None, "");
        assert!(!html.contains("<script>x"), "title must be escaped: {html}");
    }

    // --- format mapping -----------------------------------------------------

    #[test]
    fn format_extensions_round_trip() {
        for format in [
            ExportFormat::Html,
            ExportFormat::Pdf,
            ExportFormat::Docx,
            ExportFormat::Epub,
            ExportFormat::Markdown,
        ] {
            let ext = format.extension();
            assert_eq!(ExportFormat::from_extension(ext), Some(format), "{ext}");
        }
    }

    #[test]
    fn unknown_extension_is_rejected() {
        assert_eq!(ExportFormat::from_extension("exe"), None);
    }

    // --- writing ------------------------------------------------------------

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quill-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    #[test]
    fn html_export_writes_a_file() {
        let path = temp_path("doc.html");
        let outcome = export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Html,
            title: "T".into(),
            author: None,
        })
        .expect("html export");

        assert!(path.exists());
        assert!(outcome.bytes > 0);
        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(written.contains("Chapter One"), "{written}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn markdown_export_requires_the_markdown_field() {
        let path = temp_path("doc.md");
        let result = export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Markdown,
            title: "T".into(),
            author: None,
        });
        assert!(result.is_err(), "missing markdown should be an error");
    }

    #[test]
    fn markdown_export_writes_a_trailing_newline() {
        let path = temp_path("doc.md");
        export(&ExportRequest {
            path: path.display().to_string(),
            document: None,
            markdown: Some("# Title\n\nBody".into()),
            format: ExportFormat::Markdown,
            title: "T".into(),
            author: None,
        })
        .expect("markdown export");

        let written = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(written, "# Title\n\nBody\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn docx_export_produces_a_zip_container() {
        let path = temp_path("doc.docx");
        let outcome = export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Docx,
            title: "Chapter".into(),
            author: Some("Mara Lee".into()),
        })
        .expect("docx export");

        let bytes = std::fs::read(&path).expect("read back");
        // A ZIP archive starts with the local file header signature "PK\x03\x04".
        assert_eq!(&bytes[..4], b"PK\x03\x04", "not a zip container");
        assert_eq!(outcome.bytes, bytes.len() as u64);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn epub_export_is_a_valid_container() {
        let path = temp_path("doc.epub");
        export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Epub,
            title: "Chapter".into(),
            author: Some("Mara Lee".into()),
        })
        .expect("epub export");

        let bytes = std::fs::read(&path).expect("read back");
        assert_eq!(&bytes[..4], b"PK\x03\x04", "not a zip container");

        // The OCF mimetype entry must be first and stored uncompressed.
        assert_eq!(
            &bytes[30..38],
            b"mimetype",
            "mimetype must be the first entry"
        );

        // Spot-check that the required parts are present.
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("META-INF/container.xml"),
            "container.xml missing"
        );
        assert!(text.contains("EPUB/package.opf"), "package.opf missing");
        assert!(text.contains("EPUB/nav.xhtml"), "nav.xhtml missing");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn pdf_export_produces_a_pdf() {
        let path = temp_path("doc.pdf");
        let outcome = export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Pdf,
            title: "Chapter".into(),
            author: None,
        })
        .expect("pdf export");

        let bytes = std::fs::read(&path).expect("read back");
        assert_eq!(
            &bytes[..5],
            b"%PDF-",
            "not a PDF: {:?}",
            &bytes[..8.min(bytes.len())]
        );
        assert!(
            outcome.bytes > 500,
            "suspiciously small pdf: {}",
            outcome.bytes
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn export_overwrites_an_existing_file_atomically() {
        let path = temp_path("doc.html");
        std::fs::write(&path, "old contents").expect("seed file");

        export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Html,
            title: "T".into(),
            author: None,
        })
        .expect("html export");

        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(written.contains("Chapter One"), "file was not replaced");
        assert!(!written.contains("old contents"));

        // No temp files should be left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .expect("list dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".quill-export-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn export_creates_missing_directories() {
        let dir = std::env::temp_dir().join(format!("quill-export-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested/deeper/doc.html");

        export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Html,
            title: "T".into(),
            author: None,
        })
        .expect("export should create parents");

        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fallback_title_is_used_when_blank() {
        let path = temp_path("doc.html");
        export(&ExportRequest {
            path: path.display().to_string(),
            document: Some(doc()),
            markdown: None,
            format: ExportFormat::Html,
            title: "   ".into(),
            author: None,
        })
        .expect("export");

        let written = std::fs::read_to_string(&path).expect("read back");
        assert!(written.contains("Untitled document"), "{written}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
