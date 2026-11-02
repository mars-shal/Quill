/**
 * Checks that every test file is actually run.
 *
 * `scripts/test-js.sh` lists its files explicitly, in two passes, because Node's
 * test runner cannot mix flagged and unflagged file sets in a single invocation
 * -- the three suites that use `mock.module` need
 * `--experimental-test-module-mocks`, and the rest must not have it.
 *
 * The consequence is that a new `tests/*.test.mjs` is not picked up by being
 * created. It has to be added to one of the two lists, and if nobody does that,
 * `npm run check` reports green without ever running it. That is the failure mode
 * worth guarding: a test that exists, reads like coverage, and executes never.
 *
 * This script is called by `test-js.sh` itself rather than being a test, so that
 * it cannot be omitted from a run in the same way a test can be.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const testDir = join(root, 'tests')
const scriptPath = join(root, 'scripts', 'test-js.sh')

const found = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

const runner = readFileSync(scriptPath, 'utf8')

const unlisted = found.filter((name) => !runner.includes(`tests/${name}`))

if (unlisted.length > 0) {
  console.error(
    [
      `${unlisted.length} test file(s) are not run by scripts/test-js.sh:`,
      ...unlisted.map((name) => `  tests/${name}`),
      '',
      'Add each to the pass it belongs to -- the mocked one if it imports',
      '`mock.module`, otherwise the plain unit pass -- or the suite stays',
      'silently unexecuted.',
    ].join('\n'),
  )
  process.exit(1)
}