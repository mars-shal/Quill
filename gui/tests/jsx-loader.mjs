/**
 * Node module customisation hook for the render test.
 *
 * Lets Node import the application's `.jsx` and `.css` files so a test can
 * mount the real component tree rather than a reimplementation of it.
 *
 * - `.jsx` is transformed with esbuild (already present via Vite)
 * - `.css` resolves to an empty module; styling is not under test here
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true }
  }

  if (url.endsWith('.jsx')) {
    const path = fileURLToPath(url)
    const source = await readFile(path, 'utf8')
    const { code } = await transform(source, {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
      sourcefile: path,
      target: 'node20',
    })
    return { format: 'module', source: code, shortCircuit: true }
  }

  return nextLoad(url, context)
}
