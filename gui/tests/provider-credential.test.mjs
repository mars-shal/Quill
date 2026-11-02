/**
 * The assistant panel talks about the registry, and files the key by id.
 *
 * This is a regression suite with a body count. The panel used to write the key
 * to `provider:<the name the reader picked off a menu>` -- 'OpenAI' -- while
 * every run read `provider:<the id of the active provider row>`. So the key
 * saved, the row said "Key ready", and the request authenticated as the string
 * `sk-from-env` that the Rust test suite had left in the live credential slot.
 * The assertions below are the two halves of that: what the panel claims it is
 * talking to, and what id the core is actually handed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { calls, clickAndSettle, root, settle, tick, typeAndSettle } from './support/dom-harness.mjs'

// main.jsx mounts itself into #root on import.
await import('../src/main.jsx')
await tick(300)

const openSettings = async () => {
  const button = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(button, 'the library sidebar has a Settings button')
  if (!root.querySelector('.settings-page')) await clickAndSettle(button)
  await settle()
  assert.ok(root.querySelector('.settings-page'), 'the settings page opened')
}

const panelButton = (label) =>
  [...root.querySelectorAll('.settings-page button')].find(
    (node) => node.textContent.trim() === label,
  )

test('the panel describes the registry provider rather than a menu of names', async () => {
  await openSettings()

  const trigger = root.querySelector('.settings-form #provider')
  assert.ok(trigger, 'the provider control rendered')
  assert.match(
    trigger.textContent,
    /api\.groq\.com/,
    'it names the provider row in the registry, because that is the one a run will use',
  )

  // The model is a selector now, not a read-only input, so the claim is what
  // the control states rather than an input's value. Both halves are asserted:
  // there is nothing to choose from yet here (the harness has no endpoint), so
  // the trigger's own label is the provider's stored model.
  const modelControl = root.querySelector('.settings-form #model')
  assert.ok(modelControl, 'the model control rendered')
  assert.match(
    modelControl.textContent,
    /openai\/gpt-oss-20b/,
    'the model shown is the provider row value the core will send',
  )
  assert.equal(
    root.querySelector('.settings-form #endpoint').value,
    'https://api.groq.com/openai/v1',
    'and so is the endpoint',
  )

  const page = root.querySelector('.settings-page').textContent
  for (const phantom of ['Anthropic', 'Google', 'Custom endpoint']) {
    assert.doesNotMatch(
      page,
      new RegExp(phantom),
      `"${phantom}" was a slot no request ever read, so the panel must not offer it`,
    )
  }
  assert.doesNotMatch(
    page,
    /does not save the key/,
    'and the note no longer claims the key is not stored',
  )
})

test('connecting files the key under the active provider id, and removing forgets it', async () => {
  await openSettings()

  const key = root.querySelector('.settings-form #api-key')
  assert.ok(key, 'the key field rendered')
  await typeAndSettle(key, 'gsk-typed-by-the-reader')

  const connect = panelButton('Connect provider')
  assert.ok(connect, 'the connect button rendered')
  assert.equal(connect.disabled, false, 'it is live once a provider is selected')

  await clickAndSettle(connect)
  await tick(200)

  const stored = calls.find((call) => call.command === 'set_provider_secret')
  assert.ok(stored, 'connecting wrote a credential')
  assert.equal(
    stored.args.provider,
    'compatible',
    'the core is handed the registry id it reads the key back by, not a display name',
  )
  assert.equal(stored.args.secret, 'gsk-typed-by-the-reader')

  const status = calls.find((call) => call.command === 'get_provider_secret_status')
  assert.equal(status.args.provider, 'compatible', 'and the status is asked of the same row')

  const remove = panelButton('Remove key')
  assert.ok(remove, 'the remove button rendered')
  assert.equal(remove.disabled, false, 'and is offered once a key is stored')

  await clickAndSettle(remove)
  await tick(200)

  const removed = calls.find((call) => call.command === 'delete_provider_secret')
  assert.ok(removed, 'removing called delete')
  assert.equal(
    removed.args.provider,
    'compatible',
    'the same id, so the environment can take the provider back',
  )
})
