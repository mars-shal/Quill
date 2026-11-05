/**
 * The page for a path the app does not own.
 *
 * Quill is a single-window editor, so this is only reachable from a web build
 * (or a hand-edited URL), not from the normal library/editor flow. It stays on
 * the brand palette rather than the reader's theme because it can render before
 * settings exist.
 */
export function NotFound({ onHome }) {
  const goHome = () => {
    if (typeof onHome === 'function') onHome()
    else window.location.assign('/')
  }

  return (
    <main className="notfound">
      <section className="notfound-card" aria-labelledby="notfound-title">
        <span className="notfound-code">404</span>
        <h1 id="notfound-title">This page doesn’t exist.</h1>
        <p>You might have taken a wrong turn. The library is still right here.</p>
        <button className="notfound-home" type="button" onClick={goHome}>Back to Quill</button>
      </section>
    </main>
  )
}
