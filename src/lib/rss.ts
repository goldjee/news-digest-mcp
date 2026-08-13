import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { Ctx, Item, Source } from './types.ts';
import { asArray, cleanUrl, fetchText, stripHtml, toISO, truncate } from './util.ts';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function textOf(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (isRecord(v) && '#text' in v) return String(v['#text'] ?? '');
    return '';
}

function atomLink(entry: Record<string, unknown>): string {
    const links = asArray<unknown>(entry.link);
    const alt = links.find((l) => isRecord(l) && l['@_rel'] === 'alternate') ?? links[0];
    if (!alt) return '';
    if (typeof alt === 'string') return alt;
    return isRecord(alt) ? String(alt['@_href'] ?? '') : '';
}

/**
 * Fetch and parse a feed into {@link Item}s, auto-detecting the format
 * (RSS 2.0, RSS 1.0/RDF, or Atom) from the document root.
 *
 * Item bodies are stripped of HTML and truncated to `maxCharsPerItem`; the
 * result is capped at `maxItems` (source override, else config, else 40).
 */
export async function fetchRss(src: Source, ctx: Ctx): Promise<Item[]> {
    const maxItems = src.maxItems ?? ctx.config.maxItemsPerSource ?? 40;
    const maxChars = ctx.config.maxCharsPerItem;

    const doc = parser.parse(await fetchText(src.url, ctx.config.fetchTimeoutMs));

    let raw: unknown[] = [];
    let kind: 'rss' | 'atom' = 'rss';
    if (doc?.rss?.channel) raw = asArray(doc.rss.channel.item);
    else if (doc?.feed) {
        raw = asArray(doc.feed.entry);
        kind = 'atom';
    } else if (doc?.['rdf:RDF']) raw = asArray(doc['rdf:RDF'].item);

    const items: Item[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const it = entry;
        let title: string;
        let link: string;
        let desc: string;
        let dateSrc: string;
        let guid: string;

        // Links are cleaned here, at the assignment, so that both `url` and the `guid || link`
        // id fallback below see the same tracking-free string. A guid of its own is left alone —
        // it's an opaque identity token, and rewriting it would invalidate persisted seenIds.
        if (kind === 'atom') {
            title = textOf(it.title);
            link = cleanUrl(atomLink(it));
            desc = textOf(it.summary) || textOf(it.content);
            dateSrc = textOf(it.updated) || textOf(it.published);
            guid = textOf(it.id) || link;
        } else {
            title = textOf(it.title);
            link = cleanUrl(textOf(it.link));
            desc = textOf(it.description) || textOf(it['content:encoded']);
            dateSrc = textOf(it.pubDate) || textOf(it['dc:date']);
            guid = textOf(it.guid) || link || title;
        }

        let text = stripHtml(desc);
        if (maxChars) text = truncate(text, maxChars);

        // Some feeds omit guid/link/title entirely — fall back to a content hash so ids stay distinct.
        const key = guid || link || title || createHash('sha1').update(text).digest('hex').slice(0, 12);
        items.push({
            id: `rss:${src.id}:${key}`,
            title: stripHtml(title) || undefined,
            text,
            url: link,
            date: toISO(dateSrc),
        });
        if (items.length >= maxItems) break;
    }
    return items;
}
