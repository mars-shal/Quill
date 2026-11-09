/**
 * Inline SVG icon registry.
 *
 * Kept in its own module so components (the export dialog, for example) can
 * render icons without importing the whole application entry point.
 *
 * The app's icon set is sourced from the allsvgicons registry (Phosphor via
 * the `ph:` pack) with the shadcn CLI:
 *
 *     pnpm dlx shadcn@latest add https://i.allsvgicons.com/r/ph:<name>.json
 *
 * which lands full <svg> documents under `src/assets/icons/ph/`; any other
 * pack installed the same way resolves too. Lookup order: the REGISTRY_ICONS
 * name map, a bare filename match, an exact `pack:name`, then the first-party
 * path data in this file as the fallback for names no pack covers yet. No
 * runtime string ever reaches `dangerouslySetInnerHTML`, and an unknown name
 * falls back to the file glyph.
 */

const iconPaths = {
  layers: '<path d="m12 3 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/>',
  file: '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  draft: '<path d="m4 16-.8 4.8L8 20l10-10-4-4L4 16Z"/><path d="m12.5 6.5 4 4M4 16l4 4"/>',
  revise: '<path d="M4 17.5A8 8 0 1 0 6 6.2"/><path d="M4 4v5h5M12 7v5l3 2"/>',
  published: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/>',
  sparkle: '<path d="m12 3 1.55 5.45L19 10l-5.45 1.55L12 17l-1.55-5.45L5 10l5.45-1.55L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/>',
  cloud: '<path d="M7 18a4 4 0 1 1 1-7.87A5.5 5.5 0 0 1 18.5 12H19a3 3 0 1 1 0 6H7Z"/><path d="m9 14 2 2 4-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  download: '<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/>',
  sort: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="m17 15 3 3-3 3"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  list: '<path d="M5 6h14M5 12h14M5 18h14"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15.1a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.6v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H6.2v-2.6h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2H15v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2V14h-.2a1.7 1.7 0 0 0-1.6 1.1Z"/>',
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  'mic-off': '<path d="M9 9v3a3 3 0 0 0 4.6 2.5M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 10.9 6M19 11a7 7 0 0 1-.4 2.3M12 18v3M8 21h8M4 4l16 16"/>',
  details: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
  tag: '<path d="m4 4 7.5.5L20 13l-7 7-8.5-8.5L4 4Z"/><circle cx="8" cy="8" r="1"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  attach: '<path d="m20.5 11.5-8.7 8.7a5 5 0 0 1-7.1-7.1l9.2-9.2a3.4 3.4 0 1 1 4.8 4.8l-9.2 9.2a1.8 1.8 0 0 1-2.5-2.5l8.5-8.5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 4"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
  send: '<path d="m4 4 16 8-16 8 3-8-3-8Z"/><path d="M7 12h13"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 6.5a3 3 0 0 1 0 5.8M17 15a5 5 0 0 1 3.5 5"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/><path d="m3 3 6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/>',
  undo: '<path d="M9 8 4 12l5 4"/><path d="M4 12h9a6 6 0 0 1 6 6"/>',
  // Mirrored undo, for the redo half of the history pair.
  redo: '<path d="m15 8 5 4-5 4"/><path d="M20 12h-9a6 6 0 0 0-6 6"/>',
  minus: '<path d="M5 12h14"/>',
  // The key field's two actions: reveal the stored secret, and copy it.
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.5 15.5 0 0 1-3.2 4M6.3 8.2A15.8 15.8 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.6-.7"/><path d="M10.2 10.2a2.5 2.5 0 0 0 3.6 3.6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h.5"/>',
  // Table editing: remove a row or a column (the two ways to shrink a grid),
  // and remove the whole table.
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  // Library navigation and import. These names have no registry file yet, so
  // the first-party paths are what the sidebar draws.
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  home: '<path d="m4 10 8-6.5 8 6.5"/><path d="M6 9v10h12V9"/><path d="M10 19v-5h4v5"/>',
  upload: '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M5 16v3h14v-3"/>',
  folder: '<path d="M3.5 6.5h6l2 2h9v10h-17z"/>',
}

// --- Registry icons (the app's icon set) ---------------------------------
//
// Icons are fetched from the allsvgicons registry with the shadcn CLI --
// `pnpm dlx shadcn@latest add https://i.allsvgicons.com/r/<pack>:<name>.json`
// -- which lands full <svg> documents under `src/assets/icons/<pack>/`. The
// lookup resolves in this order:
//
//   1. REGISTRY_ICONS: the call site's name mapped to a registry file
//      (the app's set, now sourced from Phosphor `ph:`),
//   2. a file whose bare filename matches the name (any pack, so
//      `<Icon name="a-b">` finds `tabler/a-b.svg`),
//   3. `pack:name` exactly (e.g. `ph:function`),
//   4. the first-party path data below, for anything not in a pack yet.
//
// The glob is build-time: only files already in the tree can resolve, so no
// runtime string ever reaches `dangerouslySetInnerHTML`.
const REGISTRY_ICONS = {
  layers: 'stack',
  file: 'file',
  draft: 'pen',
  revise: 'arrow-clockwise',
  published: 'file-text',
  plus: 'plus',
  back: 'caret-left',
  panel: 'sidebar',
  sparkle: 'sparkle',
  cloud: 'cloud',
  check: 'check',
  chevron: 'caret-right',
  down: 'caret-down',
  more: 'dots-three-outline',
  download: 'download-simple',
  sort: 'sort-ascending',
  grid: 'grid-four',
  list: 'list',
  settings: 'gear',
  details: 'list-bullets',
  tag: 'tag',
  close: 'x',
  attach: 'paperclip',
  image: 'image-square',
  share: 'share-network',
  send: 'paper-plane-tilt',
  users: 'users-three',
  expand: 'arrows-out',
  undo: 'arrow-bend-up-left',
  redo: 'arrow-bend-up-right',
  minus: 'minus',
  // Editor toolbar additions (insert formula / insert image).
  formula: 'function',
}

// Vite rewrites this call at build time. The test runner loads the module in
// plain Node, which has no glob, so the call is guarded and the map degrades
// to empty there -- first-party icons keep working, and no test needs Vite.
const registrySvgs = (() => {
  try {
    return import.meta.glob('./assets/icons/*/*.svg', { query: '?raw', import: 'default', eager: true }) || {}
  } catch {
    return {}
  }
})()

// Filename (without extension) -> svg document, plus `pack:name` aliases.
// Registry files carry `width="1em" height="1em"`; the wrapper owns the size,
// so the document fills it instead.
const registryIcons = (() => {
  const byName = new Map()
  const byId = new Map()
  for (const [path, raw] of Object.entries(registrySvgs)) {
    const svg = String(raw)
      .replace(/width="[^"]*"/, 'width="100%"')
      .replace(/height="[^"]*"/, 'height="100%"')
    const file = path.split('/').pop().replace(/\.svg$/, '')
    const pack = path.split('/').at(-2) || ''
    if (!byName.has(file)) byName.set(file, svg)
    byId.set(`${pack}:${file}`, svg)
  }
  return { byName, byId }
})()

function registrySvg(name) {
  const mapped = REGISTRY_ICONS[name] || name
  return registryIcons.byId.get(mapped) || registryIcons.byId.get(name) || registryIcons.byName.get(mapped) || registryIcons.byName.get(name)
}

export function Icon({ name, size = 16, className = '' }) {
  const file = registrySvg(name)
  if (file) {
    return (
      <span
        className={className}
        role="img"
        aria-hidden="true"
        style={{ display: 'inline-flex', width: size, height: size, flex: 'none' }}
        dangerouslySetInnerHTML={{ __html: file }}
      />
    )
  }
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconPaths[name] || iconPaths.file }} />
}
