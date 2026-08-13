# News Digest

A simple MCP server that fetches news from Telegram and RSS sources. Connect it to your LLM agent of choice and let it doomscroll for you!

## Setup

The server speaks MCP over stdio. Run it from a clone, or with `npx` from npm. Your choice decides
where the config lives.

The config is **JSONC** — regular JSON plus `//` comments and trailing commas. The template is
commented throughout, so it doubles as the reference for every option.

### With npx

npm fetches a prebuilt bundle from the registry, which installs two packages and needs
**Node ≥ 20.11**. CI builds and publishes it on every push to `main`.

With no checkout, the config has nowhere to sit beside the server, so put it in
`~/.config/news-digest/`:

```bash
mkdir -p ~/.config/news-digest
curl -fsSL https://raw.githubusercontent.com/goldjee/news-digest-mcp/main/sources-template.jsonc -o ~/.config/news-digest/sources.jsonc
```

Add your Telegram/RSS sources to that file, then register the server:

```json
{
  "mcpServers": {
    "news-digest": {
      "command": "npx",
      "args": ["-y", "@goldjee/news-digest-mcp@latest"]
    }
  }
}
```

Keep the `-y`. Without it, `npx` prompts on stdin before running a package it hasn't installed, and
stdin carries the MCP protocol, so the handshake hangs.

`@latest` is load-bearing, and a tarball URL is not a substitute for it. npm decides whether an
already-installed npx package can be reused by comparing the resolved URL as a *string* — not by
version, integrity, or content — so a fixed URL such as
`releases/latest/download/news-digest-mcp.tgz` resolves once, at first install, and never updates
again however many releases follow. `@latest` resolves to a versioned tarball whose URL moves on
each publish, which is what lets a new release actually arrive.

To pin a build instead, name the version: `@goldjee/news-digest-mcp@1.0.7`. To drop the per-start
resolution, install once with `npm i -g @goldjee/news-digest-mcp` and set
`"command": "news-digest-mcp"` with no args — then `npm update -g` is what moves you forward.

The artifact is JavaScript rather than TypeScript, because Node refuses to strip types anywhere
under `node_modules`. That also means Bun is not required: `bun` and `bunx` are for working from a
clone.

### From a clone

Runs on **Bun** (any recent version) or **Node ≥ 22.6** (≥ 23.6 runs TypeScript natively; 22.6–23.5
needs `--experimental-strip-types`). No build step either way.

```bash
git clone https://github.com/goldjee/news-digest-mcp.git
cd news-digest-mcp
bun install                               # or: npm install
cp sources-template.jsonc sources.jsonc   # then add your Telegram/RSS sources
```

Register it with the absolute path to the runtime (`which bun` / `which node`) — GUI apps on macOS
have a stripped PATH.

With Bun:

```json
{
  "mcpServers": {
    "news-digest": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/path/to/news-digest/src/server.ts"]
    }
  }
}
```

With Node (add `"--experimental-strip-types"` before the path on Node 22.6–23.5):

```json
{
  "mcpServers": {
    "news-digest": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/news-digest/src/server.ts"]
    }
  }
}
```

### Where the config is read from

The server checks beside its own files first, then `~/.config/news-digest/` (`$XDG_CONFIG_HOME` is
honoured), taking `sources.jsonc` or `sources.json` at either location. `$NEWS_DIGEST_CONFIG`
overrides both. A clone therefore behaves as it always has; an `npx` install has nothing writable
beside the code, since npm replaces that cache on every fetch, so it reads from `~/.config`. Miss
all three and the error names each path it tried. Some clients prefix tools, e.g.
`news-digest_get_news`.

## Tools

- **`get_news({ page?, lookbackHours?, includeSeen?, maxChars?, runId? })`** — fresh items in the window, one page at a time (see [Paging](#paging)). Returns only what's new since the last call (state in `~/.local/state/news-digest/`). `includeSeen: true` = full pull, no dedup, no state written.
- **`list_sources()`** — configured sources (for debugging).

Both tools declare an `outputSchema`, so a client can discover the response shape from `tools/list`
and validate against it. Each result carries the payload twice: as `structuredContent` (a real JSON
object) and as serialized JSON in a text block, which the spec asks for so clients that don't read
structured output still work.

```jsonc
{
    "content": [{ "type": "text", "text": "{\"generatedAt\":\"2026-07-30T…\",…}" }],
    "structuredContent": {
        "nextPageNeeded": true,
        "nextPage": 2,
        "generatedAt": "2026-07-30T21:44:03.118Z",
        "lookbackHours": 24,
        "timezone": "Europe/London",
        "stats": { "sources": 5, "newItems": 33, "duplicates": 52, "errors": 1 },
        "page": {
            "pageNumber": 1,
            "totalPages": 2,
            "itemsInPage": 16,
            "itemsRemaining": 17,
            "chars": 79923,
            "runId": "2026-07-30t21-44-03-118z-l09e16",
            "nextAction": "Call get_news with page=2. 17 of 33 items still to come — …"
        },
        "sources": [
            {
                "id": "bbc-uk-rss",
                "name": "BBC UK",
                "type": "rss",
                "items": [
                    {
                        "id": "rss:bbc-uk-rss:https://www.bbc.co.uk/news/articles/c78gnj1qqyyo#0",
                        "title": "…",
                        "text": "…",
                        "url": "https://www.bbc.co.uk/news/articles/c78gnj1qqyyo",
                        "date": "2026-07-30T18:12:00.000Z",
                        "textSource": "article"
                    }
                ]
            },
            // a source that failed keeps its entry, with `error` set and `items` empty
            { "id": "…", "name": "…", "type": "rss", "items": [], "error": "HTTP 404 Not Found for …" }
        ]
    }
}
```

`list_sources` returns `{ "sources": [...] }` rather than a bare array — `structuredContent` has to
be a JSON object, and the text block carries the identical value.

### `hostEnvelope`

One host needs the text block shaped differently. osaurus ignores `structuredContent` and reads
only `content`, then re-encodes anything that isn't one of its own envelopes into `result.text` —
as a JSON *string*, so every `"` in the payload becomes `\"`. That fourth encoding is what reaches
the model, nothing unescapes it, and models imitate it: give one 80 kB of escaped JSON and it
starts writing escaped prose back at you.

Set `"hostEnvelope": "osaurus"` in `sources.jsonc` and the text block becomes
`{"ok":true,"tool":"get_news","result":{…}}`, which that host passes through byte-identical. The
default `"none"` is the spec shape — the serialized payload, nothing added — and is what any other
client should get. `structuredContent` is the same either way. Measured on a real 5-page digest:
~880 escaped quotes per page under `"none"`, ~450 under `"osaurus"`, and the ones left are real
quotes inside article text.

## Duplicates across feeds

Several feeds from one outlet carry the same articles. Measured on a live run, BBC's world, UK and
front-page feeds shared 60% of their items: 86 items, 33 unique URLs, with 20 articles appearing in
all three and each copy fetching its own full body.

So an article is returned once, under the **first source in config order** that carried it. The
others are listed on it as `alsoIn`:

```jsonc
{ "id": "rss:bbc-world-rss:…", "title": "…", "url": "https://www.bbc.co.uk/news/articles/…",
  "alsoIn": ["bbc-uk-rss", "bbc-uk-front-page-rss"] }
```

Keeping that list matters: three outlets leading with a story says something about its size, and
the raw duplication was the only place that showed. `stats.duplicates` counts the copies dropped.

Config order decides attribution, and the digest prints the winning source's name — so if you want
UK stories credited to your UK feed rather than a world feed that also carries them, put the UK
feed first.

Dedup runs before full-text extraction, so a story three feeds carry costs one article download
instead of three. On the run above that was 33 fetches instead of 86, and the payload went from
~427,000 characters to ~43,000.

## Paging

MCP hosts cap how much a single tool call may return. osaurus head/tail-truncates anything past
100,000 characters, which quietly removes the middle of a digest — and since the run's ids were
already marked seen, those stories never come back. A digest with full article text clears that
cap easily: five feeds at 15 kB an article is ~180 kB.

So `get_news` returns **one page at a time**, in the shape
[Sequential Thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking)
uses for the same "keep calling me" problem — a boolean to loop on and an integer to pass back,
no opaque token to transcribe:

1. Call it with no arguments. It fetches every source once, snapshots the whole run, and returns
   page 1.
2. While the result says `"nextPageNeeded": true`, call `get_news` again with **only**
   `page` set to the result's `nextPage`. Those calls read the snapshot — no network, no config
   reload, no state written — and return in milliseconds.
3. `"nextPageNeeded": false` means the digest is complete.

`nextPageNeeded` and `nextPage` are the first two keys in the response, so a model reading the
serialized text meets the loop condition before the 80 kB of news. `page.totalPages` says up
front how many calls it will take, and `page.nextAction` repeats the next step in plain words —
small local models follow an imperative sentence more reliably than a schema.

The fetch happens once, on the first call, and that is load-bearing rather than an optimisation:
`get_news` marks the whole run as seen when it snapshots, so a second *run* would correctly
report the rest of the digest as old news and return nothing. Paging over a snapshot is what
makes "read the whole feed" survive being split across calls. A bare `page` continues the most
recent run, which is what a paging loop always means; `runId` can pin a specific one, but you
should not need it.

Sizing is per page, by measured JSON length, not by item count — a page holds as many items as
fit. `maxCharsPerCall` in `sources.jsonc` sets the budget (default 80000, clamped to
4000–95000); `maxChars` overrides it for one call. Prefer few large pages: hosts summarise older
tool results as a conversation grows, so a long paging loop risks losing the early pages.

An item too large for a whole page is returned alone with its body cut to fit and
`"truncated": true` set, so paging always advances. Snapshots live beside the dedup state and
are kept for 24 hours (10 runs max); asking for a page when no snapshot survives returns an
error telling you to start a fresh run.

## Sources

Edit `sources.jsonc` — re-read on every call, no restart. A source is `{ id, name, type, url }` (`type`: `telegram` | `rss`). A new type = a `src/lib/<type>.ts` plus one line in `HANDLERS` (`src/lib/run.ts`).

## Full article text

Feeds usually ship a one-line teaser. Add `"fullText": true` to a source and the server follows each
item's link and replaces the body with the article itself, extracted by Firefox's reader-mode
algorithm ([@mozilla/readability](https://github.com/mozilla/readability)). It scores the page's DOM
by text density, so it works site-agnostically — there are no per-domain rules to maintain.

Enriched items carry `"textSource": "article"`; items whose page couldn't be read keep the feed text
and say `"textSource": "feed"`. Extraction never fails a source. Article bodies obey the same
`maxCharsPerItem` cap as everything else, so consider lowering `maxItems` on enriched sources — 25
items × 4000 chars is ~100 kB for the agent to read.

Optional tuning, all with sane defaults:

```jsonc
"fullText": { "concurrency": 4, "timeoutMs": 15000, "minChars": 200, "charThreshold": 500 }
```

`concurrency` is article pages fetched at once per source, `minChars` rejects extractions too short
to be worth taking, and `charThreshold` is Readability's own give-up length.

What you won't get: JavaScript-rendered articles, hard paywalls and consent walls yield the feed text
rather than an error, and feeds that link through a redirector (Google News and friends) rarely
resolve to a readable page.

## Without an agent

Call it from code: `import { runDigest } from "./src/lib/run.ts"`.

## Read entry store

The history of read news entries is stored in `~/.local/state/news-digest/state.json`.
