// Slice one digest run into pages that each fit a character budget.
//
// Pure and I/O-free: give it a snapshotted run, a cursor and a budget, get back a page. The
// budget exists because MCP hosts cap how much a single tool result may return — osaurus, the
// host this server was built for, head/tail-truncates anything past 100,000 characters, which
// silently destroys the middle of a digest.
//
// Size is measured with `JSON.stringify().length`, i.e. UTF-16 code units. A host counting
// Unicode scalars or grapheme clusters (Swift's `String.count`) always arrives at a number no
// larger, so this measure over-estimates rather than under-estimates. Erring that way is the
// point: an over-estimate costs an extra page, an under-estimate costs the truncation this
// whole module exists to avoid.

import type { Digest, Payload } from './run.ts';
import type { Item, SourceResult } from './types.ts';

/** Default budget: comfortably under osaurus's 100k cap, with room for a host's own framing. */
export const DEFAULT_MAX_CHARS = 80_000;

/** A page has to hold at least one item plus the envelope; below this the budget is nonsense. */
export const MIN_MAX_CHARS = 4_000;

/** Never claim more than this, whatever the config says — the cap is the host's, not ours. */
export const MAX_MAX_CHARS = 95_000;

/** Position within a paged run. `index` is carried rather than derived — pages vary in size. */
export interface Cursor {
    runId: string;
    offset: number;
    index: number;
}

/** One item, plus which source it belongs to. The run flattened into paging order. */
interface Entry {
    sourceIndex: number;
    item: Item;
}

/** Clamp a requested budget into the range a page can actually be built for. */
export function clampMaxChars(requested: number | undefined): number {
    const n = requested ?? DEFAULT_MAX_CHARS;
    if (!Number.isFinite(n)) return DEFAULT_MAX_CHARS;
    return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(n)));
}

/** Serialize a cursor for the client to hand straight back. */
export function formatCursor(c: Cursor): string {
    return `${c.runId}:${c.offset}:${c.index}`;
}

/** Parse a cursor a client returned, or null if it isn't one this server minted. */
export function parseCursor(raw: string): Cursor | null {
    const m = /^([0-9a-z-]{1,64}):(\d{1,9}):(\d{1,6})$/.exec(raw.trim());
    if (!m?.[1]) return null;
    return { runId: m[1], offset: Number(m[2]), index: Number(m[3]) };
}

/** Every item in the run, in config-source order then feed order. Offsets index into this. */
function flatten(digest: Digest): Entry[] {
    const out: Entry[] = [];
    for (const [sourceIndex, source] of digest.sources.entries()) {
        for (const item of source.items) out.push({ sourceIndex, item });
    }
    return out;
}

/** Rebuild `sources` from a run of entries, keeping config order and dropping empty sources. */
function regroup(digest: Digest, entries: Entry[], withErrors: boolean): SourceResult[] {
    const out: SourceResult[] = [];
    for (const [i, source] of digest.sources.entries()) {
        const items = entries.filter((e) => e.sourceIndex === i).map((e) => e.item);
        // A failed source has no items to page, so its error rides on the first page only —
        // repeating it on every page would spend budget saying the same thing twice.
        if (items.length === 0 && !(withErrors && source.error)) continue;
        out.push({ ...source, items });
    }
    return out;
}

/** Assemble a page around an already-chosen set of entries. `chars` is settled by `finalize`. */
function build(digest: Digest, entries: Entry[], at: Cursor, total: number): Payload {
    const delivered = at.offset + entries.length;
    const remaining = Math.max(0, total - delivered);
    const nextCursor = remaining > 0 ? formatCursor({ ...at, offset: delivered, index: at.index + 1 }) : null;

    return {
        generatedAt: digest.generatedAt,
        lookbackHours: digest.lookbackHours,
        timezone: digest.timezone,
        stats: digest.stats,
        page: {
            runId: at.runId,
            index: at.index,
            itemsInPage: entries.length,
            itemsRemaining: remaining,
            chars: 0,
            nextCursor,
            nextAction: nextCursor
                ? `This is one page of ${total} items; ${remaining} remain. Call get_news again with ` +
                  `cursor="${nextCursor}" and no other arguments. Do not write anything until a page ` +
                  'comes back with nextCursor: null.'
                : 'Last page — the whole digest has now been delivered. Do not call get_news again.',
        },
        sources: regroup(digest, entries, at.offset === 0),
    };
}

/**
 * Return the page of `digest` starting at `at`, packed to at most `maxChars` characters of
 * serialized JSON.
 *
 * Greedy: items are taken in flattened order until the next one would not fit. A single item
 * larger than a whole page would otherwise stall paging forever, so it is emitted alone with
 * its body cut to fit and `truncated: true` set — a page always advances by at least one item.
 */
export function paginate(digest: Digest, at: Cursor, maxChars: number): Payload {
    const all = flatten(digest);
    const total = all.length;
    const start = Math.max(0, Math.min(at.offset, total));
    const from: Cursor = { ...at, offset: start };

    // Measure the envelope by building an empty page: the run fields, the page block, and any
    // source errors all spend budget before a single item is added.
    let used = measure(build(digest, [], from, total));

    const taken: Entry[] = [];
    for (const entry of all.slice(start)) {
        // +1 for the separating comma, plus the source's own wrapper the first time a page
        // opens that source.
        const wrapper = taken.some((e) => e.sourceIndex === entry.sourceIndex) ? 0 : sourceOverhead(digest, entry);
        const cost = JSON.stringify(entry.item).length + 1 + wrapper;

        if (used + cost > maxChars) {
            // First item of the page and it still doesn't fit: shrink it rather than stall.
            if (taken.length === 0) taken.push({ ...entry, item: fit(entry.item, maxChars - used - wrapper - 1) });
            break;
        }
        taken.push(entry);
        used += cost;
    }

    // The running total is an estimate — escaping and the exact envelope only settle on
    // serialization — so settle up for real and drop items until the page genuinely fits.
    let page = build(digest, taken, from, total);
    while (measure(page) > maxChars && taken.length > 1) {
        taken.pop();
        page = build(digest, taken, from, total);
    }
    return finalize(page);
}

/**
 * Fill in `page.chars` with the page's own serialized width.
 *
 * The number lives inside the object it describes, so writing it can change the width it
 * reports. Two passes settle that for any plausible page; `max` keeps the result an upper
 * bound, since a size that under-reports is the one failure mode that matters.
 */
function finalize(page: Payload): Payload {
    let chars = JSON.stringify(page).length;
    for (let i = 0; i < 2; i++) {
        chars = Math.max(chars, JSON.stringify({ ...page, page: { ...page.page, chars } }).length);
    }
    return { ...page, page: { ...page.page, chars } };
}

/** Serialized width of a page, counting the final `page.chars` value. */
function measure(page: Payload): number {
    return finalize(page).page.chars;
}

/** Cost of opening a source on a page: its `{id,name,type,items:[]}` wrapper, serialized. */
function sourceOverhead(digest: Digest, entry: Entry): number {
    const source = digest.sources[entry.sourceIndex];
    if (!source) return 0;
    return JSON.stringify({ ...source, items: [] }).length + 1;
}

/** Cut an item's body so the whole item serializes within `budget` characters. */
function fit(item: Item, budget: number): Item {
    const shrunk: Item = { ...item, truncated: true };
    // Everything but `text` is short and load-bearing (id, url, date), so the body gets
    // whatever is left once the rest of the item is accounted for.
    const room = budget - JSON.stringify({ ...shrunk, text: '' }).length;
    if (room <= 0) return { ...shrunk, text: '' };

    // Escaping can make one character cost several, so shrink until it actually fits.
    let text = item.text.slice(0, room);
    while (text.length > 0 && JSON.stringify({ ...shrunk, text }).length > budget) {
        text = text.slice(0, Math.floor(text.length * 0.9));
    }
    return { ...shrunk, text };
}
