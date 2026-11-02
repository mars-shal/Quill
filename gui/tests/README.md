# Tests

```bash
npm test          # unit + render suites
```

| File | Command | Needs |
| --- | --- | --- |
| `ydoc.test.mjs` | included in `npm test` | — |
| `editor.test.mjs` | included in `npm test` | — |
| `markdown.test.mjs` | included in `npm test` | — |
| `app-render.test.mjs` | included in `npm test` | module mocking |

## Why `app-render.test.mjs` is different

It mounts the **real** `App` against a stubbed Tauri IPC, which needs two
things Node does not do on its own:

- `.jsx` and `.css` are transformed by `jsx-loader.mjs` (registered in
  `setup.mjs`)
- `@tauri-apps/api/core` and `framer-motion` are replaced via
  `node:test`'s module mocking

That is why it needs `--experimental-test-module-mocks`; the flags live in the
`npm test` script so you do not have to remember them.

Two stubs are deliberate:

- **framer-motion** is reduced to plain host elements. It passes
  `AbortSignal` options to `addEventListener`, which jsdom does not implement,
  and animation is not what this test is checking.
- **Tauri IPC** returns fixed data, so assertions are about application
  structure and data flow rather than the database.

The point of the suite is that a crash during render must fail a test. Without
an error boundary such a crash produced a blank window with no explanation.

Run just that suite with:

```bash
node --test-force-exit --experimental-test-module-mocks \
     --import ./tests/setup.mjs --test tests/app-render.test.mjs
```
