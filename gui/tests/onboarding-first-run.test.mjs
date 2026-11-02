/**
 * The first-run sequence.
 *
 * A release build starts with an empty library, so the first window a reader
 * sees is the onboarding card. That makes it the one surface whose failure is
 * total: a broken first step is a broken app, and a card that reappears on every
 * launch is worse than no card at all.
 *
 * This suite describes a genuinely fresh install -- `completed` starts 'false'
 * -- and walks the sequence the way a reader would, then checks what was
 * written. The other render suites leave the fixture at 'true', which is the
 * existing-install answer, so this card never covers what they are testing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clickAndSettle,
  handlers,
  mockFramerMotion,
  onboardingFixtures,
  providerFixtures,
  root,
  settle,
  tick,
} from './support/dom-harness.mjs'

mockFramerMotion()

// A fresh profile, and a local model server already running: the two facts the
// card is built to react to.
onboardingFixtures.state.completed = 'false'
const TOOL = {
  id: 'ollama',
  label: 'Ollama',
  command: 'ollama',
  version: '0.5.1',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: ['llama3.2:1b', 'qwen2:0.5b'],
}
handlers.detect_cli_tools = () => [{ ...TOOL }]

const settingsCalls = []
const workingSettings = handlers.set_settings
handlers.set_settings = (args) => { settingsCalls.push(args); return workingSettings(args) }

await import('../src/main.jsx')
await settle()
await tick(120)

const card = () => root.querySelector('.onboarding-layer')
const next = () => root.querySelector('.onboarding-next')

test('a fresh install opens on the welcome card', () => {
  const layer = card()
  assert.ok(layer, 'a first run should open the onboarding card')
  assert.equal(layer.getAttribute('aria-modal'), 'true', 'it is a modal surface, not a toast')
  assert.match(layer.textContent, /Quill/, 'it should name the app')
  assert.equal(
    root.querySelectorAll('.library-layer').length > 0,
    true,
    'the workspace stays mounted underneath rather than being replaced',
  )
})

test('the second step is the theme, and picking one persists it', async () => {
  await clickAndSettle(next())

  const themes = [...root.querySelectorAll('.onboarding-theme')]
  assert.ok(themes.length >= 2, 'the look step should offer the built-in themes')

  const before = settingsCalls.length
  const dark = themes.find((node) => /night|dark/i.test(node.textContent))
  assert.ok(dark, 'a dark theme should be on offer')
  await clickAndSettle(dark)

  const written = settingsCalls.slice(before).filter((call) => call && call.theme)
  assert.equal(written.length, 1, 'choosing a look should be saved, not held as a draft')
  assert.equal(dark.getAttribute('aria-checked'), 'true', 'the chosen theme should read as chosen')
})

test('the last step offers the detected server and adopts it without a key', async () => {
  await clickAndSettle(next())

  const tool = root.querySelector('.onboarding-tool')
  assert.ok(tool, 'a running local server should be offered by name')
  assert.match(tool.textContent, /Ollama/)
  assert.match(tool.textContent, /2 models/, 'the count is what tells a reader it can be used')

  await clickAndSettle(tool)

  const active = providerFixtures.active()
  assert.equal(active?.id, TOOL.id, 'adopting the server should make it the active provider')
  assert.equal(active?.baseUrl, TOOL.baseUrl, 'the endpoint must be the one that answered')
  assert.deepEqual(active?.models, TOOL.models, 'its real model list travels with the row')
  assert.equal(active?.defaultModel, TOOL.models[0], 'a model must be chosen or no turn can run')
})

test('finishing records that it happened, so it never opens again', async () => {
  assert.equal(card(), null, 'the card should be gone once a server is adopted')
  assert.equal(
    onboardingFixtures.state.completed,
    'true',
    'the flag is what stops the card covering the workspace on every later launch',
  )
})
