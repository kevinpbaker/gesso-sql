# Gesso issues found while building the SQL workbench

Problems in Gesso, or traps in using it, found by building on it, and
what happened to each.

**Where the fixes are:** released in Gesso 0.5.0, one commit per fix. Each has a spec that fails without it,
a changeset, and docs where behavior changed, and was checked with
Gesso's format, lint, typecheck, API report, docs check and the full
test suite (4,465 tests at the second fix).

**How the workbench uses them:** from the registry, `^0.5.0`. It linked
`../gesso` until that release.

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

### 5. A Tree's labels were black, in a dark theme too

**What:** the schema sidebar's table and column names were nearly
invisible in dark mode. `Tree` set `color` on each row and left its
label and arrow to inherit it, but `color` does not cascade from a
parent node by design, so they drew in the text style's colour: black,
whatever the theme.

**Fix:** the Tree binds the colour on its two texts. Commit `819df79`.
Spec: `Data.spec.ts`, "draws its labels in the control colours of the
theme it is under, and the chosen one in the selection colour".

The app had its own half of this: its root provided `theme` without
`textStyle`, so any text naming no colour fell back to black. It now
provides the theme's body style beside the theme, as Gesso's appearance
guide shows.

`DataTable` set its row colour the same way, and its large-table recipe
told applications not to colour cells because they would inherit it.
Decided: keep the rule that `color` does not cascade, and change the
table. A column's `cell` now receives the colour as a third argument and
binds it on its text; the DataTable page, the recipe and both live
examples say so. Commit `23b26f6`.

## Fixed upstream before this work, released in 0.5.0

### 6. A percentage inside a flexed item resolved against its content

**What:** in the published 0.4.2, a nested `SplitPane` under a `flex: 1`
box sized its first pane from its content instead of the fraction: 40%
of a 460 px pane came out as 2,000 px, the second pane got nothing, and
the result grid inside it was laid out at its full content height —
5,000,000 rows × 26 px — and mounted rows until the page ran out of
memory.

**Status:** Gesso's `main` already lays this out correctly; the change is
in the layout engine's memoisation since 0.4.2. It is why the workbench
needed 0.5.0 rather than 0.4.2.

## Traps, not bugs

### `flex` does nothing inside a box

A `SplitPane` pane is a `Box`, which stacks its children rather than
flexing them, so a panel root with `flex: 1` inside one is sized by its
content. The editor and the results panel did this at first, and the
symptom was the same as issue 6. The fix in the app was `height: 100%`.
The engine's `explain()` said so plainly once asked.

## Decided

### A command may carry bytes

`open(file)` sends a dropped file's bytes as a `Uint8Array`, which a
command's structured clone carries as itself, but `gesso-vite-plugin`
warned that it "cannot cross a channel". Decided that commands may carry
bytes: the plugin now describes them as a base64 string tagged
`x-gesso-binary` and does not warn, the agent surface decodes an agent's
base64 back into that type, and bytes in a view key are still a
warning. Commit `88d93b3`.
