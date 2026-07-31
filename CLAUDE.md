# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio transport) that aggregates news from Telegram channel previews and RSS/Atom
feeds into structured JSON. It's designed to be launched by a host agent (e.g. osaurus) as
`bun server.ts` on the host machine directly — no sandbox — so it has network access and a
writable filesystem for state.

## Commands

```bash
bun install               # install deps
bun run lint              # bunx biome lint
bun run format            # bunx biome format
bun run check             # bunx biome check (lint + format + organize imports)
bun server.ts             # run the MCP server directly (reads stdio)
```

There is no test suite. Biome is the only linter/formatter; a lefthook pre-commit hook runs
`bun run check --write` on staged JS/TS/JSON/CSS files and re-stages fixes automatically.

To smoke-test the server manually, pipe JSON-RPC messages into it over stdio (see README.md for
the exact `initialize` / `tools/call` sequence).

## Architecture

**Entry point**: `server.ts` registers two MCP tools (`get_news`, `list_sources`) and delegates
all logic to `lib/run.ts`. The server itself is just wiring — no business logic lives here. Both
tools publish an `outputSchema` and return the payload as `structuredContent` *and* as serialized
JSON in a text block (the spec's backwards-compatibility path for clients that read only `content`).
`list_sources` wraps its list as `{ sources: [...] }` because `structuredContent` must be a JSON
object, not a bare array. Note that the `content` text block is not merely a fallback: osaurus,
the host this was built for, reads *only* `content` and ignores `structuredContent` entirely, so
that block is what a host's per-call output cap gets measured against — which is why `get_news`
pages (below).

**Output shapes** (`lib/schema.ts`): zod schemas are the single source of truth for everything the
tools return. `Item` and `SourceResult` (`lib/types.ts`) and `Digest` / `Payload` (`lib/run.ts`) are
`z.infer`red from them, so there is one definition, not two that can drift. (`Digest` is one whole
run — what gets snapshotted; `Payload` is that plus a `page` block — what a tool call returns.) Two things follow.
Field docs go in `.describe()`, not JSDoc — that text is published in the JSON Schema that
`tools/list` advertises, so clients and the model actually read it, whereas JSDoc is erased at build
time. And the SDK validates `structuredContent` against these schemas on *every* call, so a payload
field added without a matching schema field fails the tool call outright rather than degrading —
edit the schema, not the interface. Config *input* types (`Source`, `Config`, `Ctx`) stay plain
interfaces: `lib/config.ts` validates those by hand so it can report each error's `line:col`.

**Paging** (`lib/run.ts::getNews` → `lib/snapshot.ts` + `lib/paginate.ts`): `get_news` returns one
*page* of a run, not the whole thing, because MCP hosts cap tool output — osaurus head/tail-truncates
past 100,000 chars (`ToolOutputCaps.universalResult`), and a `fullText` digest runs ~180 kB. A call
without a `cursor` runs `runDigest`, snapshots the result under a `runId`, and returns page 0; a call
*with* one replays that snapshot. The snapshot is not a cache optimisation — `runDigest` marks the
whole run seen when it persists state, so re-running would correctly find the rest of the digest
already seen and return nothing. Paging over a frozen run is the only way "deliver everything" and
"dedup across runs" can both hold. Pages are sized by measured `JSON.stringify().length` (a safe
over-estimate of the grapheme count a Swift host measures), budget from `maxCharsPerCall` / the
`maxChars` argument. Two invariants worth keeping: a page always advances by at least one item (an
item too big for a page is cut to fit and marked `truncated`), and source-level `error` entries ride
on page 0 only.

**Core flow** (`lib/run.ts::runDigest`, wrapped by `getNews`):
1. Load `sources.jsonc` via `lib/config.ts`.
2. For each enabled source (all fetched in parallel), dispatch to a handler by `source.type` via
   the `HANDLERS` registry (`{ telegram: fetchTelegram, rss: fetchRss }`).
3. Filter fetched items against the lookback window and previously-seen IDs (dedup), sort newest
   first (undated items last), cap per-source. Cap semantics are "freshest-only": handlers stop
   fetching at the cap counting seen items too, so in-window items older than the newest
   `maxItems` are dropped by design and never surface in later runs.
4. For sources with `fullText: true`, replace item bodies with the article text via
   `lib/extract.ts`. Runs here — after filtering — so article pages are only fetched for items
   actually being returned, never for previously-seen ones.
5. Persist per-source `{ lastRunISO, seenIds }` to state (unless `includeSeen: true`), pruning
   entries for sources no longer present in the config.
6. Back in `getNews`, snapshot the finished run and return its first page (see **Paging** above).

**Adding a new source type**: create `lib/<type>.ts` exporting `(src: Source, ctx: Ctx) =>
Promise<Item[]>`, then add one line to the `HANDLERS` map in `lib/run.ts`. Individual sources are
never hardcoded — they live entirely in `sources.jsonc`, keyed by `type` as a plain string (an
unknown type is a runtime error, not a compile error — see the note atop `lib/types.ts`).

**Config resolution** (`lib/config.ts`): the config is **JSONC** (JSON + `//` and `/* */` comments
+ trailing commas), parsed with `jsonc-parser`; both config files carry inline comments documenting
each option, so the template is the option reference. It's read fresh on every call (no caching, no
restart needed to pick up edits) — that hot-reload is load-bearing, so don't add a module-level
cache. Path resolution: `$NEWS_DIGEST_CONFIG` env var, else the first of `<repo>/sources.jsonc`,
`<repo>/sources.json` that exists (the `.json` name is a compatibility fallback for older installs
and is still parsed as JSONC). `sources-template.jsonc` is the checked-in template; the real
`sources.jsonc` is gitignored (contains user's actual channel/feed URLs). A parse failure throws
with every error's `line:col`, failing the whole tool call rather than silently serving stale config.

**State** (`lib/state.ts`): dedup state is stored *outside* the repo (so it survives a read-only
install) at `$NEWS_DIGEST_STATE`, or `$XDG_STATE_HOME/news-digest/state.json`, or
`~/.local/state/news-digest/state.json`. Keyed by source id; each entry keeps a bounded
(`dedupeKeepRecent`, cap 400), newest-first list of `seenIds`. `includeSeen: true` bypasses dedup
entirely and skips persisting state (one-off full pull). Run snapshots (`lib/snapshot.ts`) live in
`runs/` beside it, resolved via the exported `stateDir()` so `$NEWS_DIGEST_STATE` still moves
everything at once; they're disposable (24h / 10 runs), and a missing one is a cache miss that asks
the caller for a fresh run, never an error.

**Source-specific handlers**:
- `lib/telegram.ts` scrapes the public `https://t.me/s/<channel>` HTML preview (no API/bot token
  needed). It paginates backwards via `?before=<message_id>`, stopping when it hits the item cap,
  leaves the lookback window, reaches `maxPages`, or makes no further progress (`oldestId` stalls).
  `maxPages` resolves per-source first (`src.maxPages`), then the global `telegram.maxPages`, then 5
  — the same override chain as `maxItems`. Media-only/service posts with no caption text are skipped.
- `lib/rss.ts` uses `fast-xml-parser` and handles RSS 2.0, RSS 1.0 (RDF), and Atom in one function
  by branching on which root key is present (`doc.rss.channel`, `doc.feed`, `doc['rdf:RDF']`).
  Item links run through `cleanUrl` at the point they're assigned, so `Item.url` and the
  `guid || link` id fallback see the same tracking-free string. A feed's own `<guid>` is never
  rewritten — it's an opaque identity token, and touching it would invalidate persisted `seenIds`.

**Full-text enrichment** (`lib/extract.ts`): opt-in per source (`fullText: true`), source-type
agnostic — it only needs `Item.url`. Runs `@mozilla/readability` (Firefox's reader mode) over a
`linkedom` DOM; `<figure>` elements are dropped first, since their captions are noise in a text
digest and some sites render them as prose. Everything is best-effort per item: any failure keeps the
original text, and the outcome is reported as `Item.textSource` (`'article'` | `'feed'`).

One non-obvious piece: Readability can anchor on a single block of an article built from sibling
blocks and silently drop everything above it (BBC does this — measured 63-82% of the prose retained
on a third of articles, lede included). So `repair()` compares its output against a snapshot of the
page's paragraphs and, when coverage falls below 85%, rebuilds the body from every paragraph whose
wrapper fingerprint (parent tag + class) matches one Readability *did* keep. That learns the page's
own structure rather than hardcoding selectors, and only applies when it recovers meaningfully more
text, since the rebuilt body is flat (no headings or lists).

**Shared utilities** (`lib/util.ts`): `stripHtml` (HTML → clean plain text, `<br>`/`<p>` become
newlines, script/style/noscript contents dropped), `truncate`, `asArray` (normalize XML's
single-item-vs-array ambiguity), `toISO`, `cleanUrl` (drop analytics query params — `utm_*`,
BBC's `at_*`, `fbclid`, `cmp`, `ito` and friends — from a link; deliberately total, so an empty,
relative or malformed URL comes back unchanged rather than throwing, and a link with nothing to
strip is returned byte-identical rather than re-serialized through `URL`), and `fetchText` (fetch
with a browser-like UA — some sources vary output by UA — plus a timeout, `fetchTimeoutMs` in
`sources.jsonc` / default 15s, and a 5 MB response cap; a slow or down source becomes a per-source
error entry instead of stalling the digest). `fetchPage` shares that request path but returns
`{ html, finalUrl, contentType }` and honours the page's declared charset (header, then a
`<meta charset>` sniff) — arbitrary article pages are far likelier than feeds to be
windows-1251, and mojibake is worse than no text.
`mapWithLimit` is a bounded-concurrency map, so enrichment doesn't open one socket per item.

**Item identity**: every `Item.id` is namespaced by source type and source id (e.g.
`tg:<channel>/<msg_id>`, `rss:<source_id>:<guid>`) so ids are globally unique and stable across
runs for dedup purposes.

## Conventions

- 4-space indentation, single quotes, semicolons, 120-char line width (enforced by Biome, see
  `biome.json`).
- TypeScript strict mode with `noUncheckedIndexedAccess` — index access returns `T | undefined`.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`, bundler resolution).
