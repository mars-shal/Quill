/**
 * A document's cover: which colour it is bound in, and how it is printed.
 *
 * Every cover in the library was one cream rectangle. The tile carried the
 * title underneath it and the sheet carried nothing at all, so fifteen
 * documents read as fifteen identical placeholders. This module is the answer,
 * and it exists as its own file rather than as four lines inside `Library`
 * because `scripts/check-contrast.mjs` has to measure the same numbers the grid
 * paints. Two copies of a tone ladder would be the drift this project's own
 * `check-contrast` header complains about, one level up: the palette the gate
 * enforces and the palette the app paints would be two different things.
 *
 * ---------------------------------------------------------------------------
 * Why a hash, and why *this* hash
 * ---------------------------------------------------------------------------
 *
 * The value is derived from `doc.id` and nothing else. Not the index, not the
 * sort order, not `Math.random()`, not `Date.now()` -- every one of those makes
 * a document change its cover when the library is re-sorted, re-filtered, or
 * reopened, and a book that changes colour when you sort your shelf is not a
 * book. An id is the one property that belongs to the document rather than to
 * the moment it happens to be rendered.
 *
 * FNV-1a rather than a running counter because a counter is the index wearing
 * a disguise, and `hashCode()`-style primitives on short strings are notoriously
 * clumped in their low bits, which is exactly where the pigment selector reads
 * from. FNV-1a spreads a UUID well; the avalanche step below is what makes it
 * spread *sequential* ids and imported ids well too, because
 * `documents.id` is a TEXT column and the legacy import does not promise UUIDs.
 *
 * Three axes, not one. A single scalar cannot both space the values far enough
 * apart to see and give fifteen documents enough of them to land on: at a
 * spacing wide enough to read, one axis gives a handful of distinct covers; at
 * a spacing fine enough not to collide, the neighbours are indistinguishable.
 * So the hash feeds three independent digits, and each axis costs one CSS
 * declaration rather than a colour of its own.
 */

/**
 * The three pigments a cover can be bound in, as token names.
 *
 * All three are theme tokens, and all three are tokens a theme actually writes,
 * which is what makes a library of covers re-bind itself when the reader picks a
 * different theme rather than staying a fixed set of colours that only happens
 * to sit on a themed page.
 *
 *  - `--accent` is the theme's own hue and takes a third of the library.
 *  - `--publish` is the second hue the palette already commits to. Using a
 *    status token as cloth is deliberate rather than a shortage of colours: it
 *    is the only other hue in every built-in theme *and* every curated custom
 *    one, so borrowing it keeps the shelf inside the theme. `--danger` is
 *    deliberately absent -- a red book in a shelf of blue ones is a warning
 *    label the reader never asked to read.
 *  - `--sheet-shade` is the sheet family's own ink, the one every sheet shadow
 *    is mixed from. Binding a book in it is what makes the neutral books on the
 *    shelf: a black cloth among the tinted ones is what a real shelf looks like,
 *    and it costs the theme nothing because it borrows a token it already has.
 *
 * The pigment is a *tint in the cloth*, not the cloth itself. A cover is bound
 * in the theme's `--sidebar`, so the shelf always sits inside the active
 * palette -- Catppuccin books are Catppuccin-coloured, night books are night --
 * and the pigment is mixed into it at `COVER_PIGMENT_TINT`. The ratio is a
 * constant rather than a per-document axis because it is a property of the
 * dyeing, not of the individual book.
 */
export const COVER_PIGMENTS = ['--accent', '--publish', '--sheet-shade']

/**
 * How much pigment is dyed into the cloth, as a percentage.
 *
 * Small on purpose. At a third or a half the covers are coloured books; at one
 * part in seven the hue is legible when two covers sit side by side and
 * invisible when they do not, which is exactly what a cloth binding looks like
 * under a lamp. `coverStyle` emits it as `--cover-tint` so the stylesheet and
 * `check:contrast` cannot disagree about the number.
 */
export const COVER_PIGMENT_TINT = 14

/**
 * How much `--main` is lifted into the cloth, as a percentage.
 *
 * The ladder is what makes fifteen books fifteen *different* books. A short,
 * coarse, hand-spaced ladder rather than a continuous hash range, because
 * adjacent covers are read side by side at roughly 168px: a fine-grained range
 * hands fifteen documents fifteen technically-different covers that all read as
 * the same one. Each step mixes a little more of the page surface into the
 * cloth, so a neighbour is visibly lighter without leaving the theme.
 *
 * The ceiling is 24% and it is a material decision before it is a contrast one:
 * past about a quarter the cloth stops reading as a binding and becomes the page
 * again. The floor is 4% because below that every cover is the same absence of
 * lift. The title is `--text-1` over the mixed surface, and `check:contrast`
 * re-measures the whole ladder against every theme on every run.
 */
export const COVER_TONES = [4, 9, 14, 19, 24]

/** The two ways a cover is printed. Both are cheap; both read as a book. */
export const COVER_LAYOUTS = ['stacked', 'ruled']

/** The range the contrast gate has to check end to end. */
export const COVER_TONE_FLOOR = COVER_TONES[0]
export const COVER_TONE_CEILING = COVER_TONES[COVER_TONES.length - 1]

/**
 * FNV-1a over the id, 32-bit, with an avalanche finaliser.
 *
 * The finaliser is murmur3's `fmix32`: multiply, xor-shift, multiply, xor-shift.
 * FNV-1a on its own leaves the low bits of short, near-identical inputs close
 * together, and the pigment selector reads the low bits, so without this a
 * library whose ids were generated in sequence would alternate between the same
 * two pigments while appearing to be hashed.
 */
export function coverHash(id) {
  const text = String(id ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // 16777619 as a multiply rather than a shift, so a 32-bit id string does not
    // lose its high bits to the shift on the way through.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * The cover a document gets, from its id alone.
 *
 * Three digits taken from three different byte ranges of the one hash, so the
 * axes are uncorrelated: a document that lands on the first pigment is not
 * thereby pushed to a particular tone.
 */
export function coverTreatment(id) {
  const hash = coverHash(id)
  return {
    pigment: COVER_PIGMENTS[hash % COVER_PIGMENTS.length],
    tone: COVER_TONES[(hash >>> 8) % COVER_TONES.length],
    layout: COVER_LAYOUTS[(hash >>> 17) % COVER_LAYOUTS.length],
  }
}

/**
 * The inline custom properties a cover reads, for a treatment already derived.
 *
 * Numbers and token names only -- no colour is computed here. The mix itself is
 * a `color-mix` in the stylesheet over theme tokens, so switching the theme
 * re-binds every cover without any of this running again. That split is why a
 * theme change costs nothing at runtime: React does not re-render the grid when
 * the theme changes, the custom properties are untouched, and the `color-mix`
 * underneath them simply resolves against the new tokens.
 *
 * `layout` is not among them. It is a class rather than a custom property
 * because the two layouts differ in how the title is placed and whether the
 * spine is drawn, which is structure and not colour.
 *
 * `--cover-tint` is not derived from the hash: it is the constant dye ratio the
 * whole shelf shares. It rides on the element rather than living only in the
 * stylesheet so that `scripts/check-contrast.mjs`, which imports
 * `COVER_PIGMENT_TINT`, measures the exact ratio the browser mixes.
 *
 * The fallbacks in the stylesheet are what an element with neither property
 * gets: the plain cloth, undyed and unlifted.
 */
export function coverStyle({ pigment, tone }) {
  return {
    '--cover-pigment': `var(${pigment})`,
    '--cover-tint': `${COVER_PIGMENT_TINT}%`,
    '--cover-lighten': `${tone}%`,
  }
}
