/**
 * Does the System panel tell the truth about this installation?
 *
 * Quill ships three pieces that a reader can end up with in different states: the
 * app, the Python pipeline and a search backend. The failure this panel exists to
 * prevent is the one that already happened in the wild -- a sidecar that was not
 * running, reported as a generic failure, with nothing on screen saying which of
 * the three pieces was missing.
 *
 * The harness stubs both commands with a healthy machine. That makes the test a
 * contract for the wiring rather than for the network: if the panel asks the
 * wrong command, or renders "Running" from a hard-coded string instead of the
 * report, the assertions below stop agreeing with the fixture.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { awaitBoot, clickAndSettle, root } from './support/dom-harness.mjs'

await import('../src/main.jsx')
await awaitBoot()

const openSystemPanel = async () => {
  const settings = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(settings, 'the library sidebar has a Settings button')
  if (!root.querySelector('.settings-page')) await clickAndSettle(settings)

  const tab = [...root.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent.trim() === 'System',
  )
  assert.ok(tab, 'the System tab is in the strip')
  await clickAndSettle(tab)

  const panel = root.querySelector('#settings-system')
  assert.ok(panel, 'the System panel exists')
  assert.equal(panel.hidden, false, 'choosing the tab shows the panel')
  return panel
}

test('the System panel reports the services this install can use', async () => {
  const panel = await openSystemPanel()
  const text = panel.textContent

  assert.match(text, /Writing service/, 'the pipeline is named')
  assert.match(text, /Running/, 'the stubbed pipeline is reported as running')
  assert.match(text, /Research search/, 'the search backend is named')
  assert.match(text, /SearXNG/, 'an answering SearXNG is reported as the backend')
  assert.match(text, /Generation ledger/, 'the ledger is named')
  assert.match(text, /Local only/, 'telemetry without Convex is local only')
  assert.match(text, /this computer/i, 'the report says it is machine-local')
})

test('the panel offers a restart and a re-check, not just a status', async () => {
  const panel = await openSystemPanel()
  const buttons = [...panel.querySelectorAll('button')].map((node) => node.textContent.trim())

  assert.ok(buttons.includes('Restart'), 'a dead sidecar can be restarted from here')
  assert.ok(buttons.includes('Check again'), 'search can be re-probed without restarting the app')
})
