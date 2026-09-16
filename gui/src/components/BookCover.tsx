import { useId } from 'react'
import { COVER_SIZES, pickCover, type CoverSizeKey } from '../lib/covers'

interface BookCoverProps {
  /** Stable per-project seed. Picks the palette (project_id). */
  seed: string
  title: string
  subject?: string
  meta?: string
  size?: CoverSizeKey
}

const MAX_LINES = 4

interface WrappedTitle {
  lines: string[]
  truncated: boolean
}

/** Word-wrap a title into tspans at an approximate glyph width. */
function wrapTitle(title: string, charsPerLine: number): WrappedTitle {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { lines: [], truncated: false }
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && current.length + 1 + word.length > charsPerLine) {
      lines.push(current)
      current = ''
      if (lines.length >= MAX_LINES) return { lines, truncated: true }
    }
    if (word.length > charsPerLine) {
      lines.push(word.slice(0, charsPerLine))
      return { lines, truncated: true }
    }
    current = current ? `${current} ${word}` : word
  }
  if (current) lines.push(current)
  return { lines, truncated: false }
}

/** SVG book cover for the library grid. Pure presentational. Hover lift
 * and click live on the wrapping button in LibraryScreen. */
export default function BookCover({ seed, title, subject, meta, size = 'md' }: BookCoverProps) {
  const s = COVER_SIZES[size]
  const { bg, ink, accent } = pickCover(seed)
  // useId may contain ":" which is invalid inside an SVG url() fragment
  const grainId = `grain-${useId().replace(/:/g, '')}`

  const spineW = Math.max(5, Math.round(s.w * 0.09))
  const pad = s.pad
  const textX = spineW + pad
  const textW = s.w - textX - pad
  // approximate average glyph advance for the prose face
  const charsPerLine = Math.floor(textW / (s.fs * 0.52))
  const { lines, truncated } = wrapTitle(title, charsPerLine)
  const lineH = s.fs * 1.28

  const subjectY = pad + s.sub + 10
  const titleY = subjectY + 16
  const ruleTop = pad + 3
  const ruleBottom = s.h - pad - 20
  const metaY = s.h - pad - 5

  return (
    <svg
      viewBox={`0 0 ${s.w} ${s.h}`}
      width={s.w}
      height={s.h}
      role="img"
      aria-label={title}
      className="book-cover"
    >
      <defs>
        <filter id={grainId} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0.03" />
        </filter>
        <linearGradient id={`spine-${grainId}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.35" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* board */}
      <rect x="1" y="1" width={s.w - 2} height={s.h - 2} rx="3" fill={bg} stroke="#000" strokeOpacity="0.12" />
      {/* paper grain */}
      <rect x="1" y="1" width={s.w - 2} height={s.h - 2} rx="3" fill="#fff" filter={`url(#${grainId})`} />
      {/* spine shadow */}
      <rect x="1" y="1" width={spineW} height={s.h - 2} rx="2" fill={`url(#spine-${grainId})`} />

      {/* decorative rules */}
      <rect x={textX} y={ruleTop} width={textW} height="2" fill={accent} opacity="0.85" rx="1" />
      <rect x={textX} y={ruleBottom} width={Math.min(textW, s.w * 0.4)} height="2" fill={accent} opacity="0.85" rx="1" />

      {/* subject */}
      {subject ? (
        <text
          x={textX}
          y={subjectY}
          fontSize={s.sub}
          fill={accent}
          fontWeight="700"
          letterSpacing="0.14em"
          style={{ fontFamily: 'var(--font-ui)' }}
        >
          {subject.toUpperCase()}
        </text>
      ) : null}

      {/* title, wrapped, clamped to four lines */}
      <text x={textX} y={titleY} fontSize={s.fs} fill={ink} fontWeight="700" style={{ fontFamily: 'var(--font-prose)' }}>
        {lines.map((line, i) => (
          <tspan key={i} x={textX} dy={i === 0 ? 0 : lineH}>
            {truncated && i === lines.length - 1 ? `${line}…` : line}
          </tspan>
        ))}
      </text>

      {/* meta */}
      {meta ? (
        <text
          x={textX}
          y={metaY}
          fontSize={s.sub * 0.85}
          fill={ink}
          opacity="0.66"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {meta}
        </text>
      ) : null}
    </svg>
  )
}