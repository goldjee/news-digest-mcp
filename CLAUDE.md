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
all logic to `lib/run.ts`. The server itself is just wiring — no business logic lives here.

**Core flow** (`lib/run.ts::runDigest`):
1. Load `sources.json` via `lib/config.ts`.
2. For each enabled source (all fetched in parallel), dispatch to a handler by `source.type` via
   the `HANDLERS` registry (`{ telegram: fetchTelegram, rss: fetchRss }`).
3. Filter fetched items against the lookback window and previously-seen IDs (dedup), sort newest
   first (undated items last), cap per-source. Cap semantics are "freshest-only": handlers stop
   fetching at the cap counting seen items too, so in-window items older than the newest
   `maxItems` are dropped by design and never surface in later runs.
4. Persist per-source `{ lastRunISO, seenIds }` to state (unless `includeSeen: true`), pruning
   entries for sources no longer present in the config.

**Adding a new source type**: create `lib/<type>.ts` exporting `(src: Source, ctx: Ctx) =>
Promise<Item[]>`, then add one line to the `HANDLERS` map in `lib/run.ts`. Individual sources are
never hardcoded — they live entirely in `sources.json`, keyed by `type` as a plain string (an
unknown type is a runtime error, not a compile error — see the note atop `lib/types.ts`).

**Config resolution** (`lib/config.ts`): `sources.json` is read fresh on every call (no caching,
no restart needed to pick up edits). Path resolution: `$NEWS_DIGEST_CONFIG` env var, else
`<repo>/sources.json`. `sources-template.json` is the checked-in template; the real
`sources.json` is gitignored (contains user's actual channel/feed URLs).

**State** (`lib/state.ts`): dedup state is stored *outside* the repo (so it survives a read-only
install) at `$NEWS_DIGEST_STATE`, or `$XDG_STATE_HOME/news-digest/state.json`, or
`~/.local/state/news-digest/state.json`. Keyed by source id; each entry keeps a bounded
(`dedupeKeepRecent`, cap 400), newest-first list of `seenIds`. `includeSeen: true` bypasses dedup
entirely and skips persisting state (one-off full pull).

**Source-specific handlers**:
- `lib/telegram.ts` scrapes the public `https://t.me/s/<channel>` HTML preview (no API/bot token
  needed). It paginates backwards via `?before=<message_id>`, stopping when it hits the item cap,
  leaves the lookback window, reaches `maxPages`, or makes no further progress (`oldestId` stalls).
  Media-only/service posts with no caption text are skipped.
- `lib/rss.ts` uses `fast-xml-parser` and handles RSS 2.0, RSS 1.0 (RDF), and Atom in one function
  by branching on which root key is present (`doc.rss.channel`, `doc.feed`, `doc['rdf:RDF']`).

**Shared utilities** (`lib/util.ts`): `stripHtml` (HTML → clean plain text, `<br>`/`<p>` become
newlines, script/style/noscript contents dropped), `truncate`, `asArray` (normalize XML's
single-item-vs-array ambiguity), `toISO`, and `fetchText` (fetch with a browser-like UA — some
sources vary output by UA — plus a timeout, `fetchTimeoutMs` in `sources.json` / default 15s, and
a 5 MB response cap; a slow or down source becomes a per-source error entry instead of stalling
the digest).

**Item identity**: every `Item.id` is namespaced by source type and source id (e.g.
`tg:<channel>/<msg_id>`, `rss:<source_id>:<guid>`) so ids are globally unique and stable across
runs for dedup purposes.

## Conventions

- 4-space indentation, single quotes, semicolons, 120-char line width (enforced by Biome, see
  `biome.json`).
- TypeScript strict mode with `noUncheckedIndexedAccess` — index access returns `T | undefined`.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`, bundler resolution).
