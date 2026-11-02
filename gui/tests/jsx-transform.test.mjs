/**
 * Guards the JSX transform configuration.
 *
 * A `.jsx` file that imports only hooks (no default `React`) throws
 * "Can't find variable: React" when esbuild uses the *classic* transform. That
 * failure appears only in `tauri dev` — `vite build` and the jsdom render test
 * both use the automatic runtime, so nothing else caught it.
 *
 * This test asserts the transform Vite is configured to use, so a config change
 * that reintroduces the classic runtime fails here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { build } from 'esbuild'

const srcDir = join(import.meta.dirname, '..', 'src')

async function jsxFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await jsxFiles(full)))
    else if (entry.name.endsWith('.jsx')) found.push(full)
  }
  return found
}

test('vite is configured for the automatic JSX runtime', async () => {
  const config = await readFile(join(import.meta.dirname, '..', 'vite.config.js'), 'utf8')
  assert.match(
    config,
    /jsx:\s*['"]automatic['"]/,
    'vite.config.js must set esbuild.jsx to "automatic", otherwise hook-only .jsx files throw at runtime',
  )
})

test('no .jsx file relies on a bare React identifier', async () => {
  const files = await jsxFiles(srcDir)
  assert.ok(files.length > 0, 'expected to find .jsx sources')

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const result = await build({
      stdin: {
        contents: source,
        loader: 'jsx',
        resolveDir: dirname(file),
        sourcefile: file,
      },
      bundle: false,
      write: false,
      format: 'esm',
      jsx: 'automatic',
    })

    const code = result.outputFiles[0].text
    assert.doesNotMatch(
      code,
      /React\.createElement/,
      `${relative(srcDir, file)} compiled to React.createElement, which needs React in scope`,
    )
  }
})

test('the render suite covers every component that uses JSX', async () => {
  // The render test mounts src/main.jsx, which transitively imports the rest.
  // A new top-level component that is never rendered would not be caught, so
  // this simply records the current set for diffing.
  const files = (await jsxFiles(srcDir)).map((f) => relative(srcDir, f)).sort()
  assert.ok(files.includes('main.jsx'), 'entry point should be present')
  assert.ok(files.length >= 4, `expected several components, found ${files.length}`)
})
