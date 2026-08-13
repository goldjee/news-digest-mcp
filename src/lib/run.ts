import type { z } from 'zod';
import { loadConfig } from './config.ts';
import { envelopeOverhead } from './envelope.ts';
import { enrichWithArticleText } from './extract.ts';
import { clampMaxChars, paginate } from './paginate.ts';
import { fetchRss } from './rss.ts';
import type { DigestSchema, PayloadSchema } from './schema.ts';
import { latestRunId, loadSnapshot, saveSnapshot } from './snapshot.ts';
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

    /**
     * Fetch one source and cut it down to the items this run should return — window, dedup
     * against previous runs, newest first, per-source cap. Deliberately stops short of
     * `fullText` enrichment: cross-source duplicates have to be dropped first, or the same
     * article gets downloaded once per feed that carries it.
     */
    const fetchSource = async (src: Source): Promise<{ result: SourceResult; freshIds: string[] }> => {
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

            return {
                result: { id: src.id, name: src.name, type: src.type, items: fresh },
                // Every fresh id, including copies dedup is about to drop — see below.
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

    // fetchSource never rejects (errors become per-source entries), so Promise.all is safe
    // and preserves config order.
    const enabled = config.sources.filter((s) => s.enabled !== false);
    const outcomes = await Promise.all(enabled.map(fetchSource));
    const results = outcomes.map((o) => o.result);

    const duplicates = dedupeAcrossSources(results);

    // Enrichment runs last, over survivors only: after the window and seen-id filters so dead
    // and stale links are never fetched, and after dedup so a story three feeds carry costs one
    // article download instead of three.
    await Promise.all(
        enabled.map(async (src, i) => {
            const result = results[i];
            if (!src.fullText || !result || result.error) return;
            result.items = await enrichWithArticleText(result.items, ctx);
        }),
    );

    if (persist) {
        // `freshIds` was captured before dedup, so every copy of a shared article is marked seen
        // under its own source — not just the one that survived. Marking only the survivor would
        // mean the next run filtered the winner out as already-seen, promoted a duplicate to sole
        // survivor, and re-delivered the same story under a different source.
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
            duplicates,
            errors: results.filter((r) => r.error).length,
        },
        sources: results,
    };
}

/**
 * Drop items that another source already carried, mutating `results` in place. Returns how many
 * copies went.
 *
 * Feeds from one outlet overlap heavily — BBC's world, UK and front-page feeds shared 60% of
 * their items in practice, each copy carrying its own separately-fetched article body. Keyed on
 * `Item.url`, which `cleanUrl` normalized when the handler assigned it; the duplicates are
 * byte-identical, so no further stripping, which could merge two genuinely different pages.
 *
 * First source in config order wins, so reordering `sources` is how you choose which feed a
 * shared story is credited to. The losers are recorded on the survivor as `alsoIn` — several
 * outlets leading with a story says something about its size, and that signal would otherwise
 * disappear along with the duplicates.
 */
function dedupeAcrossSources(results: SourceResult[]): number {
    const owner = new Map<string, Item>();
    let dropped = 0;

    for (const result of results) {
        const kept: Item[] = [];
        for (const item of result.items) {
            // No url, nothing to key on — a handler that omits it gets left alone rather than
            // having every such item collapse into one.
            if (!item.url) {
                kept.push(item);
                continue;
            }
            const first = owner.get(item.url);
            if (!first) {
                owner.set(item.url, item);
                kept.push(item);
                continue;
            }
            first.alsoIn = [...(first.alsoIn ?? []), result.id];
            dropped++;
        }
        result.items = kept;
    }
    return dropped;
}

/** Per-call options for {@link getNews}. */
export interface GetNewsOptions extends RunOptions {
    /** Page to return, counting from 1. Omit to start a fresh run and get page 1. */
    page?: number;
    /** Pin a specific snapshotted run. Omit to page the most recent one, which is the norm. */
    runId?: string;
    /** Max characters of serialized JSON this page may occupy. See `lib/paginate.ts`. */
    maxChars?: number;
}

/**
 * Return one page of a digest.
 *
 * With no `page` this runs a fresh digest ({@link runDigest} — fetch, filter, dedup, enrich,
 * persist state), snapshots the whole run, and returns page 1. With one, it serves that page
 * straight from the snapshot: no network, no config reload, no state write. Fetching once and
 * paging over the frozen result is what keeps dedup honest — a second *run* would legitimately
 * consider the rest of the digest already seen and return nothing.
 */
export async function getNews(opts: GetNewsOptions = {}): Promise<Payload> {
    // The budget is what the *host* will count, so the text block's envelope (if any) comes out
    // of it — otherwise `maxChars` would quietly mean something different in each mode.
    const maxChars = clampMaxChars(opts.maxChars ?? loadConfig().maxCharsPerCall) - envelopeOverhead('get_news');

    if (opts.page === undefined) {
        const digest = await runDigest(opts);
        return paginate(digest, saveSnapshot(digest), 1, maxChars);
    }

    const runId = opts.runId ?? latestRunId();
    const digest = runId ? loadSnapshot(runId) : null;
    if (!runId || !digest) {
        throw new Error(
            `No stored run to take page ${opts.page} from${opts.runId ? ` (asked for "${opts.runId}")` : ''}. ` +
                'Snapshots are kept for 24h. Call get_news with no arguments to start a fresh run.',
        );
    }
    return paginate(digest, runId, opts.page, maxChars);
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
