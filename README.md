# News Digest

A simple MCP server that fetches news from Telegram and RSS sources. Connect it to your LLM agent of choice and let it doomscroll for you!

## Setup

Runs on **Bun** (any recent version) or **Node ≥ 22.6** (≥ 23.6 runs TypeScript natively; 22.6–23.5 needs `--experimental-strip-types`). No build step either way.

Clone this repository somewhere you find convenient, then install dependencies and copy the template config:

```bash
cd /path/to/news-digest
bun install                             # or: npm install
cp sources-template.json sources.json   # then add your Telegram/RSS sources
```

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

`sources.json` is resolved relative to the server files (override with `$NEWS_DIGEST_CONFIG`). Some clients prefix tools, e.g. `news-digest_get_news`.

## Tools

- **`get_news({ lookbackHours?, includeSeen? })`** — fresh items in the window. Returns only what's new since the last call (state in `~/.local/state/news-digest/`). `includeSeen: true` = full pull, no dedup, no state written.
- **`list_sources()`** — configured sources (for debugging).

## Sources

Edit `sources.json` — re-read on every call, no restart. A source is `{ id, name, type, url }` (`type`: `telegram` | `rss`). A new type = a `lib/<type>.ts` plus one line in `HANDLERS` (`lib/run.ts`).

## Without an agent

Call it from code: `import { runDigest } from "./lib/run.ts"`.

## Read entry store

The history of read news entries is stored in `~/.local/state/news-digest/state.json`.
