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
  awaitBoot,
  calls,
  clickAndSettle,
  handlers,
  mockFramerMotion,
  onboardingFixtures,
  providerFixtures,
  root,
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
await awaitBoot()

const card = () => root.querySelector('.onboarding-layer')
const next = () => root.querySelector('.onboarding-next')

test('a fresh install opens on the welcome screen', () => {
  const layer = card()
  assert.ok(layer, 'a first run should open the onboarding screen')
  assert.equal(layer.getAttribute('aria-modal'), 'true', 'it is a modal surface, not a toast')
  assert.ok(
    layer.querySelector('img[alt="Quill"]') || /Quill/.test(layer.getAttribute('aria-label') || ''),
    'it should name the app',
  )
  assert.equal(root.querySelector('.onboarding-v2-skip'), null, 'the explicit skip button is gone')
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
  const dark = themes.find((node) => /moon|night|dark/i.test(node.textContent))
  assert.ok(dark, 'a dark theme should be on offer')
  await clickAndSettle(dark)

  const written = settingsCalls.slice(before).filter((call) => call?.value?.theme)
  assert.equal(written.length, 1, 'choosing a look should be saved, not held as a draft')
  assert.equal(dark.getAttribute('aria-checked'), 'true', 'the chosen theme should read as chosen')
})

test('the connectors step adopts a detected tool and the role step saves models', async () => {
  await clickAndSettle(next())

  const connectors = root.querySelector('.onboarding-v2-connectors')
  assert.ok(connectors, 'the connectors step sits between the theme and the model')
  assert.match(connectors.textContent, /Connect your tools/i)
  assert.match(connectors.textContent, /Ollama|opencode|Codex/i, 'detected local tools are listed')
  assert.match(connectors.textContent, /OpenRouter/, 'hosted connectors are listed')
  assert.match(connectors.textContent, /Puter/, 'Puter is listed too')

  const addKey = [...root.querySelectorAll('.onboarding-v2-alt-actions button')]
    .find((node) => /Add an API key/i.test(node.textContent))
  assert.ok(addKey, 'the connectors step offers an API-key path')
  assert.ok(
    [...root.querySelectorAll('.onboarding-v2-connector-actions button')].some(
      (node) => /^Connect$/i.test(node.textContent),
    ),
    'the OpenRouter connector offers its one-click sign-in',
  )
  await clickAndSettle(addKey)
  assert.ok(root.querySelector('#onboarding-api-key'), 'the key is entered in onboarding, not Settings')
  const providerSelect = root.querySelector('#onboarding-provider')
  assert.ok(providerSelect, 'the key form names a provider')
  providerSelect.value = 'preset:openrouter'
  providerSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  await tick(20)
  assert.ok(
    [...root.querySelectorAll('.onboarding-v2-keyform button')].some(
      (node) => /Connect with OpenRouter/i.test(node.textContent),
    ),
    'the OpenRouter connector is offered on the first run too',
  )
  await clickAndSettle(addKey)

  const tools = [...root.querySelectorAll('.onboarding-tool')]
  assert.ok(tools.length >= 1, 'each detected tool is a connector choice')
  assert.match(tools[0].textContent, /Ollama/)
  assert.match(tools[0].textContent, /2 models/, 'the count is what tells a reader it can be used')

  const chosen = tools.find((node) => /Ollama/i.test(node.textContent))
  assert.ok(chosen, 'the detected Ollama server should be offered')
  await clickAndSettle(chosen)
  await clickAndSettle(next())

  const roles = root.querySelector('.onboarding-v2-roles')
  assert.ok(roles, 'the role step follows the model choice')
  assert.ok(root.querySelector('#onboarding-thinking-model'), 'thinking model selector')
  assert.ok(root.querySelector('#onboarding-writing-model'), 'writing model selector')
  const thinking = root.querySelector('#onboarding-thinking-model')
  thinking.value = 'llama3.2:1b'
  thinking.dispatchEvent(new window.Event('change', { bubbles: true }))
  const writing = root.querySelector('#onboarding-writing-model')
  writing.value = 'qwen2:0.5b'
  writing.dispatchEvent(new window.Event('change', { bubbles: true }))
  await tick(20)
  const finish = [...root.querySelectorAll('.onboarding-next')]
    .find((node) => /Finish/i.test(node.textContent))
  assert.ok(finish, 'the role step ends with Finish')
  await clickAndSettle(finish)

  const active = providerFixtures.active()
  assert.equal(active?.id, TOOL.id, 'adopting the server should make it the active provider')
  assert.equal(active?.baseUrl, TOOL.baseUrl, 'the endpoint must be the one that answered')
  assert.deepEqual(active?.models, TOOL.models, 'its real model list travels with the row')
  assert.equal(active?.defaultModel, 'llama3.2:1b', 'the first detected model is adopted until Settings changes it')

  const roleUpdate = calls
    .filter((call) => call.command === 'update_provider')
    .map((call) => call.args?.input)
    .find((input) => input?.thinkingModel === 'llama3.2:1b')
  assert.ok(roleUpdate, 'the thinking and writing models are saved')
  assert.equal(roleUpdate.writingModel, 'qwen2:0.5b')
})

test('finishing records that it happened, so it never opens again', async () => {
  assert.equal(card(), null, 'the card should be gone once a server is adopted')
  assert.equal(
    onboardingFixtures.state.completed,
    'true',
    'the flag is what stops the card covering the workspace on every later launch',
  )
})

test('the library offers a way back to the getting-started tour', async () => {
  const button = [...root.querySelectorAll('.library-main-tools button')]
    .find((node) => /Getting started/i.test(node.textContent))
  assert.ok(button, 'the home screen has a Getting started button')
  await clickAndSettle(button)
  assert.ok(card(), 'pressing it opens the onboarding overlay again')
})
