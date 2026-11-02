/**
 * The assistant panel's decorative effects, loaded on demand.
 *
 * These five libraries are 426kB of the bundle between them -- more than Yjs and
 * ProseMirror View added together -- and they render nothing at all until the
 * Conclave panel is open with a WebGL2 context. Imported statically, every launch
 * paid to download, parse and execute all of that in order to show a plain send
 * button.
 *
 * `React.lazy` moves each one behind the `EffectBoundary` that already wraps
 * every usage site, which supplies the plain, undecorated version of the same
 * control as its `Suspense` fallback. So the first paint of the panel is the
 * fallback, and the effect replaces it a frame or two later once its chunk lands.
 * That is the same trade the WebGL-unavailable path already makes, except now it
 * also covers the platforms where WebGL is fine.
 *
 * Two details worth knowing:
 *
 *  - These packages export named components, and `lazy` wants a `default`, so
 *    each one maps across. Nothing is re-exported as a wrapper component.
 *
 *  - `Liquid.Item` is a static member of `Liquid`, so `Liquid.Item` on a `lazy`
 *    component is `undefined`. It gets its own `lazy` pointing at the *same*
 *    module, so the second one resolves from the first one's chunk rather than
 *    asking for it twice.
 */

import { lazy } from 'react'

export const MetalFx = lazy(() =>
  import('metal-fx').then((module) => ({ default: module.MetalFx })))

export const BotAvatar = lazy(() =>
  import('bot-avatars').then((module) => ({ default: module.BotAvatar })))

export const ThinkingOrb = lazy(() =>
  import('thinking-orbs').then((module) => ({ default: module.ThinkingOrb })))

export const BorderBeam = lazy(() =>
  import('border-beam').then((module) => ({ default: module.BorderBeam })))

const liquidGoop = () => import('liquid-gooey')

export const Liquid = lazy(() =>
  liquidGoop().then((module) => ({ default: module.Liquid })))

export const LiquidItem = lazy(() =>
  liquidGoop().then((module) => ({ default: module.Liquid.Item })))