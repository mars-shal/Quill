/**
 * A thesis run, driven the way a reader drives it.
 *
 * The run stream is the part of this feature no unit test reaches: it arrives as
 * Tauri events across ten minutes, and the panel has to hold one transcript
 * together across them. So this suite goes through the buttons rather than
 * injecting state -- open the card, type the subject, press Start -- and then
 * emits the events a verified run really emitted. A test that injected props
 * would pass with the append path, the subscription and the dedupe all broken.
 *
 * It is deliberately one test walking one lifecycle. The panel is a live
 * component in this harness, so a second test would inherit the first one's run
 * state and assert against a card still showing "Writing" -- which is a
 * statement about the test, not about the app. Run, finish, run again is also
 * the sequence that has to work.
 *
 * Four things are pinned, each a way this could break without ever crashing:
 *
 *  - `seq` dedupe. The stream is resumable, so a replay after `since` repeats
 *    events the transcript already carries; without dedupe a reconnect
 *    duplicates every line.
 *  - terminal teardown. The subscription goes when the run ends. Left behind, it
 *    keeps writing into a conversation nobody is watching.
 *  - `runId` filtering. One run's events must not render into another's.
 *  - a second run. State left over from a finished run must not wedge the card.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  awaitBoot,
  captureConsoleErrors,
  clickAndSettle,
  emit,
  handlers,
  listenerCount,
  mockFramerMotion,
  root,
  settle,
  tick,
  typeAndSettle,
} from './support/dom-harness.mjs'

mockFramerMotion()

const RUN = 'run-under-test'
const RUN_TWO = 'run-two'
const RUN_EVENT = 'quill://run-event'

/** The progress half of a run, in the order a real one emitted it. */
const progress = (runId = RUN) => [
  { runId, seq: 1, event: 'started', t: 0 },
  { runId, seq: 2, event: 'entity', t: 136.6, detail: 'resolving the subject' },
  { runId, seq: 3, event: 'section', t: 396.5, section: 'Introduction', attempt: 0, verdict: 'coherent', words: 229 },
  { runId, seq: 4, event: 'grounding', t: 442.3, section: 'Introduction', claims: 7, corroborated: 3, unverified: 2 },
  { runId, seq: 5, event: 'write_gate', t: 496.1, written: 5, placeholder: 0 },
]

const runLines = () => [...root.querySelectorAll('.chat-message.ai')].map((row) => row.textContent)
const mentions = (re) => runLines().filter((line) => re.test(line)).length

const restoreConsole = captureConsoleErrors()
await import('../src/main.jsx')
await awaitBoot()
restoreConsole()

/**
 * The sidecar, stubbed as one that starts down.
 *
 * `stopped` first so the run has to bring the service up. A test that only ever
 * saw `ready` would pass even if the panel never called `pipelineStart`.
 */
let sidecar = { state: 'stopped', detail: 'the pipeline is not running' }
let nextRunId = RUN
handlers.pipeline_status = () => sidecar
handlers.pipeline_start = () => {
  sidecar = { state: 'ready', detail: 'serving' }
  return sidecar
}
handlers.pipeline_stop = () => sidecar
handlers.api_start_run = () => {
  const runId = nextRunId
  nextRunId = RUN_TWO
  return { runId, status: 'queued', events: `/runs/${runId}/events` }
}
handlers.api_run_status = () => ({
  id: RUN,
  status: 'done',
  prompt: 'a thesis',
  documentId: '',
  conceptMode: 'reference',
  elapsed: 561.1,
  error: '',
  written: 5,
  placeholders: 0,
  sessionName: 'Comparing PIR Sensors',
  eventCount: 6,
})
handlers.api_cancel_run = () => null
handlers.api_stream_run = () => null

/** Open the card if it is closed, type the subject, press Start. */
async function startRun(subject) {
  if (!root.querySelector('.run-card')) await toggleCard()
  const field = root.querySelector('.run-prompt')
  assert.ok(field, 'the run card has a prompt field')
  await typeAndSettle(field, subject)

  const start = [...root.querySelectorAll('.run-actions button')]
    .find((button) => /start writing/i.test(button.textContent))
  assert.ok(start, 'the card offers a start button')
  await clickAndSettle(start)
}

async function toggleCard() {
  const toggle = root.querySelector('.chat-control[aria-label="Write a thesis"]')
  assert.ok(toggle, 'the composer offers the run affordance')
  await clickAndSettle(toggle)
}

const sidecarLabel = () => root.querySelector('.run-state')?.textContent ?? ''

/**
 * Wait for a subscription to appear or go away.
 *
 * The seam imports `@tauri-apps/api/event` lazily, so `listen` resolves a
 * microtask-chain after the click that caused it. Polling is the honest wait:
 * `settle` only knows the DOM stopped moving, which is true while the import is
 * still in flight.
 */
async function waitForListeners(event, want, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = listenerCount(event)
    if (want === 0 ? count === 0 : count > 0) return count
    await tick(25)
  }
  return listenerCount(event)
}

async function emitAll(records) {
  for (const record of records) {
    emit(RUN_EVENT, record)
    await settle()
  }
}

test('a run streams progress, ignores noise, releases its subscription, and the next one still starts', async () => {
  await startRun('a thesis on PIR sensors')

  assert.ok(await waitForListeners(RUN_EVENT, 1), 'the panel subscribed to the run stream')
  await emitAll(progress())

  // Counted on the section line's own shape: the grounding row for the same
  // section also names it, so a bare substring would find two rows by design.
  assert.equal(mentions(/Introduction · coherent/), 1, 'a written section is reported')
  assert.ok(/3\/7/.test(root.textContent), 'grounding reports corroborated of total claims')
  assert.ok(/5 sections written/.test(root.textContent), 'the write gate is reported')

  // `since` means the API replays what the client already has.
  await emitAll(progress())
  assert.equal(mentions(/Introduction · coherent/), 1, 'a replayed event is not printed twice')

  emit(RUN_EVENT, { runId: 'a-different-run', seq: 99, event: 'section', t: 9, section: 'Foreign', verdict: 'coherent' })
  await settle()
  assert.equal(mentions(/Foreign/), 0, "another run's events are filtered out")

  await emitAll([{ runId: RUN, seq: 6, event: 'finished', t: 561 }])
  // Counts, not the document's name: `finished` carries none of its own, so the
  // closing line is the run's snapshot.
  assert.ok(
    runLines().some((line) => /5 written · 0 placeholders · 6 events · 561s/.test(line)),
    'the closing snapshot reports the run counts',
  )
  assert.equal(await waitForListeners(RUN_EVENT, 0), 0, 'the subscription is released when the run ends')

  // Releasing the run stream must not also release the sidecar status. They have
  // different lifetimes: the stream is dead once the run ends, but the card stays
  // on screen and the reader may walk off to Settings and come back. An earlier
  // version of the guard above returned early for the whole effect, which fixed
  // the leak and left the card claiming the service was ready forever.
  sidecar = { state: 'failed', detail: 'the writing service stopped responding' }
  await toggleCard()
  await toggleCard()
  assert.equal(sidecarLabel(), 'Writing service failed', 'the sidecar status refreshes when the card is reopened')

  // A second run is the other half of the reset: a card still wedged on
  // "Writing" after a finished run would strand the reader.
  await startRun('a second thesis')
  assert.ok(await waitForListeners(RUN_EVENT, 1), 'a second run subscribes again')

  await emitAll([{ runId: RUN_TWO, seq: 1, event: 'failed', t: 239, error: 'still failing after 0 attempts' }])
  assert.match(root.textContent, /still failing/, 'a failure shows its reason')
  assert.equal(await waitForListeners(RUN_EVENT, 0), 0, 'a failed run releases its subscription too')
})