# UI components

shadcn/ui components for Quill. Radix primitives and `lucide-react` are
installed; the components themselves land in Phase 6 (TODO.md).

## Read this before adding a component

**Every Tailwind utility here must be `tw:`-prefixed.** Not `flex` —
`tw:flex`. Not `tw-flex` — `tw:flex`. `tests/shadcn-prefix-guard.test.mjs`
fails the build if this is wrong, but the failure it prevents is silent: a
class the prefix does not match generates no CSS at all, so the component
renders unstyled and nothing errors.

Three ways to get it wrong, all of which look plausible:

| Written | Result |
| --- | --- |
| `className="flex"` | Unprefixed. Tailwind emits nothing under `prefix(tw)`. |
| `className="tw-flex"` | The **v3** form. `prefix()` in Tailwind v4 emits `${prefix}:`, so a dash-prefixed candidate parses as an unknown utility. |
| `className="tw::flex"` | What you get if `tailwind.prefix` in `components.json` is `"tw:"` instead of `"tw"`. The CLI appends the colon itself. |

## The prefix goes at the front only, once

This is the one that catches everyone, including a test written specifically to
catch the others:

```
tw:focus-visible:ring-2      correct
tw:focus-visible:tw:ring-2   wrong — generates nothing
```

Tailwind v4 puts the prefix once, at the head of the chain. Variants and the
utility that follows share it. Writing `tw:` on every segment looks reasonable
because shadcn's own source reads `focus-visible:ring-2` and the prefix appears
to belong on each part — but the segment after the variant becomes the literal
string `tw`, which matches no utility, and the whole rule silently disappears.

`data-[…]` chains are where this bites hardest, because there are several
segments and shadcn uses them heavily:

```
tw:data-[side=left]:-translate-x-1     correct
tw:data-[side=left]:tw:-translate-x-1  wrong
```

`tests/shadcn-prefix-guard.test.mjs` checks for this too. It was added after all
four components in this directory had shipped it in every variant chain, which
is the clearest evidence that the failure is easy to produce and hard to see.

## Why the prefix exists at all

Quill's own class names collide with Tailwind utility names — `outline`,
`border`, `shadow`, `container`, `ring`, `table`, `hidden`. Tailwind's scanner
reads any text in a scanned file, so each one used to emit a utility. That
shipped a visible bug: `<nav className="outline">` rendered with a 1px white
box around it, because Quill's `.outline` set layout while Tailwind's set
`outline-width`, and unlayered CSS only outranks layered CSS for properties
*both* rules set.

Prefixing fixes the collision at the name, where specificity never gets a say.
`KNOWN_COLLISIONS` in `tests/tailwind-bridge.test.mjs` re-derives the collision
set from a real build rather than trusting this paragraph. Do not remove the
prefix.

## Installing components

`components.json` sets `tailwind.prefix: "tw"` — bare, no colon, no dash. The
shadcn CLI's `applyPrefix` appends the separator per Tailwind major version:

| Tailwind | Emits | `components.json` value |
| --- | --- | --- |
| v3 | `tw-flex` | `"tw-"` |
| v4 | `tw:flex` | `"tw"` |

Quill is on v4. Setting `"tw:"` produces `tw::flex`, which generates nothing.

Two further notes for this project specifically:

- The scanner is `@source './'` scoped to `src` only, deliberately, so test
  fixtures do not emit phantom utilities. Components must therefore live under
  `src/` — which is what the `aliases.ui: "@/library/ui"` entry arranges.
- `dark:` is wired to Quill's `data-mode`, not to a `.dark` class, via
  `@custom-variant dark` in `src/tailwind.css`. Custom dark themes work because
  `data-mode` comes from the resolved theme's mode rather than its name.

## Tokens

`src/tailwind.css` already maps shadcn's expected variable names onto Quill's
own (`--primary`, `--background`, `--card`, `--popover`, `--muted`,
`--destructive`, `--border`, `--input`, `--ring`, `--radius`, and the fonts),
so components should need no new palette work. Do not add a second copy of the
palette here — a JS copy would drift from `styles.css` the way `SUITES` in
`scripts/check-contrast.mjs` already did once.

## Icons

`lucide-react` is installed and `components.json` names it, but the app still
carries its own SVG registry at `src/Icon.jsx`. Migrating icons is not in
Phase 6's scope; prefer `src/Icon.jsx` unless a component genuinely cannot
render without its own icon.