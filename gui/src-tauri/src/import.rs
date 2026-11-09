//! Opening files from outside the library.
//!
//! DOCX is a zip of XML, so it is read with the `zip` dependency the export
//! path already carries and parsed as a read-only DOM. Tables and OMML
//! equations become real editor nodes instead of raw Word markup: the former
//! is a `<table>`, the latter an inline or block math node with a LaTeX
//! attribute the Mathematics extension already understands.
//!
//! PDF text is read with pdf-extract. A PDF has no semantic table or equation
//! structure to recover -- what a reader sees as a table is just positioned
//! glyphs -- so it arrives as clean paragraphs and can be tidied further in the
//! editor's Clean up action.
//!
//! Markdown, plain text and HTML are read as written. The frontend chooses the
//! converter from `format`, not from the extension, because a PDF's extracted
//! text is not Markdown even though the editor will turn it into paragraphs.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use roxmltree::Node;
use serde::Serialize;
use zip::ZipArchive;

use crate::error::{AppError, AppResult};

/// A text file the reader chose through the dialog plugin.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTextFile {
    pub name: String,
    pub path: String,
    pub extension: String,
    /// `html`, `markdown` or `text` -- what the extractor produced, not what
    /// the file was called.
    pub format: String,
    pub content: String,
}

const ALLOWED: &[&str] = &[
    "md", "markdown", "txt", "text", "html", "htm", "pdf", "docx",
];
const MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Reads one document the reader chose in the Open dialog.
///
/// The path is the grant: the dialog chose it, and this function reads exactly
/// that file. The extension list keeps the import honest about what the editor
/// can carry, and the size cap stops a mistaken large file from becoming an IPC
/// payload.
pub fn read_text_file(path: &str) -> AppResult<ImportedTextFile> {
    let file_path = Path::new(path);
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ALLOWED.contains(&extension.as_str()) {
        return Err(AppError::Validation(format!(
            "Quill cannot open .{extension} files"
        )));
    }

    let metadata = std::fs::metadata(file_path)
        .map_err(|error| AppError::Validation(format!("could not read {path}: {error}")))?;
    if metadata.len() > MAX_BYTES {
        return Err(AppError::Validation(format!(
            "{path} is larger than the 32 MB import limit"
        )));
    }

    let (format, content) = match extension.as_str() {
        "html" | "htm" => ("html".to_string(), read_utf8(file_path, path)?),
        "md" | "markdown" => ("markdown".to_string(), read_utf8(file_path, path)?),
        "pdf" => ("text".to_string(), extract_pdf(file_path, path)?),
        "docx" => ("html".to_string(), extract_docx(file_path, path)?),
        _ => ("text".to_string(), read_utf8(file_path, path)?),
    };

    if content.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "{path} contains no selectable text"
        )));
    }

    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported document")
        .to_string();

    Ok(ImportedTextFile {
        name,
        path: path.to_string(),
        extension,
        format,
        content,
    })
}

fn read_utf8(file_path: &Path, display: &str) -> AppResult<String> {
    std::fs::read_to_string(file_path)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))
}

fn extract_pdf(file_path: &Path, display: &str) -> AppResult<String> {
    let text = pdf_extract::extract_text(file_path)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))?;
    Ok(normalise_text(&text))
}

/// Collapses the ragged line endings PDF extractors produce, while keeping the
/// blank lines that separate paragraphs and pages.
fn normalise_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut blank_run = 0usize;
    for line in value
        .replace('\u{c}', "\n")
        .replace("\r\n", "\n")
        .split('\n')
    {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn extract_docx(file_path: &Path, display: &str) -> AppResult<String> {
    let file = File::open(file_path)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|error| {
            AppError::Validation(format!("{display} is not a Word document: {error}"))
        })?
        .read_to_string(&mut xml)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))?;

    let media = read_docx_media(&mut archive);
    docx_xml_to_html(&xml, &media)
        .map_err(|error| AppError::Validation(format!("could not read {display}: {error}")))
}

/// The image relationships in a DOCX, mapped to inline `data:` URLs.
///
/// Word stores images under `word/media/*` and points at them from
/// `word/_rels/document.xml.rels`. Embedding the bytes means the document can
/// travel to SQLite, another machine or the export dialog without a relative
/// path that only worked on the original filesystem.
fn read_docx_media(archive: &mut ZipArchive<File>) -> HashMap<String, String> {
    const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

    let relationships = {
        let Ok(mut relationship_file) = archive.by_name("word/_rels/document.xml.rels") else {
            return HashMap::new();
        };
        let mut text = String::new();
        if relationship_file.read_to_string(&mut text).is_err() {
            return HashMap::new();
        }
        text
    };
    let Ok(document) = roxmltree::Document::parse(&relationships) else {
        return HashMap::new();
    };

    let mut media = HashMap::new();
    let mut total = 0usize;
    for relationship in document
        .descendants()
        .filter(|node| node.tag_name().name() == "Relationship")
    {
        let Some(id) = attribute(relationship, "Id") else {
            continue;
        };
        let Some(target) = attribute(relationship, "Target") else {
            continue;
        };
        let Some((mime, path)) = image_target(target) else {
            continue;
        };
        if total >= MAX_TOTAL_BYTES {
            break;
        }
        let Ok(mut entry) = archive.by_name(&path) else {
            continue;
        };
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err()
            || bytes.is_empty()
            || bytes.len() > MAX_IMAGE_BYTES
        {
            continue;
        }
        total += bytes.len();
        media.insert(
            id.to_string(),
            format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        );
    }
    media
}

fn image_target(target: &str) -> Option<(&'static str, String)> {
    let target = target.replace('\\', "/");
    let target = target.trim_start_matches('/');
    let name = target
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match name.rsplit_once('.')?.1 {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => return None,
    };
    let joined = if target.starts_with("word/") {
        target.to_string()
    } else {
        format!("word/{target}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    Some((mime, parts.join("/")))
}

fn docx_xml_to_html(xml: &str, media: &HashMap<String, String>) -> Result<String, String> {
    let document = roxmltree::Document::parse(xml).map_err(|error| error.to_string())?;
    let body = document
        .descendants()
        .find(|node| node.tag_name().name() == "body")
        .ok_or_else(|| "the document has no body".to_string())?;

    let mut html = String::new();
    for child in body.children().filter(|node| node.is_element()) {
        render_block(child, &mut html);
    }
    for (id, url) in media {
        html = html.replace(&format!("__DOCX_MEDIA__{id}"), url);
    }
    // A relationship that points outside the package has no bytes to embed.
    // Drop its placeholder rather than leaking the marker into the document.
    while let Some(start) = html.find("<img src=\"__DOCX_MEDIA__") {
        let Some(end) = html[start..].find('>') else {
            break;
        };
        html.replace_range(start..start + end + 1, "");
    }
    Ok(html)
}

fn render_block(node: Node, html: &mut String) {
    match node.tag_name().name() {
        "p" => render_paragraph(node, html),
        "tbl" => render_table(node, html),
        "sdt" | "sdtContent" | "customXml" => {
            for child in node.children().filter(|child| child.is_element()) {
                render_block(child, html);
            }
        }
        _ => {}
    }
}

fn render_paragraph(node: Node, html: &mut String) {
    // A paragraph that contains only display math becomes a block math node;
    // a div inside a paragraph would be invalid HTML and Tiptap would split it.
    let elements: Vec<Node> = node.children().filter(|child| child.is_element()).collect();
    let only_math = !elements.is_empty()
        && elements
            .iter()
            .all(|child| matches!(child.tag_name().name(), "pPr" | "oMathPara" | "oMath"));
    if only_math {
        let mut math = String::new();
        for child in elements {
            if matches!(child.tag_name().name(), "oMath" | "oMathPara") {
                math.push_str(&render_math_html(child, true));
            }
        }
        if !math.is_empty() {
            html.push_str(&math);
            return;
        }
    }

    let style = paragraph_style(node);
    let inner = render_inline_children(node);
    if inner.trim().is_empty() {
        return;
    }

    let level = heading_level(style.as_deref());
    if let Some(level) = level {
        html.push_str(&format!("<h{level}>{inner}</h{level}>"));
    } else if has_numbering(node) {
        html.push_str(&format!("<ul><li>{inner}</li></ul>"));
    } else {
        html.push_str(&format!("<p>{inner}</p>"));
    }
}

fn render_inline_children(node: Node) -> String {
    let mut out = String::new();
    for child in node.children().filter(|child| child.is_element()) {
        match child.tag_name().name() {
            "pPr" | "rPr" | "sectPr" | "bookmarkStart" | "bookmarkEnd" => {}
            "r" => render_run(child, &mut out),
            "hyperlink" | "ins" | "del" | "smartTag" => {
                out.push_str(&render_inline_children(child))
            }
            "oMath" => out.push_str(&render_math_html(child, false)),
            "oMathPara" => out.push_str(&render_math_html(child, false)),
            _ => {}
        }
    }
    out
}

fn render_run(node: Node, out: &mut String) {
    // A drawing is a run of its own; the relationship id is resolved to a data
    // URL after the whole document has been walked.
    for blip in node
        .descendants()
        .filter(|child| child.tag_name().name() == "blip")
    {
        if let Some(embed) = attribute(blip, "embed") {
            out.push_str(&format!("<img src=\"__DOCX_MEDIA__{embed}\" alt=\"\" />"));
        }
    }
    let mut text = String::new();
    for child in node.children().filter(|child| child.is_element()) {
        match child.tag_name().name() {
            "t" => text.push_str(&escape_html(child.text().unwrap_or(""))),
            "tab" => text.push('\t'),
            "br" | "cr" => text.push_str("<br />"),
            "noBreakHyphen" => text.push('-'),
            _ => {}
        }
    }
    if text.is_empty() {
        return;
    }

    let properties = child(node, "rPr");
    let bold = properties.and_then(|props| child(props, "b")).is_some();
    let italic = properties.and_then(|props| child(props, "i")).is_some();
    if bold && italic {
        out.push_str(&format!("<strong><em>{text}</em></strong>"));
    } else if bold {
        out.push_str(&format!("<strong>{text}</strong>"));
    } else if italic {
        out.push_str(&format!("<em>{text}</em>"));
    } else {
        out.push_str(&text);
    }
}

fn render_table(table: Node, html: &mut String) {
    html.push_str("<table><tbody>");
    let mut first_row = true;
    for row in table
        .children()
        .filter(|child| child.is_element() && child.tag_name().name() == "tr")
    {
        let header = first_row
            || row
                .descendants()
                .any(|node| node.tag_name().name() == "tblHeader");
        html.push_str("<tr>");
        for cell in row
            .children()
            .filter(|child| child.is_element() && child.tag_name().name() == "tc")
        {
            let tag = if header { "th" } else { "td" };
            html.push_str(&format!("<{tag}>"));
            for block in cell.children().filter(|child| child.is_element()) {
                render_block(block, html);
            }
            html.push_str(&format!("</{tag}>"));
        }
        html.push_str("</tr>");
        first_row = false;
    }
    html.push_str("</tbody></table>");
}

fn paragraph_style(paragraph: Node) -> Option<String> {
    paragraph
        .children()
        .find(|child| child.tag_name().name() == "pPr")
        .and_then(|properties| child(properties, "pStyle"))
        .and_then(|style| attribute(style, "val").map(str::to_string))
}

fn heading_level(style: Option<&str>) -> Option<usize> {
    let style = style?;
    if style == "Title" {
        return Some(1);
    }
    if style == "Subtitle" {
        return Some(2);
    }
    style
        .strip_prefix("Heading")
        .and_then(|digits| digits.parse::<usize>().ok())
        .filter(|level| (1..=6).contains(level))
}

fn has_numbering(paragraph: Node) -> bool {
    paragraph
        .descendants()
        .any(|node| node.tag_name().name() == "numPr")
}

fn child<'a>(node: Node<'a, 'a>, name: &str) -> Option<Node<'a, 'a>> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
}

fn attribute<'a>(node: Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_attribute(value: &str) -> String {
    escape_html(value).replace('\'', "&#39;")
}

fn render_math_html(node: Node, block: bool) -> String {
    let latex = omml_to_latex(node);
    let latex = latex.trim();
    if latex.is_empty() {
        return String::new();
    }
    let tag = if block { "div" } else { "span" };
    let kind = if block { "block-math" } else { "inline-math" };
    format!(
        "<{tag} data-type=\"{kind}\" data-latex=\"{}\"></{tag}>",
        escape_attribute(latex)
    )
}

/// OMML to LaTeX, for the structures Word actually emits.
///
/// This is not a complete Office Math converter. It covers fractions, scripts,
/// radicals, delimiters, n-ary operators, accents, bars and matrices, which is
/// what engineering and science papers use. Anything unrecognised falls back to
/// its text content rather than raw XML.
fn omml_to_latex(node: Node) -> String {
    let name = node.tag_name().name();
    match name {
        "oMath" | "oMathPara" => children_latex(node),
        "r" => {
            let text: String = node
                .descendants()
                .filter(|child| child.tag_name().name() == "t")
                .filter_map(|child| child.text())
                .collect();
            let plain = node
                .descendants()
                .find(|child| child.tag_name().name() == "sty")
                .and_then(|style| attribute(style, "val"))
                .is_some_and(|value| value == "p");
            if plain {
                format!("\\text{{{}}}", escape_latex_text(&text))
            } else {
                text
            }
        }
        "f" => format!(
            "\\frac{{{}}}{{{}}}",
            child_latex(node, "num"),
            child_latex(node, "den")
        ),
        "sSup" => format!(
            "{{{}}}^{{{}}}",
            child_latex(node, "e"),
            child_latex(node, "sup")
        ),
        "sSub" => format!(
            "{{{}}}_{{{}}}",
            child_latex(node, "e"),
            child_latex(node, "sub")
        ),
        "sSubSup" => format!(
            "{{{}}}_{{{}}}^{{{}}}",
            child_latex(node, "e"),
            child_latex(node, "sub"),
            child_latex(node, "sup")
        ),
        "rad" => {
            let degree = child_latex(node, "deg");
            let body = child_latex(node, "e");
            if degree.trim().is_empty() {
                format!("\\sqrt{{{body}}}")
            } else {
                format!("\\sqrt[{degree}]{{{body}}}")
            }
        }
        "d" => {
            let properties = child(node, "dPr");
            let begin = properties
                .and_then(|props| child(props, "begChr"))
                .and_then(|mark| attribute(mark, "val"))
                .unwrap_or("(");
            let end = properties
                .and_then(|props| child(props, "endChr"))
                .and_then(|mark| attribute(mark, "val"))
                .unwrap_or(")");
            format!(
                "\\left{} {} \\right{}",
                latex_delimiter(begin),
                children_latex(node),
                latex_delimiter(end)
            )
        }
        "nary" => {
            let properties = child(node, "naryPr");
            let operator = properties
                .and_then(|props| child(props, "chr"))
                .and_then(|mark| attribute(mark, "val"))
                .unwrap_or("∑");
            format!(
                "{}_{{{}}}^{{{}}} {}",
                nary_operator(operator),
                child_latex(node, "sub"),
                child_latex(node, "sup"),
                child_latex(node, "e")
            )
        }
        "bar" => format!("\\overline{{{}}}", child_latex(node, "e")),
        "acc" => {
            let accent = child(node, "accPr")
                .and_then(|props| child(props, "chr"))
                .and_then(|mark| attribute(mark, "val"))
                .unwrap_or("^");
            let command = match accent {
                "ˆ" | "^" => "\\hat",
                "˜" | "~" => "\\tilde",
                "¯" | "‾" => "\\bar",
                "→" => "\\vec",
                "˙" => "\\dot",
                "¨" => "\\ddot",
                _ => "\\hat",
            };
            format!("{command}{{{}}}", child_latex(node, "e"))
        }
        "m" => {
            let rows: Vec<String> = node
                .children()
                .filter(|child| child.tag_name().name() == "mr")
                .map(|row| {
                    row.children()
                        .filter(|cell| cell.tag_name().name() == "e")
                        .map(omml_to_latex)
                        .collect::<Vec<_>>()
                        .join(" & ")
                })
                .collect();
            format!("\\begin{{matrix}}{}\\end{{matrix}}", rows.join(" \\\\ "))
        }
        _ => children_latex(node),
    }
}

fn children_latex(node: Node) -> String {
    node.children()
        .filter(|child| child.is_element())
        .map(omml_to_latex)
        .collect()
}

fn child_latex(node: Node, name: &str) -> String {
    child(node, name).map(children_latex).unwrap_or_default()
}

fn nary_operator(value: &str) -> &'static str {
    match value {
        "∑" => "\\sum",
        "∏" => "\\prod",
        "∐" => "\\coprod",
        "∫" => "\\int",
        "∬" => "\\iint",
        "∭" => "\\iiint",
        "∮" => "\\oint",
        "⋃" => "\\bigcup",
        "⋂" => "\\bigcap",
        _ => "\\sum",
    }
}

fn latex_delimiter(value: &str) -> String {
    match value {
        "" => ".".to_string(),
        "{" => "\\{".to_string(),
        "}" => "\\}".to_string(),
        other => other.to_string(),
    }
}

/// Characters that would be read as LaTeX control syntax inside `\text{}`.
fn escape_latex_text(value: &str) -> String {
    value
        .replace('\\', "\\textbackslash{}")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('&', "\\&")
        .replace('%', "\\%")
        .replace('$', "\\$")
        .replace('#', "\\#")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use docx_rs::{Docx, Paragraph, Run};

    fn docx_at(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let doc = Docx::new()
            .add_paragraph(
                Paragraph::new()
                    .style("Heading1")
                    .add_run(Run::new().add_text("A field guide")),
            )
            .add_paragraph(Paragraph::new().add_run(Run::new().add_text("First & second.")))
            .add_paragraph(Paragraph::new().add_run(Run::new().add_text("Last line.")));
        let mut buffer = Vec::new();
        doc.pack(std::io::Cursor::new(&mut buffer))
            .expect("pack docx");
        std::fs::write(&path, buffer).expect("write docx");
        path
    }

    #[test]
    fn docx_headings_and_paragraphs_become_html() {
        let path = docx_at("quill-import-test.docx");
        let text = extract_docx(&path, "test.docx").expect("extract docx");
        assert!(text.starts_with("<h1>A field guide</h1>"));
        assert!(text.contains("<p>First &amp; second.</p>"));
        assert!(text.contains("<p>Last line.</p>"));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn docx_tables_and_equations_become_editor_nodes() {
        let xml = r#"<w:document xmlns:w="w" xmlns:m="m"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Guide</w:t></w:r></w:p>
            <w:p><w:r><w:t>Load </w:t></w:r><m:oMath><m:sSub><m:e><m:r><m:t>R</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub></m:sSub></m:oMath></w:p>
            <w:tbl>
              <w:tr><w:tc><w:p><w:r><w:t>Feature</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
              <w:tr><w:tc><w:p><w:r><w:t>Gain</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr>
            </w:tbl>
        </w:body></w:document>"#;
        let html = docx_xml_to_html(xml, &HashMap::new()).expect("convert docx xml");
        assert!(html.contains("<h1>Guide</h1>"), "heading: {html}");
        assert!(
            html.contains(r#"<span data-type="inline-math" data-latex="{R}_{1}"></span>"#),
            "math: {html}"
        );
        assert!(html.contains("<table><tbody><tr><th><p>Feature</p></th>"));
        assert!(html.contains("<tr><td><p>Gain</p></td><td><p>40</p></td></tr>"));
        assert!(!html.contains("w:tbl") && !html.contains("m:oMath"));
    }

    #[test]
    fn docx_drawings_resolve_to_embedded_images() {
        let xml = r#"<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
            <w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
        </w:body></w:document>"#;
        let media = HashMap::from([("rId5".to_string(), "data:image/png;base64,AAA".to_string())]);
        let html = docx_xml_to_html(xml, &media).expect("convert docx xml");
        assert!(
            html.contains(r#"<img src="data:image/png;base64,AAA" alt="" />"#),
            "image: {html}"
        );
        assert!(!html.contains("__DOCX_MEDIA__"));
    }

    #[test]
    fn an_unknown_extension_is_refused_before_reading() {
        let error = read_text_file("/tmp/photo.png").expect_err("png is not importable");
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[test]
    fn a_text_pdf_yields_its_text() {
        // A system manual when the test machine has TeX installed; the test is
        // skipped rather than made flaky on a machine without it.
        let path = "/usr/share/doc/lmodern/lm-info.pdf";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let file = read_text_file(path).expect("extract pdf");
        assert_eq!(file.format, "text");
        assert!(
            file.content.contains("Courtesy"),
            "the PDF text should be readable"
        );
    }
}
