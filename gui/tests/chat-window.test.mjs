/**
 * The assistant message window.
 *
 * `messages` is append-only for the life of a conversation and every AI message
 * mounts a `BotAvatar` canvas. `bot-avatars` runs one module-level rAF over every
 * *registered* avatar, so rendering the whole transcript makes the idle cost of
 * the panel proportional to the length of the session -- for messages that are
 * scrolled out of view. The panel now keeps a bounded window mounted and grows it
 * only when the reader asks.
 *
 * The transcript is built the way a session actually builds one -- through the
 * composer -- because a test that injected state would not notice that the append
 * path is what grows the list. The reply is a promise rather than a timer, so one
 * wait at the end covers every message sent above it.
 *
 * It runs in the mocked-motion pass: animation is not what is under test, and 200
 * messages through real framer-motion would dominate the suite. The motion mock
 * is the shared one from the harness, so `.send-button` and friends exist here
 * with their real props.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertGone,
  awaitBoot,
  captureConsoleErrors,
  consoleErrors,
  dom,
  handlers,
  mockFramerMotion,
  providerFixtures,
  root,
  clickAndSettle,
  tick,
  typeInto,
} from './support/dom-harness.mjs'

mockFramerMotion()

const restoreConsole = captureConsoleErrors()

/**
 * The assistant's transport, stubbed the way the database and the sidecar are.
 *
 * The reply text is not this suite's subject -- the window bound and the ordering
 * are -- but the reply has to be a real AI turn. With no transport stub the store
 * answers `api_chat` with its "needs the desktop app" refusal, and every
 * assertion below about AI turns would be measuring that refusal instead of an
 * answer. `chatCalls` is exported to the two tests at the end that check which
 * way the question travelled.
 */
const chatCalls = []
handlers.api_chat = (args) => {
  chatCalls.push(args)
  return {
    reply: `answer ${chatCalls.length}`,
    transport: 'sidecar',
    task: 'EXPLAIN',
    sources: [{ title: `Source ${chatCalls.length}`, url: `https://example.test/${chatCalls.length}` }],
  }
}

// The panel now asks the streaming command, which reports stages while the turn
// runs and returns the same reply. Delegating rather than copying matters: the
// tests below swap `api_chat` for a refusing or a grounded handler, and a copy
// would leave those overrides applying to a command nothing calls any more.
handlers.api_chat_stream = (args) => handlers.api_chat(args)

// The interview is a separate route on purpose: it must not write, research or
// answer. This stub keeps that distinction visible in the test.
handlers.api_questionnaire = () => ({
  questions: [{
    header: 'Audience',
    question: 'Who is reading the notes?',
    multiSelect: false,
    options: [
      { label: 'Engineering', description: 'The delivery team' },
      { label: 'Leadership', description: 'Decision makers' },
    ],
  }],
})

await import('../src/main.jsx')
await awaitBoot()
restoreConsole()

/**
 * The cap, read from the source and pinned.
 *
 * Both halves matter. Reading it means the assertions below cannot pass by
 * comparing the app against itself, and pinning it to 40 means raising the cap --
 * the exact change that reintroduces the unbounded cost -- fails here instead of
 * being a silent regression.
 */
const PINNED_WINDOW = 40
// The window moved to `library/ChatPanel.jsx` with the panel that is the only
// thing reading it. Read it from there: the assertion is about the number, not
// about which file holds it.
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'library', 'ChatPanel.jsx'),
  'utf8',
)
const declared = source.match(/const MESSAGE_WINDOW = (\d+)/)
assert.ok(declared, 'expected a MESSAGE_WINDOW constant in library/ChatPanel.jsx')
assert.equal(
  Number(declared[1]),
  PINNED_WINDOW,
  `MESSAGE_WINDOW changed to ${declared[1]}; re-check the cost of a long session before raising it`,
)
const MESSAGE_WINDOW = PINNED_WINDOW

test('the transcript is keyed by document', () => {
  // One window-wide transcript meant a conversation about one draft was still
  // on screen when another was opened. Persistence now names the document.
  assert.match(source, /const transcriptKey = \(documentId\) =>/, 'ChatPanel derives a key from the document')
  assert.match(source, /localStorage\.getItem\(key\)/, 'the restore reads that key')
  assert.match(source, /localStorage\.setItem\(key,/, 'and the save writes it')
  assert.match(source, /function ChatPanel\(\{ documentId,/, 'the panel takes the document it belongs to')

  const editor = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'library', 'Editor.jsx'),
    'utf8',
  )
  assert.match(editor, /<ChatPanel key=\{doc\.id\} documentId=\{doc\.id\}/, 'the editor passes and pins the document')
})

const SENDS = 200
const EXPECTED_MESSAGES = 1 + SENDS * 2

const { window } = dom
const composer = () => root.querySelector('.chat-box textarea')
const sendButton = () => root.querySelector('.send-button')
const mountedMessages = () => root.querySelectorAll('.chat-message')
const mountedAvatars = () => root.querySelectorAll('.message-avatar')
const showEarlier = () => root.querySelector('.show-earlier')

/**
 * One macrotask, not `settle`.
 *
 * `settle` polls the markup until it stops changing, which is the right call for
 * a handful of interactions and the wrong one here: 400 of them would spend most
 * of their time sleeping between polls. With the motion mock the render is
 * synchronous, so a single task is enough -- and if it ever stops being enough,
 * the assertions below fail rather than quietly testing the previous state.
 */
const flush = () => tick(20)

const click = async (node) => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
}

/** Sends one message the way a reader would: type it, then press send. */
const send = async (text) => {
  typeInto(composer(), text)
  await flush()
  const button = sendButton()
  assert.equal(button.disabled, false, `the send button stayed disabled after typing ${JSON.stringify(text)}`)
  await click(button)
}

/** Sends a whole session, then waits once for every pending reply. */
const sendMany = async (count) => {
  for (let index = 0; index < count; index += 1) await send(`question ${index}`)
  // Every reply is already in flight. One wait covers all of them instead of one
  // wait per message.
  await tick(1400)
  await flush()
}

test('a long session keeps the mounted transcript and canvases bounded', async () => {
  assert.ok(
    EXPECTED_MESSAGES > 300,
    `this test is only meaningful with several hundred messages, built ${EXPECTED_MESSAGES}`,
  )
  // The canvases are only mounted on the editor screen, and the app starts on the
  // library. Without this the avatar assertion below would pass vacuously.
  const tile = root.querySelector('.document-tile:not(.new-document-tile)')
  assert.ok(tile, 'the library should offer a document to open')
  await click(tile)
  assert.equal(root.querySelector('.app-shell').dataset.view, 'editor', 'the editor is the visible view')

  await sendMany(SENDS)

  const mounted = mountedMessages().length
  assert.ok(
    mounted <= MESSAGE_WINDOW,
    `mounted ${mounted} messages, the window is ${MESSAGE_WINDOW}: the cap is not holding`,
  )
  // The canvas count is the point of the cap: one per AI message, every one of
  // them registered with the module-level rAF.
  const avatars = mountedAvatars().length
  assert.ok(avatars <= MESSAGE_WINDOW, `mounted ${avatars} avatar canvases, window is ${MESSAGE_WINDOW}`)
  assert.ok(avatars > 0, 'the visible window should still have avatars')

  // The conversation is genuinely long, or the assertion above is vacuous.
  const total = messagesInState()
  assert.equal(total, EXPECTED_MESSAGES, `the session holds ${total} messages, expected ${EXPECTED_MESSAGES}`)

  const keyWarnings = consoleErrors.filter((line) => /same key|Encountered two children/i.test(line))
  assert.deepEqual(keyWarnings, [], `duplicate React keys:\n${keyWarnings.join('\n---\n')}`)
})

/**
 * The length of the conversation, read from the panel rather than from state.
 *
 * `messages` is component state with no window onto it, so the only honest
 * measure of how long the session is what the reader can reach: the window plus
 * what the "show earlier" control is holding back.
 */
function messagesInState() {
  const control = showEarlier()
  if (!control) return mountedMessages().length
  const hidden = Number(control.textContent.match(/Show (\d+) earlier/)?.[1] ?? 0)
  return mountedMessages().length + hidden
}

test('older messages are reachable instead of silently dropped', async () => {
  assert.ok(showEarlier(), 'there must be a control for the messages outside the window')
  assert.match(showEarlier().textContent, /earlier message/, `unhelpful label: ${showEarlier().textContent}`)

  const before = mountedMessages().length
  await click(showEarlier())
  assert.ok(mountedMessages().length > before, 'expanding the window must mount more of the conversation')
  assert.ok(
    mountedMessages().length <= before + MESSAGE_WINDOW,
    'the window grows by a page at a time',
  )
})

test('expanding repeatedly reaches the start of the conversation', async () => {
  // "Scrolling back still works", in a DOM that computes no layout: the first
  // message of the session has to end up mounted.
  let pages = 0
  while (showEarlier() && pages < 20) {
    await click(showEarlier())
    pages += 1
  }
  assertGone('.show-earlier', 'nothing should be left outside the window')
  assert.equal(
    mountedMessages().length,
    EXPECTED_MESSAGES,
    `the whole conversation should be reachable, mounted ${mountedMessages().length}`,
  )

  // The window grew monotonically, so the transcript is still in order and still
  // starts where it started.
  const bodies = [...root.querySelectorAll('.message-body')].map((node) => node.textContent)
  assert.match(bodies[0], /second pair of eyes/, `the first message should be the welcome: ${bodies[0]}`)
  assert.equal(bodies[1], 'question 0', 'the second message should be the first question')
  // Each reply sits after the question it answers, so a follow-up typed while the
  // previous reply was pending does not push the answer below itself.
  for (let index = 0; index < SENDS; index += 1) {
    const at = 1 + index * 2
    assert.equal(bodies[at], `question ${index}`, `message ${at} should be question ${index}`)
    assert.notEqual(bodies[at + 1], `question ${index}`, `the reply to question ${index} should follow it`)
  }
  // Asserted on the roles rather than the reply text: the canned reply for an
  // unrecognised question is not this test's subject and is free to change.
  assert.match(
    bodies.at(-1),
    /\S/,
    'the last message should be the reply to the final question',
  )
  const lastIsAi = [...root.querySelectorAll('.chat-message')].at(-1).classList.contains('ai')
  assert.ok(lastIsAi, 'the transcript should end on an AI reply')
})

test('a question travels to the assistant transport, not a local stub', async () => {
  const before = chatCalls.length
  await send('what should I cut?')
  await tick(60)

  assert.equal(chatCalls.length, before + 1, 'the question should have reached the transport')
  const { messages } = chatCalls.at(-1)
  assert.ok(Array.isArray(messages) && messages.length > 0, 'the transcript should travel with the question')
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, 'what should I cut?')
  // The greeting belongs to this panel. Sent back as an assistant turn it makes
  // the model continue the greeting rather than answer the question.
  assert.equal(
    messages.some((message) => /second pair of eyes/.test(message.content)),
    false,
    'the welcome line must not be sent as context',
  )

  const last = [...root.querySelectorAll('.chat-message')].at(-1)
  assert.ok(last.classList.contains('ai'), `the reply should be an AI turn, got ${last.className}`)
  assert.match(last.textContent, /answer \d+/, 'the transport reply should be what is shown')
})

test('the chat panel reads its model from the registry, not the settings blob', () => {
  assert.equal(
    /settings\?\.model/.test(source),
    false,
    'settings.model was retired with the flat provider triple; reading it shows a stale or invented value',
  )
  assert.equal(
    source.includes('GPT-5.2'),
    false,
    'a hardcoded model name is vendor-specific and out of date',
  )
  assert.match(
    source,
    /activeProvider\?\.defaultModel/,
    'the picker must take the model from the active provider row',
  )
})

test('the chat picker opens a listbox naming the active provider’s model', async () => {
  const active = providerFixtures.active()
  assert.ok(active?.defaultModel, 'the seeded provider must carry a default model')

  const trigger = root.querySelector('.model-trigger')
  assert.ok(trigger, 'the model picker should sit in the assistant head')
  // A listbox, not a native select: the reference designs want card rows with
  // a badge and a selection dot, and this test pins the contract that replaced
  // what the native control gave for free.
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox', 'the trigger announces the popup')
  assert.ok(
    trigger.textContent.includes(active.defaultModel),
    'the trigger should name the active provider’s default model',
  )
  assert.equal(root.querySelector('.model-popover'), null, 'the listbox stays closed until asked for')

  assert.equal(
    /GPT-5\.2/.test(root.textContent),
    false,
    'a vendor default must not appear while a real provider is connected',
  )

  // The seeded row lists only its own default, so the choice is the same value.
  // What is under test is the path the choice takes: the registry, not settings.
  const settingsCalls = []
  const providerCalls = []
  const workingSettings = handlers.set_settings
  const workingProvider = handlers.update_provider
  handlers.set_settings = (args) => { settingsCalls.push(args); return workingSettings(args) }
  handlers.update_provider = (args) => { providerCalls.push(args); return workingProvider(args) }
  try {
    await clickAndSettle(trigger)
    const listbox = root.querySelector('.model-popover')
    assert.ok(listbox, 'the click should open the listbox')
    assert.equal(listbox.getAttribute('role'), 'listbox', 'the popover carries the listbox role')

    const options = [...listbox.querySelectorAll('[role="option"]')]
    const modelRows = options
      .map((option) => option.querySelector('.model-option-name')?.textContent || '')
      .filter((name) => name && !name.startsWith('Connect') && !name.startsWith('Retry'))
    assert.deepEqual(
      modelRows,
      [active.defaultModel],
      'the list should offer the active provider’s models and nothing else',
    )

    const chosen = options.find(
      (option) => option.querySelector('.model-option-name')?.textContent === active.defaultModel,
    )
    assert.ok(chosen, 'the current model should be one of the rows')
    assert.equal(chosen.getAttribute('aria-selected'), 'true', 'and marked as selected')
    await clickAndSettle(chosen)
  } finally {
    handlers.set_settings = workingSettings
    handlers.update_provider = workingProvider
  }

  assert.equal(root.querySelector('.model-popover'), null, 'choosing closes the listbox')
  assert.equal(providerCalls.length, 1, 'the choice must be written to the provider row')
  assert.deepEqual(
    providerCalls[0],
    { input: { id: active.id, defaultModel: active.defaultModel } },
    'the registry must receive the model as the provider’s default',
  )
  assert.equal(
    settingsCalls.some((call) => call && call.model !== undefined),
    false,
    'the retired settings.model field must not be written',
  )
})

test('a question the transport refuses is reported, not answered anyway', async () => {
  const working = handlers.api_chat
  handlers.api_chat = () => {
    throw new Error('the provider refused the key')
  }
  try {
    await send('are you there?')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.ok(
      last.classList.contains('error'),
      `a refused question must not render as an answer: ${last.className}`,
    )
    assert.match(last.textContent, /could not answer/, 'the reader should be told plainly')
    assert.match(last.textContent, /refused the key/, 'and told why')
  } finally {
    handlers.api_chat = working
  }
})

test('an answer grounded in sources shows them, collapsed', async () => {
  const working = handlers.api_chat
  handlers.api_chat = () => ({
    reply: 'Because the evidence says so.',
    transport: 'sidecar',
    task: 'EXPLAIN',
    sources: [
      { title: 'Ada Lovelace', url: 'https://example.test/ada' },
      { title: 'Charles Babbage', url: 'https://example.test/babbage' },
    ],
  })
  try {
    await send('why?')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    const sources = last.querySelector('.message-sources')
    assert.ok(sources, 'a grounded answer must surface what it rested on')
    assert.equal(sources.open, false, 'sources start collapsed, so the answer leads')
    assert.match(sources.querySelector('summary').textContent, /2 sources/)
    const links = [...sources.querySelectorAll('a')]
    assert.equal(links.length, 2, 'every source must be listed')
    assert.equal(links[0].href, 'https://example.test/ada', 'the link must point at the source')
    assert.match(
      last.querySelector('.message-status').textContent,
      /explain turn/i,
      'the answer must name the kind of turn that produced it',
    )
  } finally {
    handlers.api_chat = working
  }
})

test('a direct answer with no sources shows none', async () => {
  const working = handlers.api_chat
  handlers.api_chat = () => ({ reply: 'pong', transport: 'direct', task: '', sources: [] })
  try {
    await send('ping')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.equal(
      last.querySelector('.message-sources'),
      null,
      'an ungrounded answer must not imply it had sources',
    )
    assert.match(
      last.querySelector('.message-status').textContent,
      /directly by the provider/i,
      'an unclassified reply must not claim a task type',
    )
  } finally {
    handlers.api_chat = working
  }
})

test('a WRITE turn lands in the document, and the bubble says so', async () => {
  // The editor has to be the visible view: the append has nowhere to land on the
  // library, so without this the whole test would pass against a document that
  // was never mounted.
  const tile = root.querySelector('.document-tile:not(.new-document-tile)')
  await click(tile)
  assert.equal(root.querySelector('.app-shell').dataset.view, 'editor', 'the editor is the visible view')

  const article = root.querySelector('.editor-surface .ProseMirror')
  assert.ok(article, 'the editor must be mounted before the append is meaningful')
  assert.equal(
    article.textContent.includes('Verstappen'),
    false,
    'the fixture must not already contain the text the turn produces',
  )

  const working = handlers.api_chat
  handlers.api_chat = () => ({
    reply: '## Max Verstappen\n\nThe Dutch driver won his first title in 2021.',
    transport: 'sidecar',
    task: 'WRITE',
    sources: [],
  })
  try {
    await send('write about Max Verstappen')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.ok(last.classList.contains('is-written'), 'the bubble must mark the document write')
    assert.match(last.textContent, /written to the document/i)
    assert.equal(
      last.textContent.includes('won his first title'),
      false,
      'the bubble must not restate the document it just wrote',
    )

    const after = root.querySelector('.editor-surface .ProseMirror')
    assert.match(after.textContent, /Max Verstappen/, 'the produced document must reach the editor')
    assert.ok(
      after.querySelector('h2'),
      'the markdown heading must arrive as a heading node, not literal text',
    )
  } finally {
    handlers.api_chat = working
  }
})

test('a REWRITE turn lands in the document too', async () => {
  const tile = root.querySelector('.document-tile:not(.new-document-tile)')
  await click(tile)
  const article = root.querySelector('.editor-surface .ProseMirror')
  assert.ok(article, 'the editor is mounted')

  const working = handlers.api_chat
  handlers.api_chat = () => ({
    reply: '## Lando Norris\n\nThe British driver joined McLaren in 2019.',
    transport: 'sidecar',
    task: 'REWRITE',
    sources: [],
  })
  try {
    await send('rewrite this about Lando Norris')
    await tick(80)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.ok(last.classList.contains('is-written'), 'the rewrite is marked as a document write')
    assert.match(last.textContent, /written to the document/i)
    assert.match(
      root.querySelector('.editor-surface .ProseMirror').textContent,
      /Lando Norris/,
      'a rewrite is the draft after the instruction, not a chat-only answer',
    )
  } finally {
    handlers.api_chat = working
  }
})

test('a blocked WRITE keeps its notice in the bubble and leaves the document alone', async () => {
  const tile = root.querySelector('.document-tile:not(.new-document-tile)')
  await click(tile)
  const before = root.querySelector('.editor-surface .ProseMirror').textContent

  const working = handlers.api_chat
  handlers.api_chat = () => ({
    reply: '# Generation Halted — Insufficient Research Evidence\n\n> THIS RUN PRODUCED NO CONTENT.',
    transport: 'sidecar',
    task: 'WRITE',
    sources: [],
    wroteDocument: false,
  })
  try {
    await send('write about the Fall of Rome')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.equal(last.classList.contains('is-written'), false, 'nothing was written, so nothing is marked written')
    assert.match(last.textContent, /Generation Halted/, 'the reader must still be told why the turn produced nothing')

    const after = root.querySelector('.editor-surface .ProseMirror').textContent
    assert.equal(after, before, 'a halted write must not replace the draft with a warning')
  } finally {
    handlers.api_chat = working
  }
})

test('a non-writing turn leaves the document untouched', async () => {
  const tile = root.querySelector('.document-tile:not(.new-document-tile)')
  await click(tile)
  const before = root.querySelector('.editor-surface .ProseMirror').textContent

  const working = handlers.api_chat
  handlers.api_chat = () => ({
    reply: 'Ada Lovelace wrote the first algorithm.',
    transport: 'sidecar',
    task: 'EXPLAIN',
    sources: [],
  })
  try {
    await send('who was ada lovelace?')
    await tick(60)

    const last = [...root.querySelectorAll('.chat-message')].at(-1)
    assert.equal(last.classList.contains('is-written'), false, 'an EXPLAIN turn writes nothing')
    const after = root.querySelector('.editor-surface .ProseMirror').textContent
    assert.equal(after, before, 'only a WRITE turn may change the document')
    assert.equal(
      after.includes('Ada Lovelace wrote the first algorithm.'),
      false,
      'the answer must not have been inserted into the document',
    )
  } finally {
    handlers.api_chat = working
  }
})

test('a conversation belongs to one document, not the window', async () => {
  // The reader may keep several drafts open over a day. A question about one
  // must not follow them into another, which is what the single global
  // transcript did.
  const title = root.querySelector('.breadcrumb-title .document-title-button')?.textContent
  assert.ok(title, 'a document is open before switching')
  assert.ok(composer(), 'the assistant is mounted in the editor')

  await send('what is missing from this draft?')
  await tick(400)
  assert.match(
    root.querySelector('.chat-scroll').textContent,
    /what is missing from this draft\?/,
    'the question lands in the transcript of the open document',
  )

  await click(root.querySelector('[aria-label="Back to library"]'))
  await tick(400)

  const tiles = [...root.querySelectorAll('.document-tile:not(.new-document-tile)')]
  const other = tiles.find((tile) => tile.querySelector('.tile-copy strong')?.textContent !== title)
  assert.ok(other, 'the library offers a second document to switch to')
  await click(other)
  await tick(500)

  const transcript = root.querySelector('.chat-scroll')?.textContent || ''
  assert.doesNotMatch(transcript, /what is missing from this draft\?/, 'another document has its own conversation')
  assert.match(transcript, /second pair of eyes/, 'and opens on its own welcome message')
})

/** Picks a file on the composer's hidden input, the way the dialog does. */
const pickFile = async (name, contents, type = 'text/markdown') => {
  const input = root.querySelector('.chat-box input[type="file"]')
  assert.ok(input, 'the composer offers a file input')
  const file = new window.File([contents], name, { type })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new window.Event('change', { bubbles: true }))
  await tick(80)
}

test('an attached text file travels to the provider, not just its name', async () => {
  const before = chatCalls.length
  await pickFile('notes.md', 'The lighthouse keeper kept two journals.')

  const chip = root.querySelector('.attachment-chip')
  assert.ok(chip, 'the picked file gets a chip above the composer')
  assert.match(chip.textContent, /notes\.md/)
  assert.equal(chip.classList.contains('is-error'), false, 'a readable file is not an error')

  await send('summarise this')
  await tick(120)

  assert.equal(chatCalls.length, before + 1, 'the turn still reaches the transport')
  const { messages } = chatCalls.at(-1)
  assert.match(
    messages.at(-1).content,
    /The lighthouse keeper kept two journals\./,
    'the file contents are part of the prompt the model reads',
  )
  assert.match(messages.at(-1).content, /Attached file: notes\.md/, 'the prompt names the file')

  const userTurn = [...root.querySelectorAll('.chat-message.user')].at(-1)
  assert.match(userTurn.textContent, /Attached: notes\.md/, 'the reader sees the attachment named')
  assert.doesNotMatch(
    userTurn.textContent,
    /lighthouse keeper/,
    'the 12k-character body stays out of the visible bubble',
  )
})

test('an unreadable file is shown with its reason instead of being sent', async () => {
  await pickFile('scan.png', 'not really a png', 'image/png')

  const chip = root.querySelector('.attachment-chip')
  assert.ok(chip, 'the rejected pick still has a chip')
  assert.equal(chip.classList.contains('is-error'), true, 'the chip reports the rejection')
  assert.match(chip.textContent, /scan\.png/)
  assert.match(chip.textContent, /text files/i, 'the reason says what can be read')
  assert.equal(sendButton().disabled, true, 'an unreadable attachment cannot be sent on its own')

  const dismiss = chip.querySelector('button')
  await click(dismiss)
  assert.equal(root.querySelector('.attachment-chip'), null, 'dismissing clears it')
})


test('interview asks a questionnaire, then sends the answers with the turn', async () => {
  const before = chatCalls.length
  const toggle = root.querySelector('[aria-label="Ask clarifying questions"]')
  assert.ok(toggle, 'the assistant header offers a clarifier')
  await click(toggle)

  await send('draft the tailwind meeting notes')
  await tick(160)
  assert.equal(chatCalls.length, before, 'the interview does not start a chat turn')
  const option = root.querySelector('.questionnaire-option')
  assert.ok(option, 'the reply renders answer options')
  await click(option)
  await tick(320)

  assert.equal(chatCalls.length, before + 1, 'the next turn reaches the chat transport')
  const { messages } = chatCalls.at(-1)
  assert.match(messages.at(-1).content, /Interview answers:/)
  assert.match(messages.at(-1).content, /Audience: Engineering/)
  assert.equal(
    root.querySelector('[aria-label="Ask clarifying questions"]').getAttribute('aria-pressed'),
    'false',
    'the clarifier is one-shot',
  )
})

test('the composer marks send ready and enables it when text is present', async () => {
  const box = root.querySelector('.chat-box')
  const button = root.querySelector('.send-button')
  const field = root.querySelector('.chat-box textarea')
  assert.ok(box && button && field, 'the composer rendered')
  assert.equal(box.hasAttribute('data-ready'), false, 'an empty composer is not ready')
  assert.equal(button.disabled, true, 'the send button starts disabled')

  await typeInto(field, 'a short question')
  await tick(30)
  assert.equal(box.hasAttribute('data-ready'), true, 'typing marks the composer ready')
  assert.equal(button.disabled, false, 'typing enables the send button')

  await typeInto(field, '')
  await tick(30)
  assert.equal(box.hasAttribute('data-ready'), false, 'clearing the field clears ready')
  assert.equal(button.disabled, true, 'clearing the field disables send again')
})

test('the send button becomes a stop control while a turn is running', async () => {
  const working = handlers.api_chat
  handlers.api_chat = () => new Promise((resolve) => {
    window.setTimeout(() => resolve({
      reply: 'late answer',
      transport: 'sidecar',
      task: 'EXPLAIN',
      sources: [],
    }), 180)
  })
  try {
    await send('explain this draft')
    await tick(30)
    const stop = root.querySelector('.send-button')
    assert.equal(stop.getAttribute('aria-label'), 'Stop the assistant', 'working turns offer a stop control')
    await click(stop)
    await tick(30)
    assert.equal(root.querySelector('.send-button').getAttribute('aria-label'), 'Send message', 'stopping returns the send control')
    await tick(260)
  } finally {
    handlers.api_chat = working
  }
})
