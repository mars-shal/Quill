//! Writes one document to every supported export format so the output can be
//! opened and inspected with real tools (a PDF reader, `unzip`, `file`) rather
//! than only asserted on by unit tests.
//!
//! Usage:
//!   cargo run --example export_samples -- <output-directory> [document.json]
//!
//! When no document is supplied a built-in sample is used.

use std::path::PathBuf;

use serde_json::Value;

const BUILTIN_SAMPLE: &str = r##"{
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 1 }, "content": [
      { "type": "text", "text": "The Shape of a Quiet Interface" } ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "A quiet interface is not an empty one. It is an interface with a clear intention: " },
      { "type": "text", "marks": [{ "type": "bold" }], "text": "make the next sentence easier to begin" },
      { "type": "text", "text": "." } ] },
    { "type": "heading", "attrs": { "level": 2 }, "content": [
      { "type": "text", "text": "The discipline of less" } ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Every control has a cost, and " },
      { "type": "text", "marks": [{ "type": "italic" }], "text": "attention" },
      { "type": "text", "text": " is the only budget that matters." } ] },
    { "type": "bulletList", "content": [
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [
        { "type": "text", "text": "Remove one reassuring thing" } ] } ] },
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [
        { "type": "text", "text": "Keep what helps progress" } ] } ] } ] },
    { "type": "blockquote", "content": [ { "type": "paragraph", "content": [
      { "type": "text", "text": "A small test, applied often." } ] } ] },
    { "type": "codeBlock", "attrs": { "language": "js" }, "content": [
      { "type": "text", "text": "const quiet = (room) => room.length < 2;" } ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "See the " },
      { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://example.com/notes" } }], "text": "notes" },
      { "type": "text", "text": " and the " },
      { "type": "text", "marks": [{ "type": "highlight", "attrs": { "color": "#fde68a" } }], "text": "marked passage" },
      { "type": "text", "text": "." } ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Blocked link: " },
      { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }], "text": "should not be a link" },
      { "type": "text", "text": "." } ] }
  ]
}"##;

const BUILTIN_MARKDOWN: &str = concat!(
    "# The Shape of a Quiet Interface\n\n",
    "A quiet interface is not an empty one.\n\n",
    "## The discipline of less\n\n",
    "Every control has a cost.\n"
);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().unwrap_or_else(|| {
        std::env::temp_dir()
            .join("quill-samples")
            .display()
            .to_string()
    }));
    std::fs::create_dir_all(&dir)?;

    // A document supplied on the command line takes precedence, so the
    // verification script can drive the real exporter with its own fixture.
    let (document, markdown, title, author) = match args.next() {
        Some(path) => {
            let raw = std::fs::read_to_string(&path)?;
            let document: Value = serde_json::from_str(&raw)?;
            let title = document
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Sample Document")
                .to_string();
            (
                document,
                BUILTIN_MARKDOWN.to_string(),
                title,
                Some("Mara Lee".to_string()),
            )
        }
        None => (
            serde_json::from_str(BUILTIN_SAMPLE)?,
            BUILTIN_MARKDOWN.to_string(),
            "The Shape of a Quiet Interface".to_string(),
            Some("Mara Lee".to_string()),
        ),
    };

    let formats = [
        ("html", quill_lib::export::ExportFormat::Html, false),
        ("pdf", quill_lib::export::ExportFormat::Pdf, false),
        ("docx", quill_lib::export::ExportFormat::Docx, false),
        ("epub", quill_lib::export::ExportFormat::Epub, false),
        ("md", quill_lib::export::ExportFormat::Markdown, true),
    ];

    for (name, format, use_markdown) in formats {
        let path = dir.join(format!("sample.{name}"));
        let outcome = quill_lib::export::export(&quill_lib::export::ExportRequest {
            path: path.display().to_string(),
            document: Some(document.clone()),
            markdown: if use_markdown {
                Some(markdown.clone())
            } else {
                None
            },
            format,
            title: title.clone(),
            author: author.clone(),
        })
        .map_err(|e| format!("{name}: {e}"))?;

        println!("{:<5} {:>9} bytes  {}", name, outcome.bytes, path.display());
        for warning in &outcome.warnings {
            println!("        warning: {warning}");
        }
    }

    println!("\nwrote samples to {}", dir.display());
    Ok(())
}
