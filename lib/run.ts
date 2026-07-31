import type { z } from 'zod';
import { loadConfig } from './config.ts';
import { enrichWithArticleText } from './extract.ts';
import { type Cursor, clampMaxChars, paginate, parseCursor } from './paginate.ts';
import { fetchRss } from './rss.ts';
import type { DigestSchema, PayloadSchema } from './schema.ts';
import { loadSnapshot, saveSnapshot } from './snapshot.ts';
import { dedupeKeepRecent, loadState, saveState } from './state.ts';
import { fetchTelegram } from './telegram.ts';
import type { Ctx, Item, Source, SourceResult } from './types.ts';

/**
 * Handler registry. New source *type* = new lib/<type>.ts + one line here.
 * Individual sources are never hardcoded — they live in sources.jsonc.
 */
const HANDLERS: Record<string, (src: Source, ctx: Ctx) => Promise<Item[]>> = {
    telegram: fetchTelegram,
    rss: fetchRss,
};

function ts(iso: string | null, fallback: number): number {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : fallback;
}

/** Per-call options for {@link runDigest}. */
export interface RunOptions {
    /** Override `sources.jsonc` `lookbackHours` for this call. */
    lookbackHours?: number;
    /** `true` = skip since-last-run dedup and do NOT persist state (one-off full pull). */
    includeSeen?: boolean;
}

/** One whole digest run, as returned by {@link runDigest}. Shape lives in {@link DigestSchema}. */
export type Digest = z.infer<typeof DigestSchema>;

/** One page of a digest, as returned by {@link getNews}. Shape lives in {@link PayloadSchema}. */
export type Payload = z.infer<typeof PayloadSchema>;

/**
 * Run one digest pass: for every enabled source (fetched in parallel), fetch via
 * its type handler, filter to the lookback window and drop previously-seen ids,
 * sort newest-first, cap per source, and — for sources with `fullText: true` — replace
 * item bodies with the extracted article text. Persists dedup state unless `includeSeen`
 * is set. A failing or unknown-type source yields an error entry rather than
 * aborting the run.
 *
 * Cap semantics are "freshest-only": handlers stop fetching at the cap counting
 * previously-seen items too, so in-window items older than the newest `maxItems`
 * are dropped by design and never surface in later runs. The `.slice()` below only
 * trims Telegram page overshoot.
 */
export async function runDigest(opts: RunOptions = {}): Promise<Digest> {
    const config = loadConfig();
    const lookbackHours = opts.lookbackHours ?? config.lookbackHours ?? 24;
    const now = Date.now();
    const windowStartMs = now - lookbackHours * 3_600_000;
    const ctx: Ctx = { now, windowStartMs, config };

    const persist = !opts.includeSeen;
    const state = persist ? loadState() : {};

    const runSource = async (src: Source): Promise<{ result: SourceResult; freshIds: string[] }> => {
        const handler = HANDLERS[src.type];
        if (!handler) {
            return {
                result: {
                    id: src.id,
                    name: src.name,
                    type: src.type,
                    items: [],
                    error: `Unknown source type "${src.type}". Known types: ${Object.keys(HANDLERS).join(', ')}`,
                },
                freshIds: [],
            };
        }

        try {
            const fetched = await handler(src, ctx);
            const prevSeen = new Set(opts.includeSeen ? [] : (state[src.id]?.seenIds ?? []));

            const fresh = fetched
                .filter((it) => {
                    if (prevSeen.has(it.id)) return false;
                    return ts(it.date, now) >= windowStartMs;
                })
                // Fallback 0: undated items pass the window but must not outrank dated news.
                .sort((a, b) => ts(b.date, 0) - ts(a.date, 0))
                .slice(0, src.maxItems ?? config.maxItemsPerSource ?? 40);

            // Runs after filtering, so article pages are fetched only for items actually
            // returned — never for ones already seen in an earlier run.
            const items = src.fullText ? await enrichWithArticleText(fresh, ctx) : fresh;

            return {
                result: { id: src.id, name: src.name, type: src.type, items },
                freshIds: fresh.map((i) => i.id),
            };
        } catch (err) {
            return {
                result: {
                    id: src.id,
                    name: src.name,
                    type: src.type,
                    items: [],
                    error: err instanceof Error ? err.message : String(err),
                },
                freshIds: [],
            };
        }
    };

    // runSource never rejects (errors become per-source entries), so Promise.all is safe
    // and preserves config order.
    const enabled = config.sources.filter((s) => s.enabled !== false);
    const outcomes = await Promise.all(enabled.map(runSource));
    const results = outcomes.map((o) => o.result);

    if (persist) {
        for (const [i, src] of enabled.entries()) {
            const outcome = outcomes[i];
            if (!outcome || outcome.result.error) continue;
            state[src.id] = {
                lastRunISO: new Date(now).toISOString(),
                seenIds: dedupeKeepRecent([...outcome.freshIds, ...(state[src.id]?.seenIds ?? [])], 400),
            };
        }
        // Prune entries for sources removed from the config (disabled ones are kept so
        // a temporarily disabled source doesn't re-flood when re-enabled).
        const knownIds = new Set(config.sources.map((s) => s.id));
        for (const id of Object.keys(state)) {
            if (!knownIds.has(id)) delete state[id];
        }
        saveState(state);
    }

    return {
        generatedAt: new Date(now).toISOString(),
        lookbackHours,
        timezone: config.timezone ?? null,
        stats: {
            sources: results.length,
            newItems: results.reduce((n, r) => n + r.items.length, 0),
            errors: results.filter((r) => r.error).length,
        },
        sources: results,
    };
}

/** Per-call options for {@link getNews}. */
export interface GetNewsOptions extends RunOptions {
    /** `page.nextCursor` from a previous call. Serves the next page from that run's snapshot. */
    cursor?: string;
    /** Max characters of serialized JSON this page may occupy. See `lib/paginate.ts`. */
    maxChars?: number;
}

/**
 * Return one page of a digest.
 *
 * Without a `cursor` this runs a fresh digest ({@link runDigest} — fetch, filter, dedup,
 * enrich, persist state), snapshots the whole run, and returns its first page. With one, it
 * serves the next page straight from that snapshot: no network, no config reload, no state
 * write. Fetching once and paging over the result is what keeps dedup honest — a second run
 * would legitimately consider the rest of the digest already seen.
 */
export async function getNews(opts: GetNewsOptions = {}): Promise<Payload> {
    const maxChars = clampMaxChars(opts.maxChars ?? loadConfig().maxCharsPerCall);

    let at: Cursor;
    let digest: Digest;

    if (opts.cursor) {
        const parsed = parseCursor(opts.cursor);
        if (!parsed) {
            throw new Error(
                `Not a cursor this server issued: "${opts.cursor}". Pass page.nextCursor exactly as ` +
                    'it was given, or call get_news with no cursor to start a fresh run.',
            );
        }
        const snapshot = loadSnapshot(parsed.runId);
        if (!snapshot) {
            throw new Error(
                `Run "${parsed.runId}" is no longer available (snapshots are kept for 24h). Call ` +
                    'get_news with no cursor to start a fresh run.',
            );
        }
        at = parsed;
        digest = snapshot;
    } else {
        digest = await runDigest(opts);
        at = { runId: saveSnapshot(digest), offset: 0, index: 0 };
    }

    return paginate(digest, at, maxChars);
}

/** List all configured sources (enabled and disabled) for inspection/debugging. */
export function listSources() {
    const config = loadConfig();
    return config.sources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        url: s.url,
        enabled: s.enabled !== false,
    }));
}
