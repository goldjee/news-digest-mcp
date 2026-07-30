// Zod schemas for everything the MCP tools return. These are the single source of truth
// for the output shape: `lib/types.ts` and `lib/run.ts` infer their types from here, and
// `server.ts` publishes them as each tool's `outputSchema`.
//
// Two consequences worth knowing before editing:
//   1. `.describe()` text is not a comment — it ends up in the JSON Schema advertised by
//      `tools/list`, so clients and the model read it. Write it for them.
//   2. The SDK validates `structuredContent` against these on every call, so a schema that
//      drifts from the payload fails the tool call outright instead of degrading. Adding a
//      field to a payload means adding it here too.
//
// Config *input* types (Source, Config, Ctx) deliberately stay plain interfaces in types.ts:
// lib/config.ts validates those by hand so it can report every error with its `line:col`.

import { z } from 'zod';

/** A single normalized news item from any source. */
export const ItemSchema = z.object({
    id: z.string().describe('Globally unique, stable across runs (for dedup).'),
    title: z.string().optional().describe('Item title; present for RSS, usually absent for Telegram.'),
    text: z.string().describe('Plain-text body (HTML stripped, possibly truncated).'),
    url: z.string().describe('Canonical link to the item, with tracking params stripped.'),
    date: z.string().nullable().describe('ISO 8601 timestamp, or null if the source gave no usable date.'),
    textSource: z
        .enum(['feed', 'article'])
        .optional()
        .describe(
            'Where `text` came from. Only set on sources with fullText: true — "article" when ' +
                'reader-mode extraction succeeded, "feed" when it did not and the original body was kept.',
        ),
});

/** Result for one source within a digest payload. */
export const SourceResultSchema = z.object({
    id: z.string().describe('The source id from sources.jsonc.'),
    name: z.string().describe('Human label for the source.'),
    type: z.string().describe('Handler type, e.g. "telegram" or "rss".'),
    items: z.array(ItemSchema).describe('Fresh items for this source; empty if it errored.'),
    error: z.string().optional().describe('Present instead of items when the source failed.'),
});

// Exported as a raw shape as well as an object: `registerTool` takes the shape, while
// the assembled object is what validates a payload in tests and at the call site.
export const payloadShape = {
    generatedAt: z.string().describe('ISO timestamp of when this run started.'),
    lookbackHours: z.number().describe('Effective lookback window used for this run, in hours.'),
    timezone: z.string().nullable().describe('Display timezone from config, or null if unset.'),
    stats: z
        .object({
            sources: z.number(),
            newItems: z.number(),
            errors: z.number(),
        })
        .describe('Roll-up counts across all sources.'),
    sources: z.array(SourceResultSchema).describe('Per-source items (or an error) in config order.'),
};

/** Structured digest returned by `get_news`. */
export const PayloadSchema = z.object(payloadShape);

/** One entry of the `list_sources` result. */
export const SourceInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string(),
    enabled: z.boolean().describe('False when the source is present but disabled in sources.jsonc.'),
});

// `structuredContent` must be a JSON object, so the source list is wrapped rather than
// returned as a bare top-level array.
export const listSourcesShape = {
    sources: z.array(SourceInfoSchema).describe('Every configured source, enabled and disabled alike.'),
};

/** Structured result returned by `list_sources`. */
export const ListSourcesResultSchema = z.object(listSourcesShape);
