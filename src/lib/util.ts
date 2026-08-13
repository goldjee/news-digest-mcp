import { parse } from 'node-html-parser';

/** Convert an HTML fragment to clean plain text (entities decoded, <br>/<p> -> newlines). */
export function stripHtml(input: string | undefined | null): string {
    if (!input) return '';
    const withBreaks = String(input)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n');
    const root = parse(withBreaks);
    // .text includes the raw contents of block-text elements — drop them explicitly.
    for (const node of root.querySelectorAll('script,style,noscript')) node.remove();
    return root.text
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Clamp a string to at most `max` chars, appending an ellipsis when it's cut. */
export function truncate(s: string, max?: number): string {
    if (!max || s.length <= max) return s;
    return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Normalize a single value or array (or missing) into an array. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

/** Parse any date-ish string to ISO 8601, or null if unparseable. */
export function toISO(dateLike: string | undefined | null): string | null {
    if (!dateLike) return null;
    const t = Date.parse(String(dateLike));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Query-param name prefixes that exist only for analytics. Matched case-insensitively:
 * trackers ship as both `CMP` and `cmp`, and no meaningful param differs from these by case alone.
 */
const TRACKING_PREFIXES = [
    'utm_',
    'at_',
    'ns_',
    'pk_',
    'mtm_',
    'piwik_',
    'mc_',
    'hsa_',
    'vero_',
    'oly_',
    'stm_',
    '_hs',
];

/**
 * Exact param names to drop. Names like `ref`, `source`, `from`, `si`, `partner` and `campaign`
 * are deliberately absent — they're tracking on some sites and load-bearing routing on others,
 * and serving a broken link is worse than serving a tagged one.
 */
const TRACKING_PARAMS = new Set([
    // ad-click ids
    'fbclid',
    'gclid',
    'gbraid',
    'wbraid',
    'dclid',
    'msclkid',
    'yclid',
    'twclid',
    'ttclid',
    'li_fat_id',
    'epik',
    'rb_clickid',
    's_kwcid',
    'ef_id',
    // social / analytics session ids
    'igshid',
    'igsh',
    'mibextid',
    'xtor',
    '_openstat',
    '_ga',
    '_gl',
    // publisher campaign ids
    'cmp',
    'cmpid',
    'icid',
    'ito',
    'ncid',
    'smid',
    'smtyp',
    'sr_share',
    'mkt_tok',
    'trk',
    'trkcampaign',
    'spm',
    'scm',
    // yahoo consent handoff
    'guccounter',
    'guce_referrer',
    'guce_referrer_sig',
]);

/**
 * Strip analytics query params from a link, leaving the rest of the URL byte-identical.
 * Total by design — an empty, relative or malformed link is returned as-is rather than
 * throwing, since one bad item must not take down the whole source.
 */
export function cleanUrl(url: string): string {
    if (!url) return url;
    try {
        const u = new URL(url);
        let removed = false;
        // Snapshot the keys first — deleting during live iteration skips entries.
        for (const name of [...u.searchParams.keys()]) {
            const n = name.toLowerCase();
            if (!TRACKING_PARAMS.has(n) && !TRACKING_PREFIXES.some((p) => n.startsWith(p))) continue;
            u.searchParams.delete(name);
            removed = true;
        }
        // Only re-serialize when something actually went: URL.toString() lowercases the host
        // and re-encodes the path, so rewriting an already-clean link buys nothing and risks
        // changing a URL we were asked to leave alone.
        return removed ? u.toString() : url;
    } catch {
        return url;
    }
}

/** Hard ceiling on response bodies — feeds/previews are well under 1 MB. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** GET a URL with a browser-like UA (some sources vary output by UA), returning the raw bytes. */
async function fetchBytes(url: string, timeoutMs: number): Promise<{ res: Response; bytes: Uint8Array }> {
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'user-agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                'accept-language': 'en,ru;q=0.8',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        if (!res.body) return { res, bytes: new Uint8Array() };

        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of res.body) {
            total += chunk.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB for ${url}`);
            }
            chunks.push(chunk);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { res, bytes };
    } catch (e) {
        if (e instanceof DOMException && e.name === 'TimeoutError') {
            throw new Error(`Timeout after ${timeoutMs / 1000}s for ${url}`);
        }
        throw e;
    }
}

/** GET a URL as UTF-8 text. */
export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
    const { bytes } = await fetchBytes(url, timeoutMs);
    return new TextDecoder().decode(bytes);
}

/** A fetched web page, decoded and with the metadata an extractor needs. */
export interface Page {
    html: string;
    /** URL after redirects — feeds often link through trackers. */
    finalUrl: string;
    /** Raw `content-type` header, so callers can skip non-HTML responses. */
    contentType: string;
}

/**
 * GET a URL as an HTML {@link Page}. Unlike {@link fetchText} this honours the page's
 * declared charset — arbitrary article pages are far likelier than feeds to be
 * windows-1251 or latin-1, and mojibake in the digest is worse than no text at all.
 */
export async function fetchPage(url: string, timeoutMs = 15_000): Promise<Page> {
    const { res, bytes } = await fetchBytes(url, timeoutMs);
    const contentType = res.headers.get('content-type') ?? '';
    return { html: decodeHtml(bytes, contentType), finalUrl: res.url || url, contentType };
}

/** Decode a page body: charset from the Content-Type header, else a `<meta charset>` sniff, else UTF-8. */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
    const label = /charset=["']?\s*([\w-]+)/i.exec(contentType)?.[1] ?? sniffCharset(bytes);
    if (label) {
        try {
            // Bun types the label as a fixed union; a page can declare any encoding, valid or not.
            return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
        } catch {
            // Unknown/unsupported label — fall through to UTF-8.
        }
    }
    return new TextDecoder().decode(bytes);
}

/** Look for a declared charset in the document head (spec requires it in the first 1024 bytes). */
function sniffCharset(bytes: Uint8Array): string | undefined {
    // Decoding as UTF-8 may mangle high bytes, but the declaration itself is always ASCII.
    const head = new TextDecoder().decode(bytes.subarray(0, 2048));
    return /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
}

/** Map over `items` with at most `limit` calls in flight, preserving input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    // One shared iterator: every worker pulls the next index as it frees up.
    const queue = items.entries();
    const worker = async () => {
        for (const [i, item] of queue) out[i] = await fn(item);
    };
    const workers = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
}
