# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio transport) that aggregates news from Telegram channel previews and RSS/Atom
feeds into structured JSON. It's designed to be launched by a host agent (e.g. osaurus) as
`bun src/server.ts` on the host machine directly — no sandbox — so it has network access and a
writable filesystem for state.

## Commands

```bash
bun install               # install deps
bun run lint              # bunx biome lint
bun run format            # bunx biome format
bun run check             # bunx biome check (lint + format + organize imports)
bun run build             # bundle to dist/server.js (what CI publishes; not needed to develop)
bun src/server.ts         # run the MCP server directly (reads stdio)
```

There is no test suite. Biome is the only linter/formatter; a lefthook pre-commit hook runs
`bun run check --write` on staged JS/TS/JSON/CSS files and re-stages fixes automatically.

To smoke-test the server manually, pipe JSON-RPC messages into it over stdio (see README.md for
the exact `initialize` / `tools/call` sequence).

## Architecture

**Entry point**: `src/server.ts` registers two MCP tools (`get_news`, `list_sources`) and delegates
all logic to `src/lib/run.ts`. The server itself is just wiring — no business logic lives here. Both
tools publish an `outputSchema` and return the payload as `structuredContent` *and* as serialized
JSON in a text block (the spec's backwards-compatibility path for clients that read only `content`).
`list_sources` wraps its list as `{ sources: [...] }` because `structuredContent` must be a JSON
object, not a bare array. Note that the `content` text block is not merely a fallback: osaurus,
the host this was built for, reads *only* `content` and ignores `structuredContent` entirely, so
that block is what a host's per-call output cap gets measured against — which is why `get_news`
pages (below), and why its exact shape is configurable (`src/lib/envelope.ts`).

**Text-block shape** (`src/lib/envelope.ts`, `hostEnvelope` in the config): default `'none'` serializes
the payload, which is the spec's SHOULD. `'osaurus'` wraps it as `{ok, tool, result}` because that
host re-encodes any non-envelope result into `result.text` *as a string* — escaping every quote in
80 kB, which is what the model then reads and imitates. Its own
`ToolResultNormalizationTests.existingSuccessEnvelopePassesThroughUntouched` is the contract being
relied on; `isSuccess` only asks for a leading `{` and `"ok":true`. The error path matters for the
same reason: osaurus never inspects `isError`, so an unshaped failure reaches the model labelled
`ok:true`. Keep the two shapes in step — a success envelope with a bare error string is a
half-measure. The wrapper's cost comes out of the paging budget in `getNews`, so `maxChars` keeps
meaning "characters the host counts" in either mode.

**Output shapes** (`src/lib/schema.ts`): zod schemas are the single source of truth for everything the
tools return. `Item` and `SourceResult` (`src/lib/types.ts`) and `Digest` / `Payload` (`src/lib/run.ts`) are
`z.infer`red from them, so there is one definition, not two that can drift. (`Digest` is one whole
run — what gets snapshotted; `Payload` is that plus a `page` block — what a tool call returns.) Two things follow.
Field docs go in `.describe()`, not JSDoc — that text is published in the JSON Schema that
`tools/list` advertises, so clients and the model actually read it, whereas JSDoc is erased at build
time. And the SDK validates `structuredContent` against these schemas on *every* call, so a payload
field added without a matching schema field fails the tool call outright rather than degrading —
edit the schema, not the interface. Config *input* types (`Source`, `Config`, `Ctx`) stay plain
interfaces: `src/lib/config.ts` validates those by hand so it can report each error's `line:col`.

One correction rides on top of that conversion. The SDK announces the schemas it derives from zod
as JSON Schema **draft-07** and takes no dialect option (`zod-to-json-schema` hardcodes it; the zod
v4 branch is pinned to draft-7 too, unchanged as of SDK 1.30.0), while Claude Desktop compiles
`outputSchema` with a validator that knows 2020-12 only — so it rejects both tools before a
`tools/call` ever reaches this process. `src/lib/dialect.ts` rewrites that one `$schema` key at the
transport, since the conversion happens inside an SDK request handler `McpServer` does not expose.
The rewrite is only honest because nothing here serializes to a construct the two dialects read
differently — no `definitions`/`$defs`/`$ref`, no tuple-form `items` — and the release workflow's
smoke test asserts exactly that, so adding e.g. a `z.tuple()` fails the release rather than
shipping a schema that lies about itself.

**Paging** (`src/lib/run.ts::getNews` → `src/lib/snapshot.ts` + `src/lib/paginate.ts`): `get_news` returns one
*page* of a run, not the whole thing, because MCP hosts cap tool output — osaurus head/tail-truncates
past 100,000 chars (`ToolOutputCaps.universalResult`), and a `fullText` digest runs ~180 kB. A call
without a `page` runs `runDigest`, snapshots the result under a `runId`, and returns page 1; a call
*with* one replays that snapshot (the most recent, unless `runId` pins another). The snapshot is not
a cache optimisation — `runDigest` marks the whole run seen when it persists state, so re-running
would correctly find the rest of the digest already seen and return nothing. Paging over a frozen
run is the only way "deliver everything" and "dedup across runs" can both hold.

The wire shape deliberately copies Sequential Thinking MCP's `nextThoughtNeeded`/`thoughtNumber`/
`totalThoughts`: a boolean to loop on, integers to pass back, nothing opaque. That is not
cosmetic — the target host runs a 12B local model, and the opaque-cursor version it replaced was
reliably ignored after page 1. `nextPageNeeded` and `nextPage` are emitted as the first two keys
(key order in `paginate.ts::build` is load-bearing, since `JSON.stringify` preserves insertion
order and the model reads the serialized text). Anything that makes the loop condition harder to
find or harder to copy is a regression, however much tidier it looks.

`paginate.ts` plans every page boundary before building the requested one, which is what makes
`totalPages` knowable; both halves call the same `packFrom`, and a single conservative
`envelopeReserve` is used by both, so plan and page agree by construction rather than by staying
in step. Pages are sized by measured `JSON.stringify().length` (a safe over-estimate of the
grapheme count a Swift host measures), budget from `maxCharsPerCall` / the `maxChars` argument.
Two invariants worth keeping: a page always advances by at least one item (an item too big for a
page is cut to fit and marked `truncated`), and source-level `error` entries ride on page 1 only.

**Core flow** (`src/lib/run.ts::runDigest`, wrapped by `getNews`):
1. Load `sources.jsonc` via `src/lib/config.ts`.
2. For each enabled source (all fetched in parallel), dispatch to a handler by `source.type` via
   the `HANDLERS` registry (`{ telegram: fetchTelegram, rss: fetchRss }`).
3. Filter fetched items against the lookback window and previously-seen IDs (dedup), sort newest
   first (undated items last), cap per-source. Cap semantics are "freshest-only": handlers stop
   fetching at the cap counting seen items too, so in-window items older than the newest
   `maxItems` are dropped by design and never surface in later runs.
4. Drop items another source already returned (`dedupeAcrossSources`), keyed on `Item.url`.
5. For sources with `fullText: true`, replace item bodies with the article text via
   `src/lib/extract.ts`. Runs last — after the window/seen filters so dead and stale links are never
   fetched, and after dedup so a story three feeds carry costs one download, not three.
6. Persist per-source `{ lastRunISO, seenIds }` to state (unless `includeSeen: true`), pruning
   entries for sources no longer present in the config.
7. Back in `getNews`, snapshot the finished run and return its first page (see **Paging** above).

**Cross-source dedup** (`src/lib/run.ts::dedupeAcrossSources`): feeds from one outlet overlap hard —
BBC's world, UK and front-page feeds were measured sharing 60% of their items, each copy carrying
its own separately-fetched article body, which is what pushed a run to 6 pages and past the
model's context. Keyed on `Item.url` (already normalized by `cleanUrl` at assignment); no further
stripping, since the duplicates are byte-identical and trimming a query could merge two real
pages. First source in config order wins, so **reordering `sources` is how you choose which feed
a shared story is credited to** — the digest prints that source's name.

Two things not to break. Dedup must stay *before* enrichment, or the saving evaporates. And
`freshIds` is captured *before* dedup on purpose, so every copy is marked seen, not just the
survivor: mark only the winner and the next run filters it out as already-seen, promotes a
duplicate to sole survivor, and re-delivers the same story under a different source.

**Adding a new source type**: create `src/lib/<type>.ts` exporting `(src: Source, ctx: Ctx) =>
Promise<Item[]>`, then add one line to the `HANDLERS` map in `src/lib/run.ts`. Individual sources are
never hardcoded — they live entirely in `sources.jsonc`, keyed by `type` as a plain string (an
unknown type is a runtime error, not a compile error — see the note atop `src/lib/types.ts`).

**Config resolution** (`src/lib/config.ts`): the config is **JSONC** (JSON + `//` and `/* */` comments
+ trailing commas), parsed with `jsonc-parser`; both config files carry inline comments documenting
each option, so the template is the option reference. It's read fresh on every call (no caching, no
restart needed to pick up edits) — that hot-reload is load-bearing, so don't add a module-level
cache. Path resolution: `$NEWS_DIGEST_CONFIG` env var, else the first of `sources.jsonc`,
`sources.json` that exists — first beside the server files, then under
`$XDG_CONFIG_HOME/news-digest/` (default `~/.config/news-digest/`). The `.json` name is a
compatibility fallback for older installs and is still parsed as JSONC. The install dir is checked
*before* XDG so a checkout behaves exactly as it always has; the XDG location exists because
`npx github:goldjee/news-digest-mcp` (how the Claude Code plugin launches this — see
`.claude-plugin/plugin.json`) runs the server from a package cache, where nothing writable sits
beside the code and the whole tree is replaced on every fetch. It mirrors what `src/lib/state.ts`
already does for state. When nothing is found the error names every location checked, since which
one you're meant to create depends on how the server was launched.
`sources-template.jsonc` is the checked-in template; the real
`sources.jsonc` is gitignored (contains user's actual channel/feed URLs). A parse failure throws
with every error's `line:col`, failing the whole tool call rather than silently serving stale config.

**State** (`src/lib/state.ts`): dedup state is stored *outside* the repo (so it survives a read-only
install) at `$NEWS_DIGEST_STATE`, or `$XDG_STATE_HOME/news-digest/state.json`, or
`~/.local/state/news-digest/state.json`. Keyed by source id; each entry keeps a bounded
(`dedupeKeepRecent`, cap 400), newest-first list of `seenIds`. `includeSeen: true` bypasses dedup
entirely and skips persisting state (one-off full pull). Run snapshots (`src/lib/snapshot.ts`) live in
`runs/` beside it, resolved via the exported `stateDir()` so `$NEWS_DIGEST_STATE` still moves
everything at once; they're disposable (24h / 10 runs), and a missing one is a cache miss that asks
the caller for a fresh run, never an error.

**Source-specific handlers**:
- `src/lib/telegram.ts` scrapes the public `https://t.me/s/<channel>` HTML preview (no API/bot token
  needed). It paginates backwards via `?before=<message_id>`, stopping when it hits the item cap,
  leaves the lookback window, reaches `maxPages`, or makes no further progress (`oldestId` stalls).
  `maxPages` resolves per-source first (`src.maxPages`), then the global `telegram.maxPages`, then 5
  — the same override chain as `maxItems`. Media-only/service posts with no caption text are skipped.
- `src/lib/rss.ts` uses `fast-xml-parser` and handles RSS 2.0, RSS 1.0 (RDF), and Atom in one function
  by branching on which root key is present (`doc.rss.channel`, `doc.feed`, `doc['rdf:RDF']`).
  Item links run through `cleanUrl` at the point they're assigned, so `Item.url` and the
  `guid || link` id fallback see the same tracking-free string. A feed's own `<guid>` is never
  rewritten — it's an opaque identity token, and touching it would invalidate persisted `seenIds`.

**Full-text enrichment** (`src/lib/extract.ts`): opt-in per source (`fullText: true`), source-type
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

**Shared utilities** (`src/lib/util.ts`): `stripHtml` (HTML → clean plain text, `<br>`/`<p>` become
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

**Layout**: source lives under `src/` — `src/server.ts` plus `src/lib/*.ts`. Nothing imports across
a parent boundary, so the tree moves as a unit. The one thing that *is* depth-sensitive is
`installDir()` in `src/lib/config.ts`, which is why it walks up to the nearest `package.json`
instead of counting `..` hops; see the comment there before changing it.

**Distribution** (`.github/workflows/release.yml`, `.claude-plugin/plugin.json`): every push to
`main` bundles `src/server.ts` to a single `dist/server.js`, packs it, and publishes
`@goldjee/news-digest-mcp` to the npm registry, archiving the same tarball on a `build-<sha>` GitHub
release. The Claude Code plugin launches `npx -y @goldjee/news-digest-mcp@latest`. Developing is
unaffected: `bun src/server.ts` still runs the TypeScript, and `dist/` is gitignored.

**The registry is the install contract, and the spec form is load-bearing.** npm decides whether an
already-installed npx package can be reused by comparing `node.package.resolved` against the
manifest's `_resolved` — string equality on the resolved URL, not version, integrity, or content
(`libnpmexec`'s `missingFromTree`; `getManifest` hardcodes `preferOnline: true`, so it is already
online and no flag reaches this). A fixed `releases/latest/download/…tgz` URL therefore resolves
once, at first install, and **never updates again** — this repo shipped a corrected build that no
running client ever fetched. Unchanged in npm 12. `@latest` resolves to a versioned tarball whose
URL moves on each publish, which is the whole reason for the registry. Do not "simplify" the plugin
back to a URL.

Four things here are load-bearing. The artifact must be **JavaScript**: Node refuses to strip types
for anything under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a package
shipping raw `.ts` cannot run however it is installed — which is what this pipeline exists to fix.
`jsonc-parser` must stay `--external`: it has no `exports` map, so bun resolves its UMD `main`, whose
wrapper does `require('./impl/format')` at runtime and dies once inlined. It is consequently the only
entry in `dependencies` — everything else bundles and lives in `devDependencies`, so an install
fetches 2 packages rather than 129, and the workflow greps the bundle for leftover relative requires
to catch the next dependency that pulls the same trick. And the release is **gated on a smoke test
that installs the tarball and drives the installed binary** over stdio, not on `dist/server.js`
directly — the failure being guarded against only appears from under `node_modules`.

`package.json` is the published manifest (no generated one any more). `files: ["dist"]` is what keeps
`src/`, the configs and the tooling out of the tarball — prefer extending that allowlist over adding
an `.npmignore`, since `files` wins over `.npmignore` and having both hides which is in force.
`prepack` runs the build, so `npm pack`/`npm publish` can never ship a stale `dist/`. CI sets the
version to `1.0.<run_number>` before packing, which npm requires to be distinct on every publish.
Adding `bin` means `npm i github:goldjee/news-digest-mcp` now advertises an entry point that isn't
built — git installs are unsupported by design; use the registry.

Publishing is **trusted publishing (OIDC)**: the workflow's `id-token: write` permission is what npm
authenticates, so there is no `NPM_TOKEN` secret to store or rotate (npm removed non-expiring tokens
in November 2025), and provenance is attached automatically. `--access public` is required because
the package is scoped. The trusted publisher is registered per package on npmjs.com against this
repo and the `release.yml` filename — **renaming that workflow file breaks publishing** until the
registration is updated.

## Conventions

- 4-space indentation, single quotes, semicolons, 120-char line width (enforced by Biome, see
  `biome.json`).
- TypeScript strict mode with `noUncheckedIndexedAccess` — index access returns `T | undefined`.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`, bundler resolution).
