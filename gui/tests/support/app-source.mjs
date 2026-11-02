/**
 * The application's own source, for the tests that read it.
 *
 * A good number of Quill's guards are source-level rather than mounted: "the
 * canvas effects are passed the theme explicitly", "the panel tween has its own
 * helper", "this class is not used twice". They read the file the code is in,
 * which is fine until the code moves -- and then every one of them fails at once,
 * for a reason that has nothing to do with what it was checking. That is the
 * worst possible failure mode for a guard: a refactor buries a real regression
 * under twelve red tests, and the fix is to go and add the new filename to nine
 * files.
 *
 * So these tests read `appJsx()` instead, which is the joined source of every
 * module that makes up the app's UI. Moving a surface between these files is then
 * a non-event, which is the point: none of these assertions are about file
 * layout.
 *
 * What it does *not* cover is the note at the top of `motion.test.mjs`: a guard
 * that must find a definition in exactly one place still reads the files
 * individually, via `appSources`, because joining them would destroy the very
 * distinction it is checking.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = join(root, 'src')

/** Every `.jsx`/`.js` module under `src/`, excluding tests and assets. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.jsx?$/.test(entry) && !/\.test\.[^.]+$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * `[relativePath, source]` for each app module, sorted so a failure message
 * listing them is stable.
 */
export const appSources = walk(src)
  .sort()
  .map((file) => [relative(src, file), readFileSync(file, 'utf8')])

/**
 * The app's source as one string, for guards that assert on markup existing
 * somewhere rather than on where it lives.
 */
export const appJsx = () => appSources.map(([, source]) => source).join('\n')