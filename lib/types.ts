// Shared types. Note: `type` is a plain string so an unknown source type in
// sources.jsonc becomes a friendly runtime error instead of a compile error.
//
// Config *input* types are declared here as interfaces; the *output* types (Item,
// SourceResult) are inferred from the zod schemas in lib/schema.ts, which the MCP
// tools also publish as their `outputSchema`. Edit the shape there, not here.

import type { z } from 'zod';
import type { ItemSchema, SourceResultSchema } from './schema.ts';

/** One configured news source, as declared in `sources.jsonc`. */
export interface Source {
    /** Stable, unique id — used as the state/dedup key. */
    id: string;
    /** Human label shown in the digest. */
    name: string;
    /** Handler selector: `"telegram"`, `"rss"`, or a future type. */
    type: string;
    /** Feed or channel URL to fetch. */
    url: string;
    /** Whether to include this source; defaults to `true`. */
    enabled?: boolean;
    /** Per-source item cap (overrides the top-level `maxItemsPerSource` in {@link Config}). */
    maxItems?: number;
    /**
     * Telegram only: how many `?before=` pages to walk back for this channel
     * (overrides the top-level `telegram.maxPages` in {@link Config}). Ignored by other types.
     */
    maxPages?: number;
    /**
     * Follow each item's `url` and replace its body with the extracted article text
     * (reader mode). Defaults to `false`. Extraction failures keep the original text.
     */
    fullText?: boolean;
}

/** Top-level shape of `sources.jsonc`. */
export interface Config {
    /** Only consider items newer than `now - lookbackHours`. */
    lookbackHours: number;
    /** Default per-source item cap. */
    maxItemsPerSource?: number;
    /** Truncate long item bodies to this many chars (token control). */
    maxCharsPerItem?: number;
    /**
     * Max characters of serialized JSON one `get_news` call may return (default 80000).
     * Anything beyond it is delivered on the next page. Exists because MCP hosts cap tool
     * output — osaurus truncates past 100000 — so keep this comfortably under the host's limit.
     */
    maxCharsPerCall?: number;
    /** Per-request fetch timeout in ms (default 15000). */
    fetchTimeoutMs?: number;
    /**
     * Telegram-specific tuning: default number of `?before=` pages to walk back
     * (a source can override it with its own `maxPages`).
     */
    telegram?: { maxPages?: number };
    /** Tuning for sources with `fullText: true`. */
    fullText?: {
        /** Article pages fetched at once per source (default 4). */
        concurrency?: number;
        /** Per-article fetch timeout in ms (default: `fetchTimeoutMs`). */
        timeoutMs?: number;
        /** Reject extractions shorter than this many chars (default 200). */
        minChars?: number;
        /** Readability's own minimum article length before it gives up (default 500). */
        charThreshold?: number;
    };
    /**
     * Shape of the `content` text block. `"none"` (default) serializes the payload as-is, which
     * is what the MCP spec asks for. `"osaurus"` wraps it in that host's success envelope —
     * without it, osaurus re-encodes our JSON into a string field and the model reads every
     * quote as `\"`. See `lib/envelope.ts`.
     */
    hostEnvelope?: 'none' | 'osaurus';
    /** Display timezone, passed through to the digest. */
    timezone?: string;
    /** The configured sources. */
    sources: Source[];
}

/** A single normalized news item from any source. Shape lives in {@link ItemSchema}. */
export type Item = z.infer<typeof ItemSchema>;

/** Per-run context threaded through every source handler. */
export interface Ctx {
    /** `Date.now()` captured at the start of the run. */
    now: number;
    /** Lower bound of the lookback window (`now - lookbackHours`), in ms. */
    windowStartMs: number;
    /** The loaded config. */
    config: Config;
}

/** Result for one source within a digest payload. Shape lives in {@link SourceResultSchema}. */
export type SourceResult = z.infer<typeof SourceResultSchema>;
