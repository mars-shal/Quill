/** Native bridge helpers that degrade gracefully in a plain browser. */

export async function pickSourceFile(): Promise<string | null> {
  if (window.quill) return window.quill.pickSourceFile()
  // Browser dev mode: prompt instead of a native dialog.
  return window.prompt('Path to a source document (md/docx/pdf):')
}
