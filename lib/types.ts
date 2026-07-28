// Shared types. Note: `type` is a plain string so an unknown source type in
// sources.jsonc becomes a friendly runtime error instead of a compile error.

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
    /** Per-request fetch timeout in ms (default 15000). */
    fetchTimeoutMs?: number;
    /** Telegram-specific tuning: how many `?before=` pages to walk back. */
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
    /** Display timezone, passed through to the digest. */
    timezone?: string;
    /** The configured sources. */
    sources: Source[];
}

/** A single normalized news item from any source. */
export interface Item {
    /** Globally unique, stable across runs (for dedup). */
    id: string;
    /** Item title; present for RSS, usually absent for Telegram. */
    title?: string;
    /** Plain-text body (HTML stripped, possibly truncated). */
    text: string;
    /** Canonical link to the item. */
    url: string;
    /** ISO 8601 timestamp, or `null` if the source gave no usable date. */
    date: string | null;
    /**
     * Where {@link Item.text} came from. Only set on sources with `fullText: true`
     * — `'article'` when reader-mode extraction succeeded, `'feed'` when it didn't
     * and the original body was kept.
     */
    textSource?: 'feed' | 'article';
}

/** Per-run context threaded through every source handler. */
export interface Ctx {
    /** `Date.now()` captured at the start of the run. */
    now: number;
    /** Lower bound of the lookback window (`now - lookbackHours`), in ms. */
    windowStartMs: number;
    /** The loaded config. */
    config: Config;
}

/** Result for one source within a digest {@link Payload}. */
export interface SourceResult {
    id: string;
    name: string;
    type: string;
    /** Fresh items for this source (empty if it errored). */
    items: Item[];
    /** Set instead of `items` when the source failed. */
    error?: string;
}
