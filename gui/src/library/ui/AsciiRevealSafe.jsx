/**
 * `ascii-reveal`, with the two safeguards a decorative effect needs.
 *
 * The library measures text ranges to place its glyphs. jsdom and a stripped
 * webview provide the Range object without `getBoundingClientRect`, which makes
 * the real component throw during a layout effect. That must not be able to
 * take down the library or the boot screen, so an environment without the
 * measurement renders the same subtree plainly.
 *
 * A browser that can measure still gets an effect boundary: a decorative
 * animation is never worth losing the books over. The fallback is the plain
 * element, not an empty box, so the content is present in both paths.
 */

import React from 'react'
import { AsciiReveal } from 'ascii-reveal'
import { EffectBoundary } from '../../ErrorBoundary.jsx'

const canMeasureText = () =>
  typeof window !== 'undefined'
  && typeof window.Range !== 'undefined'
  && typeof window.Range.prototype.getBoundingClientRect === 'function'

export function AsciiRevealSafe({
  as: Tag = 'div',
  children,
  className,
  preset = 'decode',
  duration = 'fast',
  origin,
  lazy = false,
  loading,
  revealOnMount = true,
  shimmer,
  ...rest
}) {
  const plain = <Tag className={className} {...rest}>{children}</Tag>
  if (!canMeasureText()) return plain

  return (
    <EffectBoundary fallback={plain}>
      <AsciiReveal
        as={Tag}
        className={className}
        preset={preset}
        duration={duration}
        origin={origin}
        lazy={lazy}
        loading={loading}
        revealOnMount={revealOnMount}
        shimmer={shimmer}
        {...rest}
      >
        {children}
      </AsciiReveal>
    </EffectBoundary>
  )
}
