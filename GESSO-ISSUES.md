# Gesso issues found while building the SQL workbench

Problems in Gesso, or traps in using it, found by building on it, and
what happened to each.

**Where the fixes are:** committed to `main` in `../gesso`, one commit
per fix. Not pushed or released. Each has a spec that fails without it,
a changeset, and docs where behavior changed, and was checked with
Gesso's format, lint, typecheck, API report, docs check and the full
test suite (4,465 tests at the second fix).

**How the workbench uses them:** `pnpm-workspace.yaml` overrides every
`gesso-*` package with a link to `../gesso/packages/*`. Once a release
carries these fixes the overrides can go.

## Fixed

### 1. A `Tabs` given a height left its panel at the height of its content

**What:** the schema sidebar is a `Tabs` with `flex: 1`. Its panel
stretched across but not down, so the tree inside it sat two rows tall
in a full-height column and could not scroll within it.

**Fix:** the panel grows into what the tab list leaves and stretches its
child. A `Tabs` sized by its content is unchanged. Commit `316da44`.
Spec: `Structure.spec.ts`, "gives its panel the height the strip leaves,
when it has a height".

### 2. A tooltip opened on a click, and outlived its element

**What:** Run turns into Cancel while a statement runs. Clicking Cancel
focused it, focus opened its tooltip, and when the statement stopped the
Cancel button was replaced by Run. Nothing closed the tooltip: no pointer
left, no focus blurred. It stayed over the History tab, anchored to
nothing.

**Fix:** three parts, one commit, `f02740f`.

- A tooltip opens for focus the keyboard can see, as a focus ring does,
  and not for the focus a press gives. A key pressed afterwards opens it.
- A tooltip closes when its element is removed, unless the same tooltip
  has since been opened on another element.
- The `Tooltip` component listened for focus on its wrapper, which never
  takes focus, and focus does not bubble, so a keyboard never opened it.
  It now follows focus anywhere inside, through a new
  `FocusService.focusVisible`.

This changed documented behavior: the tooltip page described a press on
a focusable trigger reopening the tooltip "while that control holds the
keyboard". The page and its example spec now describe the new behavior.

Specs: `Tooltip.spec.ts`, "does not open when a press is what focused
the element", "closes when the element goes and the component that
rendered it stays", "opens for keyboard focus inside it, and not for a
press"; `TooltipExample.spec.ts`, "closes on a press, and the focus a
press gives does not open it again".

### 3. Canvas2D drew rows millions of pixels down off their pixel

**What:** at the bottom of five million 26-pixel rows, the grid's rows
came out with uneven gaps and overlaps. Skia keeps the canvas transform
and every coordinate in 32-bit floats, and the renderer translated by
minus a scroll offset of about 130 million pixels and then drew each
row at about 130 million. Each was rounded to the nearest eight pixels
on its own.

**Fix:** the Canvas2D renderer draws through a `PreciseContext` that
holds a translation of a million pixels or more in a double and adds it
to each coordinate before the canvas sees it. Below the threshold every
call passes through, so the renderer's recorded-call specs are
unchanged. WebGPU already applied scroll in JavaScript. Commit
`303e85a`. Spec: `PreciseContext.spec.ts`, "draws a row at the bottom of
a huge scroll where it belongs".

## Already fixed upstream, not yet released

### 4. A percentage inside a flexed item resolved against its content

**What:** in the published 0.4.2, a nested `SplitPane` under a `flex: 1`
box sized its first pane from its content instead of the fraction: 40%
of a 460 px pane came out as 2,000 px, the second pane got nothing, and
the result grid inside it was laid out at its full content height —
5,000,000 rows × 26 px — and mounted rows until the page ran out of
memory.

**Status:** Gesso's `main` already lays this out correctly; the change is
in the layout engine's memoisation since 0.4.2. It is the reason the
workbench links `../gesso` rather than using the published packages.

## Traps, not bugs

### `flex` does nothing inside a box

A `SplitPane` pane is a `Box`, which stacks its children rather than
flexing them, so a panel root with `flex: 1` inside one is sized by its
content. The editor and the results panel did this at first, and the
symptom was the same as issue 4. The fix in the app was `height: 100%`.
The engine's `explain()` said so plainly once asked.

## Open questions

### Can a command carry bytes?

`open(file)` sends a file's bytes as a `Uint8Array`. At runtime that
works: a command's argument is structured-cloned, and
`WorkbenchApp.spec.tsx` drives it through a real port. But
`gesso-vite-plugin`'s channel-schema pass warns that the field "is not
plain data and cannot cross a channel", which is true of a view key and
not of a command. gesso-sheets base64-encodes instead, which for a
500 MB Parquet file is a third larger and an encoding pass on the render
thread. Whether commands may carry binary is a framework decision, so it
is left as a question rather than changed: either the rule allows typed
arrays in commands and the schema describes them (`contentEncoding`),
or the workbench moves to base64.
