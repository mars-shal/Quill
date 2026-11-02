/**
 * Test setup: registers the jsx/css loader hook.
 *
 * Imported via `node --import ./tests/setup.mjs`.
 *
 * Browser API stubs live in `app-render.test.mjs`, next to the JSDOM instance
 * they patch. This file runs before that window exists, so anything installed
 * here would attach to the wrong global.
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./jsx-loader.mjs', pathToFileURL(import.meta.filename))

