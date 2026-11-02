#!/usr/bin/env bash
# Runs the JavaScript test suites.
#
# `app-render.test.mjs` mounts the real App, so it needs module mocking and the
# jsx/css loader hook. Node's test runner cannot mix flagged and unflagged file
# sets in one invocation, so the suites run in two passes and the results are
# combined.
#
# Every pass runs with `--test-concurrency=1`, which runs one test *file* at a
# time. Node otherwise runs files in parallel, and these suites cannot take it:
# `app-render.test.mjs` and its siblings patch a shared JSDOM window's globals and
# register module mocks, so two files mounting the App at once fight over the same
# process state. It failed as an intermittent 9-18 test failure count -- boot
# screen, library grid, effect stack, cover monograms -- with no consistent set,
# while the same files alone always passed. Serialising made it 6/6 and 3/3 clean
# across the unit, mocked-render and real-motion passes, at no measurable cost.
#
# Serial, not parallel, is the point: a green run has to mean the suites pass.
set -uo pipefail

cd "$(dirname "$0")/.."

status=0

# Both passes below name their files explicitly, because Node's test runner
# cannot mix flagged and unflagged file sets in one invocation. The cost is that
# a new test file which nobody added to a list simply never runs, and `check`
# stays green -- which is worse than having no test, because it reads as covered.
#
# So the lists are checked against the directory rather than trusted. `tests/*.test.mjs`
# is the contract; the passes are an implementation detail of it.
if ! listed=$(node scripts/check-test-lists.mjs); then
  echo "$listed" >&2
  status=1
fi

echo "==> unit suites"
node --test --test-force-exit --test-concurrency=1 \
  tests/ydoc.test.mjs \
  tests/editor.test.mjs \
  tests/markdown.test.mjs \
  tests/jsx-transform.test.mjs \
  tests/typography.test.mjs \
  tests/themes.test.mjs \
  tests/backgrounds.test.mjs \
  tests/account-state.test.mjs \
  tests/assistant-library.test.mjs \
  tests/outline-appearance.test.mjs \
  tests/motion.test.mjs \
  tests/render-cost.test.mjs \
  tests/bundle-shape.test.mjs \
  tests/tailwind-bridge.test.mjs \
  tests/shadcn-prefix-guard.test.mjs \
  tests/app-shell-overlay.test.mjs \
  tests/browser-store.test.mjs || status=1

echo
echo "==> render suite (framer-motion mocked)"
node --test --test-force-exit --test-concurrency=1 \
  --experimental-test-module-mocks \
  --import ./tests/setup.mjs \
  --test tests/app-render.test.mjs \
  --test tests/chat-window.test.mjs \
  --test tests/thesis-run.test.mjs \
  --test tests/effect-stack.test.mjs \
  --test tests/theme-picker.test.mjs \
  --test tests/background-picker.test.mjs \
  --test tests/settings-controls.test.mjs \
  --test tests/custom-theme-contract.test.mjs \
  --test tests/settings-tabs.test.mjs \
  --test tests/provider-fixture.test.mjs \
  --test tests/provider-credential.test.mjs || status=1

# The same App with the real framer-motion. The mocked suite cannot see the
# animation layer at all, and a visibly broken library grid once passed six
# filter tests there, so both are run.
echo
echo "==> render suite (real framer-motion)"
node --test --test-force-exit --test-concurrency=1 \
  --experimental-test-module-mocks \
  --import ./tests/setup.mjs \
  --test tests/app-render-motion.test.mjs \
  --test tests/dialog-keyboard.test.mjs || status=1

exit "$status"
