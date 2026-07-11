import { parse } from 'node-html-parser';
import type { Ctx, Item, Source } from './types.ts';
import { fetchText, stripHtml, truncate } from './util.ts';

/**
 * Scrape a public Telegram channel's server-rendered web preview
 * (`https://t.me/s/<channel>`) into {@link Item}s — no API or bot token needed.
 *
 * Paginates backwards via `?before=<message_id>`, stopping once it hits the item
 * cap, leaves the lookback window, reaches `maxPages`, or stops making progress.
 * Media-only/service posts with no caption text are skipped.
 */
export async function fetchTelegram(src: Source, ctx: Ctx): Promise<Item[]> {
    const maxPages = ctx.config.telegram?.maxPages ?? 5;
    const maxItems = src.maxItems ?? ctx.config.maxItemsPerSource ?? 40;
    const maxChars = ctx.config.maxCharsPerItem;

    const byId = new Map<string, Item>();
    let before: string | undefined;
    let prevOldestId: number | undefined;

    for (let page = 0; page < maxPages; page++) {
        const pageUrl = new URL(src.url);
        if (before) pageUrl.searchParams.set('before', before);

        const root = parse(await fetchText(pageUrl.toString(), ctx.config.fetchTimeoutMs));
        const nodes = root.querySelectorAll('.tgme_widget_message');
        if (nodes.length === 0) break;

        let oldestId = Infinity;
        let oldestDateMs = Infinity;

        for (const node of nodes) {
            const post = node.getAttribute('data-post'); // "channel/12345"
            if (!post) continue;

            const idNum = Number(post.split('/')[1]);
            if (Number.isFinite(idNum)) oldestId = Math.min(oldestId, idNum);

            const dt = node.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime') ?? null;
            const dateMs = dt ? Date.parse(dt) : NaN;
            if (Number.isFinite(dateMs)) oldestDateMs = Math.min(oldestDateMs, dateMs);

            const rawHtml = node.querySelector('.tgme_widget_message_text')?.innerHTML ?? '';
            let text = stripHtml(rawHtml);
            if (!text) continue; // skip media-only / service posts with no caption
            if (maxChars) text = truncate(text, maxChars);

            const id = `tg:${post}`;
            byId.set(id, {
                id,
                text,
                url: `https://t.me/${post}`,
                date: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
            });
        }

        // Stop conditions.
        if (byId.size >= maxItems) break;
        if (Number.isFinite(oldestDateMs) && oldestDateMs < ctx.windowStartMs) break;
        if (!Number.isFinite(oldestId)) break;
        if (prevOldestId !== undefined && oldestId >= prevOldestId) break; // no progress
        prevOldestId = oldestId;
        before = String(oldestId);
    }

    return [...byId.values()];
}
