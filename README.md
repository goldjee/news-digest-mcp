# News Digest

A simple MCP server that fetches news from Telegram and RSS sources. Connect it to your LLM agent of choice and let it doomscroll for you!

## Setup

Runs on **Bun** (any recent version) or **Node ≥ 22.6** (≥ 23.6 runs TypeScript natively; 22.6–23.5 needs `--experimental-strip-types`). No build step either way.

Clone this repository somewhere you find convenient, then install dependencies and copy the template config:

```bash
cd /path/to/news-digest
bun install                             # or: npm install
cp sources-template.jsonc sources.jsonc   # then add your Telegram/RSS sources
```

The config is **JSONC** — regular JSON plus `//` comments and trailing commas. The template is
commented throughout, so it doubles as the reference for every option.

## Register with your MCP client

The server speaks MCP over stdio. Use the absolute path to the runtime (`which bun` / `which node`) — GUI apps on macOS have a stripped PATH.

With Bun:

```json
{
  "mcpServers": {
    "news-digest": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/path/to/news-digest/server.ts"]
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
      "args": ["/path/to/news-digest/server.ts"]
    }
  }
}
```

`sources.jsonc` is resolved relative to the server files, falling back to `sources.json` if that's what you already have (override either with `$NEWS_DIGEST_CONFIG`). Some clients prefix tools, e.g. `news-digest_get_news`.

## Tools

- **`get_news({ lookbackHours?, includeSeen? })`** — fresh items in the window. Returns only what's new since the last call (state in `~/.local/state/news-digest/`). `includeSeen: true` = full pull, no dedup, no state written.
- **`list_sources()`** — configured sources (for debugging).

Both tools declare an `outputSchema`, so a client can discover the response shape from `tools/list`
and validate against it. Each result carries the payload twice: as `structuredContent` (a real JSON
object) and as serialized JSON in a text block, which the spec asks for so clients that don't read
structured output still work.

```jsonc
{
    "content": [{ "type": "text", "text": "{\"generatedAt\":\"2026-07-30T…\",…}" }],
    "structuredContent": {
        "generatedAt": "2026-07-30T21:44:03.118Z",
        "lookbackHours": 24,
        "timezone": "Europe/London",
        "stats": { "sources": 5, "newItems": 33, "errors": 1 },
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

## Sources

Edit `sources.jsonc` — re-read on every call, no restart. A source is `{ id, name, type, url }` (`type`: `telegram` | `rss`). A new type = a `lib/<type>.ts` plus one line in `HANDLERS` (`lib/run.ts`).

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

Call it from code: `import { runDigest } from "./lib/run.ts"`.

## Read entry store

The history of read news entries is stored in `~/.local/state/news-digest/state.json`.
