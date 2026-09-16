/** Book-cover model for the library: deterministic palette + typographic
 * sizes keyed by the project id, so each document renders a stable cover. */

export interface CoverPalette {
  bg: string
  ink: string
  accent: string
}

/** Warm, read-like palettes. Dark cloth binds with light paper ink. */
export const COVERS: CoverPalette[] = [
  { bg: '#5b3328', ink: '#f4ede0', accent: '#c8a06a' }, // oxblood / brass
  { bg: '#2e4a3a', ink: '#eef2e6', accent: '#c9b458' }, // forest / gold
  { bg: '#2c3e57', ink: '#edf1f6', accent: '#a7b8cc' }, // slate / steel
  { bg: '#4a2a3f', ink: '#f2e8ee', accent: '#d9a0c0' }, // plum / mauve
  { bg: '#41502e', ink: '#f0f2e2', accent: '#d6cf9f' }, // olive / sage-gold
  { bg: '#3a3a3a', ink: '#f0eeee', accent: '#b9a15f' }, // charcoal / old-gold
  { bg: '#54361f', ink: '#f4ead9', accent: '#d8b98a' }, // umber / amber
  { bg: '#233c3f', ink: '#eaf2f1', accent: '#9fc6c2' }, // pine / teal
]

export type CoverSizeKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface CoverSize {
  w: number
  /** height derived from an ~1.4 book ratio */
  h: number
  /** title font size */
  fs: number
  /** subject / meta font size */
  sub: number
  /** inner padding around the text block */
  pad: number
}

export const COVER_SIZES: Record<CoverSizeKey, CoverSize> = {
  xs: { w: 60, h: 84, fs: 8, sub: 6, pad: 6 },
  sm: { w: 120, h: 168, fs: 12, sub: 8, pad: 10 },
  md: { w: 132, h: 185, fs: 15, sub: 10, pad: 12 },
  lg: { w: 168, h: 235, fs: 20, sub: 12, pad: 16 },
  xl: { w: 224, h: 314, fs: 26, sub: 14, pad: 20 }
}

/** Deterministic palette pick: djb2 hash of the seed (project id) into COVERS. */
export function pickCover(seed: string): CoverPalette {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i)
  }
  return COVERS[(hash >>> 0) % COVERS.length]
}