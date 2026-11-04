/**
 * Does clicking a settings tab actually switch which panel is visible?
 *
 * Every other settings suite in this repo passes either way, which is the whole
 * reason this file exists. The three panels stay *mounted* and are hidden with
 * the `hidden` attribute rather than being unmounted, so a control inside
 * Appearance or Writing is in the DOM while a different panel is on screen.
 * `querySelector` finds it regardless, `aria-controls` resolves, `.contains()`
 * is true -- so a test that reaches a control without first switching to its
 * panel proves nothing about switching. Every existing test that touches a
 * panel-level control either gets lucky with whichever tab is active or walks
 * through the tab bar and then only asserts on what is *inside* the panel,
 * never on whether the panel is the one on screen.
 *
 * So the assertions here are deliberately about the switch itself, and about
 * the two pieces of state that a broken switch would leave stale:
 *
 *   - `aria-selected` on the three tabs
 *   - the `hidden` property on the three `role="tabpanel"` sections
 *
 * Why the attribute and not computed style: jsdom loads no stylesheet, so
 * `getComputedStyle` returns defaults for everything and every panel looks
 * `display: block` whether or not it is hidden. A `getComputedStyle` assertion
 * here would be green by construction and would not survive a real browser
 * check -- do not "fix" this file by switching to it. The `hidden` attribute is
 * the contract the markup actually publishes, and it is what
 * `.settings-section[hidden] { display: none }` keys off in the app.
 *
 * Roles rather than class names, for the reason the rest of the suites give:
 * the role is the contract, and a test that went through `.settings-tab` would
 * keep passing if the semantics were dropped. The panels are reached through
 * the clicked tab's own `aria-controls`, so a tab that points at the wrong
 * panel fails here instead of quietly finding some other section.
 *
 * This is a diagnostic, not a fix. If it fails, the fault is in the wiring and
 * the assertion message names the tab and the state it should have had.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./tests/setup.mjs \
 *        --test tests/settings-tabs.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertGone,
  awaitBoot,
  dom,
  root,
  settle,
  themeFixtures,
  mockFramerMotion,
} from './support/dom-harness.mjs'

mockFramerMotion()

// Seeded before the import, because `App` loads the theme list during bootstrap.
// The Appearance panel has a picker in it, and this file mounts the real page
// with all three panels rendered; the list is not what is under test, but an
// empty one should not be the thing that changes first.
themeFixtures.reset([
  { theme_id: 'midnight', name: 'Midnight', mode: 'dark', tokens: { '--main': '#0b1020', '--text-1': '#e6ecff' } },
])

await import('../src/main.jsx')
await awaitBoot()

const { window } = dom

/**
 * The three sections, in the order the tab bar renders them.
 *
 * `id`/`label` pairs rather than selectors, so every assertion below can name
 * the section it is talking about. The ids are also what the tabs' `aria-controls`
 * points at, which is what `panelFor` resolves through.
 */
const SECTIONS = [
  { id: 'settings-assistant', label: 'Assistant' },
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-writing', label: 'Writing' },
]

const click = async (node) => {
  node.focus()
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
}

const openSettings = async () => {
  // The library sidebar's Settings button, which is the entry point in the app.
  const button = root.querySelector('.library-sidebar .sidebar-settings')
  assert.ok(button, 'the library sidebar has a Settings button')
  await click(button)
  assert.ok(root.querySelector('.settings-page'), 'the settings page opened')
}

const closeSettings = async () => {
  // Escape, dispatched on `document` where the page's global keydown listener
  // lives, matching what the other settings suites do.
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
  await settle()
  assertGone('.settings-page', 'Escape closed the settings page')
}

/** The tab strip itself, by role. */
const tablist = () => {
  const strip = root.querySelector('[role="tablist"]')
  assert.ok(strip, 'the settings page has a tablist')
  return strip
}

/** The three tabs, by role and visible text. */
const tabNamed = (label) => {
  const tab = [...tablist().querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent.trim() === label,
  )
  assert.ok(
    tab,
    `a settings tab reading ${label}, got ${[...tablist().querySelectorAll('[role="tab"]')]
      .map((node) => node.textContent.trim())
      .join(' | ')}`,
  )
  return tab
}

/**
 * The panel a tab controls.
 *
 * Resolved through the tab's own `aria-controls` rather than through an id
 * written out here, so a tab pointing at nothing -- or at the wrong section --
 * is a failure here instead of a lookup that quietly returns null.
 */
const panelFor = (tab) => {
  const id = tab.getAttribute('aria-controls')
  assert.ok(id, `the ${tab.textContent.trim()} tab names a panel with aria-controls`)
  const panel = root.querySelector(`[role="tabpanel"]#${id}`)
  assert.ok(panel, `the panel ${id} the ${tab.textContent.trim()} tab controls is in the page`)
  assert.equal(
    panel.getAttribute('aria-labelledby'),
    tab.id,
    `${id} points back at the tab that controls it`,
  )
  return panel
}

const selectedLabel = () => {
  const selected = [...tablist().querySelectorAll('[role="tab"]')].filter(
    (node) => node.getAttribute('aria-selected') === 'true',
  )
  return selected.map((node) => node.textContent.trim())
}

/**
 * Puts `target` into a known *inactive* state, so the click under test is a
 * real change rather than a re-selection that passes without moving anything.
 */
const makeInactive = async (target) => {
  const active = SECTIONS.find((s) => tabNamed(s.label).getAttribute('aria-selected') === 'true')
  if (active?.id === target.id) {
    const other = SECTIONS.find((s) => s.id !== target.id)
    await click(tabNamed(other.label))
  }
  assert.notEqual(
    tabNamed(target.label).getAttribute('aria-selected'),
    'true',
    `the ${target.label} tab is not already selected, so the click under test has to be what selects it`,
  )
  assert.equal(
    panelFor(tabNamed(target.label)).hidden,
    true,
    `the ${target.label} panel starts hidden`,
  )
}

/**
 * The assertion that matters: exactly one tab is selected, and the panel it
 * controls is the only one not hidden.
 *
 * Written per section so a failure prints the section by name rather than an
 * index into an array.
 */
const assertOnlyPanelVisible = (target) => {
  for (const section of SECTIONS) {
    const isTarget = section.id === target.id
    const tab = tabNamed(section.label)
    const panel = panelFor(tab)

    assert.equal(
      tab.getAttribute('aria-selected'),
      isTarget ? 'true' : 'false',
      `after clicking ${target.label}, the ${section.label} tab has aria-selected="${isTarget ? 'true' : 'false'}"`,
    )
    assert.equal(
      panel.hidden,
      !isTarget,
      `after clicking ${target.label}, the ${section.label} panel has hidden=${!isTarget}`,
    )
    assert.equal(
      panel.hasAttribute('hidden'),
      !isTarget,
      `after clicking ${target.label}, the ${section.label} panel ${isTarget ? 'is not' : 'is'} [hidden]`,
    )
  }
}

for (const target of SECTIONS) {
  test(`clicking the ${target.label} tab shows its panel and hides the other two`, async () => {
    await openSettings()
    await makeInactive(target)

    await click(tabNamed(target.label))

    assertOnlyPanelVisible(target)
    assert.deepEqual(
      selectedLabel(),
      [target.label],
      'exactly one tab reports itself selected',
    )
    await closeSettings()
  })
}

test('switching panels does not take the tab strip with it', async () => {
  // A regression that swapped the panel correctly but replaced the tab bar --
  // or moved it inside a hidden container -- would leave every assertion above
  // green and leave the reader with no way back. The strip is checked after
  // *each* switch, not once at the end.
  await openSettings()

  for (const target of SECTIONS) {
    await makeInactive(target)
    await click(tabNamed(target.label))

    const strip = tablist()
    assert.equal(strip.getAttribute('role'), 'tablist', `the strip is still a tablist after switching to ${target.label}`)
    assert.equal(
      strip.querySelectorAll('[role="tab"]').length,
      3,
      `all three tabs are still in the strip after switching to ${target.label}`,
    )
    assert.ok(window.document.contains(strip), `the tab strip is still in the document after switching to ${target.label}`)
    assert.ok(
      root.querySelector('.settings-page').contains(strip),
      `the tab strip is still inside the settings page after switching to ${target.label}`,
    )
    assert.equal(
      strip.closest('[hidden]'),
      null,
      `the tab strip is not inside a hidden container after switching to ${target.label}`,
    )
    // The roving tabindex: one stop for the whole strip, on the tab whose panel
    // is showing. A tab bar where the stops scattered would be a separate bug,
    // but it lives in the same three nodes this test already has open.
    const stops = [...strip.querySelectorAll('[role="tab"]')].filter((node) => node.tabIndex === 0)
    assert.equal(stops.length, 1, `exactly one tab is in the tab order after switching to ${target.label}`)
    assert.equal(
      tabNamed(target.label).tabIndex,
      0,
      `the ${target.label} tab is the one Tab lands on after switching to it`,
    )
    assertOnlyPanelVisible(target)
  }

  await closeSettings()
})

test('every panel is reachable from the strip and only one is ever visible', async () => {
  // The same three clicks again, from a clean open, asserting the shape of the
  // control rather than one particular transition: three tabs, three panels, and
  // no point in the cycle where two panels are showing at once.
  await openSettings()

  assert.equal(
    tablist().querySelectorAll('[role="tab"]').length,
    SECTIONS.length,
    'the strip has one tab per section',
  )
  assert.equal(
    root.querySelectorAll('[role="tabpanel"]').length,
    SECTIONS.length,
    'every section has a panel, and all of them are mounted',
  )
  assert.deepEqual(
    SECTIONS.map((s) => root.querySelector(`[role="tabpanel"]#${s.id}`).getAttribute('aria-labelledby')),
    SECTIONS.map((s) => `${s.id}-tab`),
    'each panel is labelled by the tab that controls it',
  )

  for (const target of SECTIONS) {
    await makeInactive(target)
    await click(tabNamed(target.label))

    const visible = SECTIONS.filter((s) => !panelFor(tabNamed(s.label)).hidden)
    assert.deepEqual(
      visible.map((s) => s.id),
      [target.id],
      `clicking ${target.label} leaves only its own panel visible`,
    )
  }

  await closeSettings()
})