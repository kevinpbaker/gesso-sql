<div align="center">

# Gesso SQL

**A SQL workbench over five million rows whose grid keeps scrolling while the query runs.**

Built on [Gesso](https://github.com/kevinpbaker/gesso), a UI framework that lays out, paints and hit-tests the whole interface in a worker, with [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) in a worker of its own.

TypeScript · Canvas · four threads · DuckDB 1.4 · zero DOM under the grid

[Sixty seconds](#sixty-seconds) · [What it does](#what-it-does-today) · [The numbers](#the-numbers) · [How](#how-it-works) · [Not yet](#what-it-is-not-yet) · [Under the hood](#under-the-hood)

</div>

---

Every database tool has the same moment. You run the query that takes
ten seconds, and for ten seconds the tool is a picture of itself. The
result you were reading is frozen, the scrollbar does nothing, and the
only control that works is the one that kills the query, if it does.

This one keeps going. The query runs in **DuckDB's worker**. The
workbench's state, every result and every page of rows live in an
**application worker**. The grid, the editor and everything else on
screen are laid out and painted by a **render worker**. The main thread
forwards input and does nothing else. So while a window function grinds
through five million rows, the last result stays live: scroll it,
sort it, read it, and press Cancel when you have seen enough.

## Sixty seconds

```bash
pnpm install
pnpm dev
```

Gesso SQL builds on the Gesso checkout beside it (`../gesso`); see
[building against Gesso](#building-against-gesso).

Open the address Vite prints. DuckDB starts and generates five million
taxi trips in a few seconds: pickup and dropoff times, zones, distance,
fare, tip and payment. They are made by DuckDB itself from `range()`
and `hash()`, so they are the same rows on every machine. The editor
holds a script of queries. Put the caret in one and press Ctrl+Enter
(⌘+Enter on a Mac): the statement under the caret runs, and the
statement under the caret is always washed in a faint colour, so you
can see what Run means before you press it.

Then try these:

1. **Run `SELECT * FROM trips`** and scroll to the bottom. That is five
   million rows. The grid mounts the thirty or so on screen and asks
   the application worker for those and a band around them. Paging is
   `WHERE rowid BETWEEN` on a materialised table, a few milliseconds at
   any depth.
2. **Run the window-function query** a little further down, then
   scroll the grid while it runs. The rows you scroll to arrive. The
   timer in the toolbar counts in tenths of a second, painted by the
   render worker. Press Cancel.
3. **Press a column header** to sort all five million rows, and the
   chart button beside a header to profile that column: nulls, distinct
   values, range, mean, and the most common values.
4. **Open the Chart tab** after the hour-of-day query.
5. **Type** `SELECT * FROM trips t WHERE t.` and the editor offers that
   table's columns. Misspell one and run it: the error is underlined
   where DuckDB says it is, and DuckDB's suggestion is in the message.
6. **Drop a CSV, Parquet or JSON file** anywhere on the window. It
   becomes a table named after the file.

Add `/proof` to the url for Gesso's instrument strip, which runs on the
main thread on purpose. It has a button that blocks that thread for five
seconds and a heatmap of what the last frame measured.

## What it does today

- **An editor that is a code editor.** Syntax colours from one
  tokenizer that also splits statements and drives completion, so the
  three agree about where a string ends. Line numbers that follow the
  text's scroll in the same layout pass. Completion of tables after
  `FROM` and `JOIN`, of a table's columns after its alias and a dot, and
  of columns in scope, functions and keywords elsewhere. Tab indents,
  Ctrl+Space asks. IME, undo, selection and the clipboard are Gesso's
  editable text and none of them is written here.
- **Run what you mean.** The statement under the caret, or the
  selection. A selection of several statements runs them in order and
  shows the last; the first to fail stops the rest and is the one
  pointed at.
- **A grid of any size.** Results are materialised once, in an attached
  in-memory database, and paged by `rowid`, so neither paging nor
  scrolling runs the query again. A sticky header with each column's
  type, sticky row numbers, numbers on the right, `NULL` drawn as itself,
  columns sized from a sample of their values and resizable by dragging,
  keyboard selection, and Ctrl/⌘+C to copy a cell.
- **Sort, profile, chart, export.** A sort writes one sorted copy of
  the result, so a scroll through it afterwards is as cheap as before.
  A profile is two aggregate queries. The chart sums a large result by
  its biggest groups and draws a small one row by row, on Gesso's paint
  surface. Export writes CSV through DuckDB's own `COPY`.
- **Statements without rows.** `CREATE`, `INSERT` and the like say what
  they changed. `EXPLAIN` shows the plan. `DESCRIBE`, `SHOW` and
  `SUMMARIZE` become results like any query.
- **Schema and history.** The tables and their columns in a tree, with
  Preview and Summarize. Every statement run, with how long it took and
  how many rows it made; press one to run it again. History and the
  editor's text are saved to the origin private file system.
- **Light and dark**, following the system.

## The numbers

Measured in headless Chrome on one Mac, through the same input path a
person uses, by `pnpm tour`. They are one run's figures, not a
benchmark, and the DuckDB ones are DuckDB's: the point of the
arrangement is that none of them is a number the interface waits for.

| What                                                  | Took        |
| ----------------------------------------------------- | ----------- |
| Generate 5,000,000 trips                              | 2.1 – 4.4 s |
| `SELECT * FROM trips`, materialised (5M rows × 11)    | 420 – 560 ms |
| The busiest-zones join and aggregate                  | 280 ms      |
| Trips by hour of day                                  | 50 ms       |
| Sort the 5M-row result by a column                    | 2.1 – 2.3 s |
| One page of 256 rows, 7,000,000 rows deep (node)      | 13 ms       |

And the one that is not a duration: while the window-function query
ran, the grid was scrolled to row 1,732 of the previous result and
every cell there was filled.

## How it works

```
 main thread          render worker            application worker          DuckDB's worker
 ───────────          ─────────────            ──────────────────          ───────────────
 canvas, input  ───▶  editor, grid, chart ◀──▶ WorkbenchService      ◀──▶  connection "run"
 a11y mirror          layout, paint            results, pages, history     connection "read"
                      caret, selection         OPFS
```

**The channel.** `src/app/Contract.ts` is the only module both workers
import: one token, its view keys and its commands, and no code. Keys
are cut by why they change, so a scroll changes `window` and nothing
else, and `window` is keyed by row index so a scroll of ten rows is ten
keys set and ten deleted rather than an array resent.

**Two connections.** DuckDB-WASM runs a statement in steps and answers
other messages between them. Your statements go to one connection and
everything the screen reads (pages, sorts, profiles, the schema) goes
to the other, so a page read is answered while a long statement is still
running. Results live in an attached database, `gesso_results`, because
a temporary table is visible only to the connection that made it.

**The grid.** Gesso's `LazySheet` windows both axes from arithmetic on
the scroll offset. Each cell's text, colour and selection ring are
pushed in by three `fanOut` registries rather than piped off the
channel per cell, and released as cells leave the window.

## What it is not yet

- **The data is not saved.** History and the editor's text survive a
  reload; tables do not. A loaded file is read into memory, and the
  file is still on the disk it came from.
- **One result at a time.** No result tabs, no pinning.
- **Memory is the browser's.** A `SELECT *` over a large table is a
  second copy of it, and a sort is a third. DuckDB-WASM's ceiling is the
  tab's, a few gigabytes; the sample offers up to ten million rows.
- **No remote data.** Parquet over HTTP works in DuckDB-WASM, but there
  is no UI for attaching a URL yet. Write `read_parquet('https://…')`.
- **Chrome is what it has been checked in.**

## Under the hood

### Where things are

| Path                | What                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `src/sql/`          | The tokenizer, statement splitting, highlighting and completion. Pure   |
| `src/data/`         | The application worker: the service, result sources, DuckDB, OPFS        |
| `src/app/`          | The render worker: every component, and the channel contract            |
| `src/main.ts`       | The main thread, all of it                                              |
| `scripts/tour.ts`   | Headless Chrome through every feature, with a screenshot at each stop   |
| `GESSO-ISSUES.md`   | What building this found in Gesso, and what happened to each            |

### Tests

```bash
pnpm test
```

Everything below the channel runs in node against DuckDB-WASM's
blocking build, the same engine compiled to the same WebAssembly, so the
specs run real SQL. The screen's specs mount the real components with
`gesso-testing` over that service, through a real `MessageChannel`, with
no browser.

```bash
pnpm dev            # in one terminal
pnpm tour /tmp      # in another: screenshots in /tmp
```

### Building against Gesso

`pnpm-workspace.yaml` links every `gesso-*` package to `../gesso`, so
the workbench runs on that checkout's source. It needs fixes made since
Gesso 0.4.2, listed in `GESSO-ISSUES.md`. When a release carries them,
the overrides can go and the published packages come back.

### Deploying

`vercel.json` is set up as the other Gesso apps' are. A deploy needs the
published Gesso packages, so it waits on that release.
