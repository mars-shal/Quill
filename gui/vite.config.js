import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    // shadcn's generated components import from `@/…`. Quill used relative paths
    // before Tailwind arrived and keeps them, so this is only here for what the
    // CLI writes.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  // The automatic JSX runtime is required: esbuild otherwise defaults `.jsx`
  // files to the classic transform, which needs `React` in scope in every file.
  // A new component that only imports hooks then throws
  // "Can't find variable: React" at runtime, and only in `tauri dev`.
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1430 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_PLATFORM', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // `chunkSizeWarningLimit` is deliberately unset.
    //
    // It was 1200, then 1500, and both were the same mistake twice: each sat
    // just above the bundle as measured, so the warning could never fire. The
    // comment beside it claimed the opposite -- that leaving it unset keeps Vite
    // advising a code-split on every build this project has declined, because "a
    // standing warning is how warnings stop being read". A limit set above the
    // current size is not a standing warning; it is the absence of one, written
    // down so it looks deliberate.
    //
    // Unset, Vite's default (500kB) applies and the build says out loud that the
    // chunk is large. That is true and worth saying: ProseMirror and Yjs are
    // inherently large and the editor layer is mounted for the whole session, so
    // there is no lazy path to split them onto, and a Tauri bundle is read from
    // local disk inside the binary -- no network waterfall to shorten. What *is*
    // lazy-able is everything that only renders inside the Conclave panel, and
    // that is now split out (see `library/chat-effects.js`).
    //
    // Measured at the time of writing, and the reason this limit is unset:
    //   before, all one chunk:  1,270kB minified, 400kB gzipped
    //   after, effects split:     964kB minified, 307kB gzipped
    // The 306kB is the five assistant effects, moved behind `React.lazy` in
    // `library/chat-effects.js`. That is what is left, and it is ProseMirror and
    // Yjs: the editor is mounted for the whole session and the document arrives
    // through `useCollaborativeDocument` either way, so there is no lazy path to
    // split them onto. A Tauri bundle is read from local disk inside the binary
    // -- no network waterfall to shorten.
    //
    // Note this is the chunk-size *hint*, which is not suppressible in `onwarn`
    // below: Vite logs it itself after the bundle is written, so it never
    // reaches the handler.
    rollupOptions: {
      onwarn(warning, warn) {
        // framer-motion ships "use client" directives that esbuild cannot
        // preserve; they are inert here and the warning is pure noise in build
        // output. Note that the chunk-size hint is *not* suppressible here: Vite
        // logs it itself after the bundle is written, so it never reaches
        // `onwarn`. That is what `chunkSizeWarningLimit` is for.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
        warn(warning)
      },
    },
  },
})
