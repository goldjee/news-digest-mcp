// Slice one digest run into pages that each fit a character budget.
//
// Pure and I/O-free: give it a snapshotted run, a page number and a budget, get back that page.
// The budget exists because MCP hosts cap how much a single tool result may return — osaurus,
// the host this server was built for, head/tail-truncates anything past 100,000 characters,
// which silently destroys the middle of a digest.
//
// Size is measured with `JSON.stringify().length`, i.e. UTF-16 code units. A host counting
// Unicode scalars or grapheme clusters (Swift's `String.count`) always arrives at a number no
// larger, so this measure over-estimates rather than under-estimates. Erring that way is the
// point: an over-estimate costs an extra page, an under-estimate costs the truncation this
// whole module exists to avoid.
//
// Shape of the work: plan every page boundary first, then build the one that was asked for.
// Planning is what makes `totalPages` knowable — "page 1 of 3" is the difference between a
// model knowing it is unfinished and guessing — and both halves run the same packer, so the
// plan and the built page agree by construction rather than by two routines staying in step.

import type { Digest, Payload } from './run.ts';
import type { Item, SourceResult } from './types.ts';

/** Default budget: comfortably under osaurus's 100k cap, with room for a host's own framing. */
export const DEFAULT_MAX_CHARS = 80_000;

/** A page has to hold at least one item plus the envelope; below this the budget is nonsense. */
export const MIN_MAX_CHARS = 4_000;

/** Never claim more than this, whatever the config says — the cap is the host's, not ours. */
export const MAX_MAX_CHARS = 95_000;

/** Slack on the envelope reserve, covering digit drift in the page block's own numbers. */
const RESERVE_SLACK = 64;

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

/** Every item in the run, in config-source order then feed order. Offsets index into this. */
function flatten(digest: Digest): Entry[] {
    const out: Entry[] = [];
    for (const [sourceIndex, source] of digest.sources.entries()) {
        for (const item of source.items) out.push({ sourceIndex, item });
    }
    return out;
}

/** How many pages this run splits into at `maxChars`, and where each one starts. */
export function planPages(digest: Digest, maxChars: number): number[] {
    const all = flatten(digest);
    const reserve = envelopeReserve(digest, all.length, maxChars);
    const starts: number[] = [];

    let offset = 0;
    do {
        starts.push(offset);
        const taken = packFrom(digest, all, offset, reserve, maxChars);
        // packFrom always takes at least one item once there are any, so this terminates.
        offset += Math.max(1, taken.length);
    } while (offset < all.length);

    return starts;
}

/**
 * Return page `pageNumber` (1-based) of `digest`, packed to at most `maxChars` characters of
 * serialized JSON. A page number past the end yields the last page.
 */
export function paginate(digest: Digest, runId: string, pageNumber: number, maxChars: number): Payload {
    const all = flatten(digest);
    const starts = planPages(digest, maxChars);
    const index = Math.min(Math.max(1, Math.floor(pageNumber)), starts.length) - 1;
    const offset = starts[index] ?? 0;
    const reserve = envelopeReserve(digest, all.length, maxChars);

    const taken = packFrom(digest, all, offset, reserve, maxChars);
    return finalize(build(digest, taken, { runId, offset, index, total: all.length, totalPages: starts.length }));
}

/**
 * Take as many items from `offset` as fit the budget once `reserve` is set aside.
 *
 * A single item larger than a whole page would otherwise stall paging forever, so it is
 * emitted alone with its body cut to fit and `truncated: true` set — a page always advances
 * by at least one item.
 */
function packFrom(digest: Digest, all: Entry[], offset: number, reserve: number, maxChars: number): Entry[] {
    const taken: Entry[] = [];
    let used = reserve;

    for (const entry of all.slice(offset)) {
        // +1 for the separating comma, plus the source's own wrapper the first time a page
        // opens that source.
        const wrapper = taken.some((e) => e.sourceIndex === entry.sourceIndex) ? 0 : sourceOverhead(digest, entry);
        const cost = JSON.stringify(entry.item).length + 1 + wrapper;

        if (used + cost > maxChars) {
            if (taken.length === 0) taken.push({ ...entry, item: fit(entry.item, maxChars - used - wrapper - 1) });
            break;
        }
        taken.push(entry);
        used += cost;
    }
    return taken;
}

/** Everything a page costs before its first item: the run fields, the page block, page-1 errors. */
function envelopeReserve(digest: Digest, total: number, maxChars: number): number {
    // Built with worst-case values throughout — the widest numbers, the longer `nextAction`
    // variant, and the error sources that ride on page 1 — so one reserve is an upper bound
    // for every page of the run. Over-reserving costs a few dozen characters out of 80,000;
    // under-reserving costs the truncation this module exists to prevent.
    const worst = build(digest, [], {
        runId: 'x'.repeat(48),
        offset: 0,
        index: 0,
        total,
        totalPages: Math.max(1, total),
    });
    worst.page.chars = maxChars;
    worst.page.itemsRemaining = total;
    return JSON.stringify(worst).length + RESERVE_SLACK;
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

/** Where a page sits, as `build` needs it. Distinct from the published `page` block. */
interface Position {
    runId: string;
    /** Item offset this page starts at. */
    offset: number;
    /** 0-based page index; `pageNumber` is this plus one. */
    index: number;
    /** Items in the whole run. */
    total: number;
    totalPages: number;
}

/** Assemble a page around an already-chosen set of entries. `chars` is settled by `finalize`. */
function build(digest: Digest, entries: Entry[], at: Position): Payload {
    const remaining = Math.max(0, at.total - (at.offset + entries.length));
    const more = remaining > 0;
    const nextPage = more ? at.index + 2 : null;

    // Key order is load-bearing: JSON.stringify emits these in insertion order, so a model
    // reading the serialized result meets the loop condition before the 80kB of news.
    return {
        nextPageNeeded: more,
        nextPage,
        generatedAt: digest.generatedAt,
        lookbackHours: digest.lookbackHours,
        timezone: digest.timezone,
        stats: digest.stats,
        page: {
            pageNumber: at.index + 1,
            totalPages: at.totalPages,
            itemsInPage: entries.length,
            itemsRemaining: remaining,
            chars: 0,
            runId: at.runId,
            nextAction: more
                ? `Call get_news with page=${nextPage}. ${remaining} of ${at.total} items still to come — ` +
                  'do not write anything until you have them all.'
                : 'Last page — you now have the whole digest. Do not call get_news again.',
        },
        sources: regroup(digest, entries, at.offset === 0),
    };
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
